import { describe, it, expect, jest } from "@jest/globals";
import {
  EvernoteRequestQueue,
  RateLimitBackoffError,
  queueStoreMethods,
} from "../../src/request-queue.js";
import { buildToolErrorPayload } from "../../src/errors.js";
import { EvernoteAPI } from "../../src/evernote-api.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush microtasks + immediates so pending .then callbacks settle.
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
};

/**
 * Manual clock + controllable sleep. Each sleep(ms) is recorded and stays
 * pending until `fire()`; firing advances the clock by that sleep's ms.
 */
function fakeTime(start = 1_000_000) {
  let current = start;
  const sleeps: Array<{ ms: number; gate: Deferred<void> }> = [];
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    sleep: (ms: number) => {
      const gate = deferred<void>();
      sleeps.push({ ms, gate });
      return gate.promise;
    },
    sleeps,
    /** Resolve the oldest pending sleep, advancing the clock. */
    async fire() {
      const next = sleeps.shift();
      if (!next) throw new Error("no pending sleep");
      current += next.ms;
      next.gate.resolve();
      await flush();
      return next.ms;
    },
  };
}

function rateLimitError(seconds?: number): any {
  const error: any = new Error("RATE_LIMIT_REACHED");
  error.errorCode = 19;
  if (seconds !== undefined) error.rateLimitDuration = seconds;
  return error;
}

describe("EvernoteRequestQueue — concurrency and ordering", () => {
  it("caps in-flight calls at maxConcurrency and dispatches FIFO", async () => {
    const queue = new EvernoteRequestQueue({ maxConcurrency: 2 });
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
    const started: number[] = [];
    const runs = gates.map((gate, i) =>
      queue.run(async () => {
        started.push(i);
        await gate.promise;
        return i;
      }),
    );

    await flush();
    expect(started).toEqual([0, 1]);
    expect(queue.getMetrics()).toMatchObject({ inFlight: 2, queued: 3 });

    gates[1].resolve();
    await flush();
    expect(started).toEqual([0, 1, 2]);

    gates.forEach((g) => g.resolve());
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(queue.getMetrics()).toMatchObject({
      inFlight: 0,
      queued: 0,
      peakQueued: 3, // two dispatched immediately, three waited
      dispatched: 5,
      succeeded: 5,
      failed: 0,
    });
  });

  it("passes non-rate-limit errors through without pausing other callers", async () => {
    const queue = new EvernoteRequestQueue({ maxConcurrency: 1 });
    const boom = new Error("boom");
    const failing = queue.run(async () => {
      throw boom;
    });
    const next = queue.run(async () => "ok");
    await expect(failing).rejects.toBe(boom);
    await expect(next).resolves.toBe("ok");
    expect(queue.getMetrics()).toMatchObject({
      failed: 1,
      succeeded: 1,
      rateLimitHits: 0,
      backoff: { active: false },
    });
  });

  it("treats a synchronous throw from invoke as a failed call", async () => {
    const queue = new EvernoteRequestQueue({ maxConcurrency: 1 });
    const failing = queue.run((() => {
      throw new Error("sync");
    }) as any);
    await expect(failing).rejects.toThrow("sync");
    await expect(queue.run(async () => 1)).resolves.toBe(1);
  });
});

describe("EvernoteRequestQueue — pacing", () => {
  it("spaces dispatches by minIntervalMs", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 5,
      minIntervalMs: 1000,
      now: time.now,
      sleep: time.sleep,
    });
    const startedAt: number[] = [];
    const runs = [0, 1, 2].map(() =>
      queue.run(async () => {
        startedAt.push(time.now());
      }),
    );

    await flush();
    expect(startedAt).toHaveLength(1); // first goes immediately
    expect(time.sleeps.map((s) => s.ms)).toEqual([1000]);

    await time.fire();
    expect(startedAt).toHaveLength(2);
    await time.fire();
    await Promise.all(runs);

    expect(startedAt).toEqual([1_000_000, 1_001_000, 1_002_000]);
    // Waits are measured from enqueue to dispatch.
    expect(queue.getMetrics().waitMs).toEqual({ last: 2000, max: 2000, avg: 1000 });
  });

  it("does not pace when minIntervalMs is 0 (default)", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 5,
      now: time.now,
      sleep: time.sleep,
    });
    await Promise.all([0, 1, 2].map(() => queue.run(async () => null)));
    expect(time.sleeps).toHaveLength(0);
  });
});

