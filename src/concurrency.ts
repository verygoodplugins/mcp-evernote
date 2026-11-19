/**
 * RPC limit options + the store wrapper used by EvernoteAPI.
 *
 * The Evernote hourly rate limit is a per-token call-count quota: throttling
 * cannot restore quota, but bounding burst width keeps a wide fan-out from
 * spiking into errorCode 19, and a shared backoff that honors
 * `rateLimitDuration` stops callers from compounding retries. The queue itself
 * lives in src/request-queue.ts; this module keeps the option resolution and
 * the `limitNoteStoreMethods` entry point (a store wrapped by its own queue)
 * for callers that don't share a process-wide queue.
 */

import {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS,
  EvernoteRequestQueue,
  queueStoreMethods,
  RequestQueueOptions,
} from "./request-queue.js";

export {
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MIN_REQUEST_INTERVAL_MS,
  DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS,
};

export type RpcLimitOptions = RequestQueueOptions;

/**
 * A FIFO counting semaphore. `acquire()` resolves with a `release` function;
 * releasing hands the permit directly to the next waiter (FIFO), so a queued
 * caller can never be starved by a steady stream of new arrivals.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = resolveIntegerOption(capacity, 1, 1);
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return this.makeRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    // Resumed via a direct hand-off in release() — the permit is already ours,
    // `available` was intentionally not incremented.
    return this.makeRelease();
  }

  /** Current number of free permits (for assertions/tests). */
  get availablePermits(): number {
    return this.available;
  }

  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return; // idempotent: releasing twice must not corrupt the count
      }
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next(); // transfer the permit to the next waiter without touching count
      } else {
        this.available++;
      }
    };
  }
}

function resolveIntegerOption(
  value: number | undefined,
  fallback: number,
  min: number,
): number {
  const resolved = Math.floor(value ?? fallback);
  return Number.isFinite(resolved) ? Math.max(min, resolved) : fallback;
}

export function resolveRpcLimitOptions(
  opts?: Partial<RpcLimitOptions>,
): RpcLimitOptions {
  return {
    maxConcurrency: resolveIntegerOption(
      opts?.maxConcurrency,
      DEFAULT_MAX_CONCURRENCY,
      1,
    ),
    rateLimitAutoRetrySeconds: resolveIntegerOption(
      opts?.rateLimitAutoRetrySeconds,
      DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS,
      0,
    ),
    minIntervalMs: resolveIntegerOption(
      opts?.minIntervalMs,
      DEFAULT_MIN_REQUEST_INTERVAL_MS,
      0,
    ),
    sleep: opts?.sleep,
    now: opts?.now,
  };
}

/**
 * Wrap a NoteStore with its own request queue (concurrency limit, pacing,
 * shared backoff; see src/request-queue.ts). Prefer passing one process-wide
 * `EvernoteRequestQueue` to EvernoteAPI so every caller shares the backoff.
 */
export function limitNoteStoreMethods<T extends object>(
  noteStore: T,
  opts: RpcLimitOptions,
): T {
  return queueStoreMethods(noteStore, new EvernoteRequestQueue(opts));
}
