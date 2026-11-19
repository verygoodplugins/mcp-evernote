/**
 * One shared request queue in front of every Evernote API call.
 *
 * Evernote's rate limit is a per-token hourly call quota. A queue cannot raise
 * it; what it does is stop independent callers from compounding retries
 * against the same quota. Every NoteStore/UserStore RPC goes through one
 * process-wide queue (stdio and HTTP alike) that provides:
 *
 * - **Concurrency limit**: at most `maxConcurrency` RPCs in flight.
 * - **Pacing**: at least `minIntervalMs` between consecutive dispatches.
 * - **Shared backoff**: when any RPC hits RATE_LIMIT_REACHED (errorCode 19)
 *   with a positive `rateLimitDuration`, the whole queue pauses for that long.
 *   - Short waits (≤ `rateLimitAutoRetrySeconds`): queued and new calls wait,
 *     and the queue re-dispatches the failed call once, at the front. The retry
 *     belongs to the queue, so callers never run their own retry timers.
 *   - Long waits: the failed call, every queued call, and new calls fail fast
 *     with a rate-limit error carrying the remaining seconds, so callers
 *     (and HTTP requests) don't hang for half an hour.
 *   errorCode 19 without a duration is Evernote's edit lock, not a quota
 *   signal; it passes through untouched (updateNote retries it itself).
 * - **Metrics**: depth, in-flight, wait times, backoff state.
 */

import { getEvernoteErrorMeta, RATE_LIMIT_ERROR_CODE } from "./errors.js";

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS = 15;
export const DEFAULT_MIN_REQUEST_INTERVAL_MS = 0;

export interface RequestQueueOptions {
  /** Max simultaneous in-flight RPCs. */
  maxConcurrency: number;
  /**
   * Shared backoff at or below this many seconds makes callers wait and the
   * queue retry the failed call once. Longer backoffs fail fast. 0 means every
   * backoff fails fast.
   */
  rateLimitAutoRetrySeconds: number;
  /** Minimum gap between consecutive dispatches, in ms. 0 disables pacing. */
  minIntervalMs?: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface RequestQueueMetrics {
  /** Calls waiting for a dispatch slot. */
  queued: number;
  /** Calls currently executing against Evernote. */
  inFlight: number;
  /** Highest `queued` value seen. */
  peakQueued: number;
  maxConcurrency: number;
  minIntervalMs: number;
  /** RPC attempts started (queue retries count again). */
  dispatched: number;
  succeeded: number;
  failed: number;
  /** RATE_LIMIT_REACHED errors with a duration seen from Evernote. */
  rateLimitHits: number;
  /** Calls the queue re-dispatched after a short shared backoff. */
  queueRetries: number;
  /** Calls rejected without reaching Evernote because a long backoff was active. */
  rejectedDuringBackoff: number;
  /** Time from enqueue to first dispatch. */
  waitMs: { last: number; max: number; avg: number };
  backoff: {
    active: boolean;
    /** "wait" = callers queue up; "fail-fast" = callers get a rate-limit error. */
    mode: "wait" | "fail-fast" | null;
    until: string | null;
    remainingSeconds: number;
  };
}

/**
 * Raised for calls rejected locally while a long shared backoff is active.
 * Shaped like an EDAM error (`errorCode` + `rateLimitDuration`) so the existing
 * error plumbing (`buildToolErrorPayload`, batch abort) reports it as
 * `rate_limited` with `retryAfterSeconds`.
 */
export class RateLimitBackoffError extends Error {
  readonly errorCode = RATE_LIMIT_ERROR_CODE;
  readonly rateLimitDuration: number;

  constructor(remainingSeconds: number) {
    super(
      `Evernote rate limit reached; shared backoff active for ${remainingSeconds}s more. ` +
        `Retry after ${remainingSeconds}s.`,
    );
    this.name = "RateLimitBackoffError";
    this.rateLimitDuration = remainingSeconds;
  }
}

interface QueuedTask {
  invoke: () => Promise<unknown>;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  enqueuedAt: number;
  attempts: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A pending backoff/pacing timer must not keep an idle process alive.
    timer.unref?.();
  });
}