describe("EvernoteRequestQueue — shared backoff on RATE_LIMIT_REACHED", () => {
  it("short backoff pauses ALL callers; the queue retries the failed call once, first", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 3,
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const order: string[] = [];
    let aAttempts = 0;

    const a = queue.run(async () => {
      aAttempts++;
      if (aAttempts === 1) throw rateLimitError(2);
      order.push("a");
      return "a";
    });
    await flush();

    // B and C arrive during the pause: they must not reach Evernote.
    const bInvoke = jest.fn(async () => {
      order.push("b");
      return "b";
    });
    const b = queue.run(bInvoke);
    const c = queue.run(async () => {
      order.push("c");
      return "c";
    });
    await flush();
    expect(bInvoke).not.toHaveBeenCalled();
    expect(queue.getMetrics()).toMatchObject({
      queued: 3, // a (retry) + b + c
      rateLimitHits: 1,
      queueRetries: 1,
      backoff: { active: true, mode: "wait", remainingSeconds: 2 },
    });
    // Exactly one shared timer for Evernote's exact window, not one per caller.
    expect(time.sleeps.map((s) => s.ms)).toEqual([2000]);

    await time.fire();
    await expect(Promise.all([a, b, c])).resolves.toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
    expect(aAttempts).toBe(2);
    expect(queue.getMetrics().backoff.active).toBe(false);
  });

  it("rejects if the queue-owned retry is rate-limited again (no retry loop)", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const invoke = jest.fn(async () => {
      throw rateLimitError(2);
    });
    const p = queue.run(invoke);
    const settled = p.catch((e) => e);
    await flush();
    await time.fire(); // first pause ends → retry → rate limited again
    const error = await settled;
    expect(error).toMatchObject({ errorCode: 19, rateLimitDuration: 2 });
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(queue.getMetrics()).toMatchObject({ queueRetries: 1, failed: 1 });
  });

  it("concurrent short rate limits extend the pause to the longest window", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 2,
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    let aTries = 0;
    let bTries = 0;
    const a = queue.run(async () => {
      if (++aTries === 1) {
        await gateA.promise;
        throw rateLimitError(2);
      }
      return "a";
    });
    const b = queue.run(async () => {
      if (++bTries === 1) {
        await gateB.promise;
        throw rateLimitError(5);
      }
      return "b";
    });
    await flush();
    gateA.resolve();
    await flush();
    gateB.resolve();
    await flush();
    expect(time.sleeps.map((s) => s.ms)).toEqual([2000, 5000]);

    await time.fire(); // the stale 2s timer must NOT end the 5s pause
    expect(aTries).toBe(1);
    expect(queue.getMetrics().backoff.active).toBe(true);

    await time.fire();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
  });

  it("long backoff fails the call, every queued call, and new calls fast", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 1,
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const original = rateLimitError(600);
    const a = queue.run(async () => {
      throw original;
    });
    const queuedInvoke = jest.fn(async () => "never");
    const b = queue.run(queuedInvoke); // waiting behind a (concurrency 1)
    // Attach handlers up front: b rejects in the same tick as a.
    const [aError, bError] = await Promise.all([
      a.catch((e) => e),
      b.catch((e) => e),
    ]);

    expect(aError).toBe(original);
    expect(bError).toBeInstanceOf(RateLimitBackoffError);
    expect(bError).toMatchObject({ errorCode: 19, rateLimitDuration: 600 });
    expect(queuedInvoke).not.toHaveBeenCalled();

    time.advance(100_000);
    const lateInvoke = jest.fn(async () => "never");
    await expect(queue.run(lateInvoke)).rejects.toMatchObject({
      errorCode: 19,
      rateLimitDuration: 500,
    });
    expect(lateInvoke).not.toHaveBeenCalled();
    expect(time.sleeps).toHaveLength(0); // nobody waits out a long backoff
    expect(queue.getMetrics()).toMatchObject({
      rejectedDuringBackoff: 2,
      backoff: { active: true, mode: "fail-fast", remainingSeconds: 500 },
    });

    // Once Evernote's window has elapsed, calls flow again.
    time.advance(500_000);
    await expect(queue.run(async () => "ok")).resolves.toBe("ok");
    expect(queue.getMetrics().backoff).toMatchObject({ active: false, mode: null });
  });

  it("rateLimitAutoRetrySeconds=0 turns every backoff into fail-fast", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      rateLimitAutoRetrySeconds: 0,
      now: time.now,
      sleep: time.sleep,
    });
    const invoke = jest.fn(async () => {
      throw rateLimitError(2);
    });
    await expect(queue.run(invoke)).rejects.toMatchObject({ rateLimitDuration: 2 });
    await expect(queue.run(async () => "x")).rejects.toBeInstanceOf(
      RateLimitBackoffError,
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(time.sleeps).toHaveLength(0);
  });

  it("a long backoff during a short one rejects the waiting callers", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 2,
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const gate = deferred<void>();
    const short = queue.run(async () => {
      throw rateLimitError(2);
    });
    const long = queue.run(async () => {
      await gate.promise;
      throw rateLimitError(900);
    });
    const shortSettled = short.catch((e) => e);
    await flush(); // short paused the queue; its retry is queued
    gate.resolve();
    expect(await long.catch((e) => e)).toMatchObject({ rateLimitDuration: 900 });
    const shortError = await shortSettled;
    expect(shortError).toBeInstanceOf(RateLimitBackoffError);
    expect(shortError.rateLimitDuration).toBe(900);

    await time.fire(); // stale short-pause timer must not lift the long pause
    expect(queue.getMetrics().backoff.mode).toBe("fail-fast");
  });

  it("a short rate limit landing during a long backoff rejects promptly (no stranded retry)", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 2,
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const gate = deferred<void>();
    const long = queue.run(async () => {
      throw rateLimitError(600);
    });
    const shortInvoke = jest.fn(async () => {
      await gate.promise;
      throw rateLimitError(2);
    });
    const short = queue.run(shortInvoke); // in flight when the long hit lands
    const [longError] = await Promise.all([long.catch((e) => e), flush()]);
    expect(longError).toMatchObject({ rateLimitDuration: 600 });

    gate.resolve();
    const shortError = await short.catch((e) => e); // must settle, not hang
    expect(shortError).toBeInstanceOf(RateLimitBackoffError);
    expect(shortError.rateLimitDuration).toBe(600);
    expect(shortInvoke).toHaveBeenCalledTimes(1);
    expect(queue.getMetrics()).toMatchObject({ queued: 0, queueRetries: 0 });
    expect(time.sleeps).toHaveLength(0);
  });

  it("ignores errorCode 19 without a duration (edit lock): no pause, no retry", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({ now: time.now, sleep: time.sleep });
    const lock = rateLimitError(undefined);
    await expect(queue.run(async () => Promise.reject(lock))).rejects.toBe(lock);
    await expect(queue.run(async () => "next")).resolves.toBe("next");
    expect(time.sleeps).toHaveLength(0);
    expect(queue.getMetrics()).toMatchObject({ rateLimitHits: 0, queueRetries: 0 });
  });

  it("reads rateLimitDuration from a wrapped originalError", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      rateLimitAutoRetrySeconds: 15,
      now: time.now,
      sleep: time.sleep,
    });
    const wrapped: any = new Error("wrapped");
    wrapped.originalError = rateLimitError(1200);
    await expect(queue.run(async () => Promise.reject(wrapped))).rejects.toBe(wrapped);
    expect(queue.getMetrics().backoff.mode).toBe("fail-fast");
  });

  it("locally rejected calls produce a rate_limited tool payload with retryAfterSeconds", () => {
    const payload = buildToolErrorPayload(
      "evernote_get_note",
      new RateLimitBackoffError(42),
      () => new Date("2026-01-01T00:00:00Z"),
    );
    expect(payload).toMatchObject({
      error: "rate_limited",
      errorCode: 19,
      errorName: "RATE_LIMIT_REACHED",
      retryAfterSeconds: 42,
    });
  });
});

