/**
 * Bounded concurrency + short-wait auto-retry for Evernote NoteStore RPCs.
 *
 * The Evernote hourly rate limit is a per-token call-count quota: throttling
 * cannot restore quota, but bounding burst width keeps a wide fan-out from
 * spiking into errorCode 19, and honoring a short `rateLimitDuration` lets a
 * transient limit self-heal without bubbling a failure to the agent. Longer
 * waits are surfaced as structured errors (see src/errors.ts) so the caller
 * can reschedule.
 */

import { getEvernoteErrorMeta, RATE_LIMIT_ERROR_CODE } from "./errors.js";

export const DEFAULT_MAX_CONCURRENCY = 3;
export const DEFAULT_RATE_LIMIT_AUTO_RETRY_SECONDS = 15;

export interface RpcLimitOptions {
  /** Max simultaneous in-flight NoteStore RPCs. */
  maxConcurrency: number;
  /**
   * Auto-retry a rate-limited RPC once when Evernote's rateLimitDuration is at
   * or below this many seconds. 0 disables auto-retry entirely.
   */
  rateLimitAutoRetrySeconds: number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    sleep: opts?.sleep,
  };
}

async function runLimited<R>(
  invoke: () => Promise<R>,
  semaphore: Semaphore,
  autoRetrySeconds: number,
  sleep: (ms: number) => Promise<void>,
): Promise<R> {
  let release = await semaphore.acquire();
  try {
    return await invoke();
  } catch (error: any) {
    const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
    const canRetry =
      errorCode === RATE_LIMIT_ERROR_CODE &&
      autoRetrySeconds > 0 &&
      typeof rateLimitDuration === "number" &&
      rateLimitDuration > 0 &&
      rateLimitDuration <= autoRetrySeconds;
    if (!canRetry) {
      throw error;
    }
    // Release BEFORE sleeping so a short rate-limit wait doesn't pin a permit
    // and stall other queued RPCs behind us.
    release();
    await sleep(rateLimitDuration * 1000);
    release = await semaphore.acquire();
    return await invoke(); // retry exactly once; a second failure propagates
  } finally {
    release();
  }
}

/**
 * Wrap a NoteStore so every method call is gated by a shared semaphore and gets
 * short-wait rate-limit auto-retry. Method wrappers are memoized so identity is
 * stable across property reads. `this` binds to the real store, so an RPC's
 * internal property access is not re-proxied (only top-level calls are limited).
 */
export function limitNoteStoreMethods<T extends object>(
  noteStore: T,
  opts: RpcLimitOptions,
): T {
  const semaphore = new Semaphore(opts.maxConcurrency);
  const sleep = opts.sleep ?? defaultSleep;
  const wrapped = new Map<PropertyKey, any>();

  return new Proxy(noteStore, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") {
        return value;
      }
      let fn = wrapped.get(prop);
      if (!fn) {
        fn = (...args: any[]) =>
          runLimited(
            () => value.apply(target, args),
            semaphore,
            opts.rateLimitAutoRetrySeconds,
            sleep,
          );
        wrapped.set(prop, fn);
      }
      return fn;
    },
  }) as T;
}