function resolveInt(value: number | undefined, fallback: number, min: number) {
  const resolved = Math.floor(value ?? fallback);
  return Number.isFinite(resolved) ? Math.max(min, resolved) : fallback;
}

/** Extract a positive rate-limit window (seconds) from an error, if any. */
function rateLimitSeconds(error: unknown): number | null {
  const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
  if (
    errorCode === RATE_LIMIT_ERROR_CODE &&
    typeof rateLimitDuration === "number" &&
    Number.isFinite(rateLimitDuration) &&
    rateLimitDuration > 0
  ) {
    return rateLimitDuration;
  }
  return null;
}

export class EvernoteRequestQueue {
  readonly maxConcurrency: number;
  readonly rateLimitAutoRetrySeconds: number;
  readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private readonly pending: QueuedTask[] = [];
  private inFlight = 0;

  // Shared backoff state.
  private pausedUntil = 0;
  private pauseMode: "wait" | "fail-fast" | null = null;
  // Bumped on every new pause so a stale sleep can't end a newer pause.
  private pauseGeneration = 0;

  // Pacing state.
  private nextDispatchAt = 0;
  private pacingTimerPending = false;
  private pacingReady = false;

  // Metrics.
  private peakQueued = 0;
  private dispatched = 0;
  private succeeded = 0;
  private failed = 0;
  private rateLimitHits = 0;
  private queueRetries = 0;
  private rejectedDuringBackoff = 0;
  private waitSamples = 0;
  private waitTotalMs = 0;
  private lastWaitMs = 0;
  private maxWaitMs = 0;