describe("queueStoreMethods", () => {
  it("routes method calls through the queue and passes properties through", async () => {
    const queue = new EvernoteRequestQueue({ maxConcurrency: 1 });
    const store = {
      url: "https://x/notestore",
      calls: 0,
      async getNote(this: any, guid: string) {
        this.calls++;
        return `note:${guid}`;
      },
    };
    const queued = queueStoreMethods(store, queue);
    expect(queued.url).toBe("https://x/notestore");
    expect(queued.getNote).toBe(queued.getNote); // memoized wrapper
    await expect(queued.getNote("g1")).resolves.toBe("note:g1");
    expect(store.calls).toBe(1); // `this` bound to the real store
    expect(queue.getMetrics().dispatched).toBe(1);
  });
});

describe("EvernoteAPI with a shared queue", () => {
  function makeApi(noteStore: any, queue: EvernoteRequestQueue, userStore?: any) {
    const client = {
      getNoteStore: () => noteStore,
      getUserStore: () => userStore,
    };
    return new EvernoteAPI(
      client as any,
      { noteStoreUrl: "https://x/notestore" } as any,
      { requestQueue: queue, noteCache: { maxEntries: 0 } },
    );
  }

  it("a rate limit hit by one instance pauses calls from another", async () => {
    const time = fakeTime();
    const queue = new EvernoteRequestQueue({
      maxConcurrency: 3,
      rateLimitAutoRetrySeconds: 0,
      now: time.now,
      sleep: time.sleep,
    });
    const first = makeApi(
      {
        listNotebooks: jest.fn(async () => {
          throw rateLimitError(300);
        }),
      },
      queue,
    );
    const secondListTags = jest.fn(async () => []);
    const second = makeApi({ listTags: secondListTags }, queue);

    await expect(first.listNotebooks()).rejects.toMatchObject({ errorCode: 19 });
    await expect(second.listTags()).rejects.toMatchObject({
      errorCode: 19,
      rateLimitDuration: 300,
    });
    expect(secondListTags).not.toHaveBeenCalled();
  });

  it("UserStore calls (getUser) go through the same queue", async () => {
    const queue = new EvernoteRequestQueue();
    const getUser = jest.fn(async () => ({ id: 1, username: "u" }));
    const api = makeApi({}, queue, { getUser });
    await expect(api.getUser()).resolves.toMatchObject({ id: 1 });
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(queue.getMetrics().dispatched).toBe(1);
  });
});