  constructor(options: Partial<RequestQueueOptions> = {}) {
    this.maxConcurrency = resolveInt(
      options.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      1,
    );
    this.rateLimitAutoRetrySeconds = resolveInt(
      options.rateLimitAutoRetrySeconds,
      DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS,
      0,
    );
    this.minIntervalMs = resolveInt(
      options.minIntervalMs,
      DEFAULT_MIN_REQUEST_INTERVAL_MS,
      0,
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  /** Run `invoke` through the queue. Resolves/rejects with its result. */
  run<T>(invoke: () => Promise<T>): Promise<T> {
    this.expireFailFastPause();
    if (this.pauseMode === "fail-fast") {
      this.rejectedDuringBackoff++;
      return Promise.reject(new RateLimitBackoffError(this.remainingSeconds()));
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        invoke,
        resolve,
        reject,
        enqueuedAt: this.now(),
        attempts: 0,
      });
      this.peakQueued = Math.max(this.peakQueued, this.pending.length);
      this.pump();
    });
  }

  getMetrics(): RequestQueueMetrics {
    this.expireFailFastPause();
    const active = this.pauseMode !== null;
    return {
      queued: this.pending.length,
      inFlight: this.inFlight,
      peakQueued: this.peakQueued,
      maxConcurrency: this.maxConcurrency,
      minIntervalMs: this.minIntervalMs,
      dispatched: this.dispatched,
      succeeded: this.succeeded,
      failed: this.failed,
      rateLimitHits: this.rateLimitHits,
      queueRetries: this.queueRetries,
      rejectedDuringBackoff: this.rejectedDuringBackoff,
      waitMs: {
        last: this.lastWaitMs,
        max: this.maxWaitMs,
        avg:
          this.waitSamples > 0
            ? Math.round(this.waitTotalMs / this.waitSamples)
            : 0,
      },
      backoff: {
        active,
        mode: this.pauseMode,
        until: active ? new Date(this.pausedUntil).toISOString() : null,
        remainingSeconds: active ? this.remainingSeconds() : 0,
      },
    };
  }

  private remainingSeconds(): number {
    return Math.max(1, Math.ceil((this.pausedUntil - this.now()) / 1000));
  }

  /** A long (fail-fast) pause ends by the clock; short pauses end by timer. */
  private expireFailFastPause(): void {
    if (this.pauseMode === "fail-fast" && this.now() >= this.pausedUntil) {
      this.pauseMode = null;
    }
  }

  private pump(): void {
    this.expireFailFastPause();
    while (
      this.pending.length > 0 &&
      this.pauseMode === null &&
      this.inFlight < this.maxConcurrency
    ) {
      if (this.minIntervalMs > 0 && !this.pacingReady) {
        const waitMs = this.nextDispatchAt - this.now();
        if (waitMs > 0) {
          this.schedulePacing(waitMs);
          return;
        }
      }
      this.pacingReady = false;
      this.dispatch(this.pending.shift()!);
    }
  }

  private schedulePacing(waitMs: number): void {
    if (this.pacingTimerPending) {
      return;
    }
    this.pacingTimerPending = true;
    void this.sleep(waitMs).then(() => {
      this.pacingTimerPending = false;
      // The sleep is authoritative: allow the next dispatch without
      // re-reading the clock (keeps injected fake clocks from spinning).
      this.pacingReady = true;
      this.pump();
    });
  }

  private dispatch(task: QueuedTask): void {
    const startedAt = this.now();
    if (task.attempts === 0) {
      const waited = Math.max(0, startedAt - task.enqueuedAt);
      this.lastWaitMs = waited;
      this.maxWaitMs = Math.max(this.maxWaitMs, waited);
      this.waitTotalMs += waited;
      this.waitSamples++;
    }
    task.attempts++;
    this.inFlight++;
    this.dispatched++;
    if (this.minIntervalMs > 0) {
      this.nextDispatchAt = startedAt + this.minIntervalMs;
    }

    let result: Promise<unknown>;
    try {
      result = Promise.resolve(task.invoke());
    } catch (error) {
      result = Promise.reject(error);
    }
    result.then(
      (value) => {
        this.inFlight--;
        this.succeeded++;
        task.resolve(value);
        this.pump();
      },
      (error) => {
        this.inFlight--;
        this.handleFailure(task, error);
        this.pump();
      },
    );
  }

  private handleFailure(task: QueuedTask, error: unknown): void {
    const seconds = rateLimitSeconds(error);
    if (seconds === null) {
      this.failed++;
      task.reject(error);
      return;
    }

    this.rateLimitHits++;
    const isShort =
      this.rateLimitAutoRetrySeconds > 0 &&
      seconds <= this.rateLimitAutoRetrySeconds;
    this.startPause(seconds, isShort ? "wait" : "fail-fast");

    if (isShort && task.attempts === 1) {
      // Queue-owned retry: run it again first once the pause ends.
      this.queueRetries++;
      this.pending.unshift(task);
      return;
    }
    this.failed++;
    task.reject(error);
  }

  private startPause(seconds: number, mode: "wait" | "fail-fast"): void {
    // One clock read: a second read could shave a millisecond off the sleep.
    const startedAt = this.now();
    const until = startedAt + seconds * 1000;
    if (mode === "wait" && this.pauseMode !== null) {
      if (this.pauseMode === "fail-fast" || until <= this.pausedUntil) {
        // A long pause, or an equal-or-longer short one, already covers it.
        this.pausedUntil = Math.max(this.pausedUntil, until);
        return;
      }
    }
    this.pausedUntil = Math.max(this.pausedUntil, until);
    const generation = ++this.pauseGeneration;

    if (mode === "fail-fast") {
      this.pauseMode = "fail-fast";
      // Nobody should wait out a long backoff in the queue.
      const remaining = this.remainingSeconds();
      for (const queued of this.pending.splice(0)) {
        this.rejectedDuringBackoff++;
        queued.reject(new RateLimitBackoffError(remaining));
      }
      return;
    }

    this.pauseMode = "wait";
    void this.sleep(this.pausedUntil - startedAt).then(() => {
      if (generation !== this.pauseGeneration || this.pauseMode !== "wait") {
        return; // superseded by a newer or longer pause
      }
      this.pauseMode = null;
      this.pump();
    });
  }
}

/**
 * Wrap a Thrift store (NoteStore or UserStore) so every method call goes
 * through `queue`. Method wrappers are memoized so identity is stable across
 * property reads. `this` binds to the real store, so an RPC's internal property
 * access is not re-proxied (only top-level calls are queued).
 */
export function queueStoreMethods<T extends object>(
  store: T,
  queue: EvernoteRequestQueue,
): T {
  const wrapped = new Map<PropertyKey, any>();
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      let fn = wrapped.get(prop);
      if (!fn) {
        fn = (...args: any[]) => queue.run(() => value.apply(target, args));
        wrapped.set(prop, fn);
      }
      return fn;
    },
  }) as T;
}
