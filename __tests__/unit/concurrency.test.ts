import { describe, it, expect, jest } from "@jest/globals";
import {
  Semaphore,
  limitNoteStoreMethods,
  resolveRpcLimitOptions,
  RpcLimitOptions,
} from "../../src/concurrency.js";
import { EvernoteAPI } from "../../src/evernote-api.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: any) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Flush the microtask + immediate queues so pending .then callbacks settle.
const flush = () => new Promise<void>((r) => setImmediate(r));

describe("Semaphore", () => {
  it("never exceeds capacity concurrent holders", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let maxActive = 0;
    const gates = Array.from({ length: 5 }, () => deferred<void>());

    const runs = gates.map((gate) =>
      (async () => {
        const release = await sem.acquire();
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        release();
      })(),
    );

    await flush();
    expect(active).toBe(2); // only two permits handed out

    for (const gate of gates) {
      gate.resolve();
      await flush();
    }
    await Promise.all(runs);
    expect(maxActive).toBe(2);
  });

  it("serves waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    const held = await sem.acquire(); // take the only permit

    const waiters = [1, 2, 3].map((n) =>
      sem.acquire().then((release) => {
        order.push(n);
        return release;
      }),
    );

    held(); // wake waiter 1
    let release = await waiters[0];
    await flush();
    release(); // wake waiter 2
    release = await waiters[1];
    await flush();
    release(); // wake waiter 3
    release = await waiters[2];
    await flush();
    release();

    expect(order).toEqual([1, 2, 3]);
  });

  it("release is idempotent", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    expect(sem.availablePermits).toBe(0);
    release();
    release(); // second call must not add a phantom permit
    expect(sem.availablePermits).toBe(1);
  });
});

describe("limitNoteStoreMethods", () => {
  it("bounds concurrent RPCs to maxConcurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const gate = deferred<void>();
    const noteStore = {
      getNote: jest.fn(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        return "ok";
      }),
    };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions({ maxConcurrency: 2 }),
    );

    const calls = [0, 1, 2, 3].map(() => (limited as any).getNote());
    await flush();
    expect(maxActive).toBe(2);

    gate.resolve();
    await Promise.all(calls);
    expect(maxActive).toBe(2);
    expect(noteStore.getNote).toHaveBeenCalledTimes(4);
  });

  it("passes non-function properties through untouched", () => {
    const noteStore = { userStoreUrl: "https://x/notestore", getNote: () => {} };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions(),
    );
    expect((limited as any).userStoreUrl).toBe("https://x/notestore");
  });

  it("auto-retries once on a short rate limit and sleeps the exact window", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    let attempts = 0;
    const noteStore = {
      getNote: jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          const e: any = new Error("rate limited");
          e.errorCode = 19;
          e.rateLimitDuration = 2;
          throw e;
        }
        return "ok";
      }),
    };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions({ rateLimitAutoRetrySeconds: 15, sleep }),
    );

    await expect((limited as any).getNote()).resolves.toBe("ok");
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([2000]); // rateLimitDuration seconds → ms
  });

  it("does not retry when the wait exceeds the threshold", async () => {
    const sleep = jest.fn(async () => {});
    const noteStore = {
      getNote: jest.fn(async () => {
        const e: any = new Error("rate limited");
        e.errorCode = 19;
        e.rateLimitDuration = 2144;
        throw e;
      }),
    };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions({ rateLimitAutoRetrySeconds: 15, sleep }),
    );

    await expect((limited as any).getNote()).rejects.toThrow("rate limited");
    expect(noteStore.getNote).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry when auto-retry is disabled (0)", async () => {
    const sleep = jest.fn(async () => {});
    const noteStore = {
      getNote: jest.fn(async () => {
        const e: any = new Error("rate limited");
        e.errorCode = 19;
        e.rateLimitDuration = 2;
        throw e;
      }),
    };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions({ rateLimitAutoRetrySeconds: 0, sleep }),
    );

    await expect((limited as any).getNote()).rejects.toThrow("rate limited");
    expect(noteStore.getNote).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("frees the permit while awaiting a rate-limit retry", async () => {
    let releaseSleep!: () => void;
    const sleepGate = new Promise<void>((r) => {
      releaseSleep = r;
    });
    const sleep = () => sleepGate;
    const order: string[] = [];
    let slowAttempts = 0;
    const noteStore = {
      slow: jest.fn(async () => {
        slowAttempts++;
        if (slowAttempts === 1) {
          const e: any = new Error("rate limited");
          e.errorCode = 19;
          e.rateLimitDuration = 2;
          throw e;
        }
        order.push("slow-done");
        return "slow";
      }),
      fast: jest.fn(async () => {
        order.push("fast-done");
        return "fast";
      }),
    };
    const limited = limitNoteStoreMethods(
      noteStore,
      resolveRpcLimitOptions({
        maxConcurrency: 1,
        rateLimitAutoRetrySeconds: 15,
        sleep,
      }),
    );

    const slowP = (limited as any).slow(); // grabs permit, 429s, releases, sleeps
    await flush();
    const fastP = (limited as any).fast(); // must run on the freed permit
    await flush();
    expect(order).toEqual(["fast-done"]);

    releaseSleep(); // let slow re-acquire and succeed
    const [s, f] = await Promise.all([slowP, fastP]);
    expect(s).toBe("slow");
    expect(f).toBe("fast");
    expect(order).toEqual(["fast-done", "slow-done"]);
  });
});

describe("EvernoteAPI RPC limiting", () => {
  function makeApi(noteStore: any, options?: Partial<RpcLimitOptions>) {
    const client = { getNoteStore: () => noteStore };
    return new EvernoteAPI(
      client as any,
      { noteStoreUrl: "https://x/notestore" } as any,
      options,
    );
  }

  it("updateNote makes a single attempt on a long rate limit and enriches the error", async () => {
    const updateNote = jest.fn(async () => {
      const e: any = new Error("boom");
      e.errorCode = 19;
      e.rateLimitDuration = 2144;
      throw e;
    });
    const api = makeApi({ updateNote }, { rateLimitAutoRetrySeconds: 15 });

    await expect(api.updateNote({ guid: "g1" })).rejects.toMatchObject({
      errorCode: 19,
      rateLimitDuration: 2144,
      noteGuid: "g1",
    });
    expect(updateNote).toHaveBeenCalledTimes(1);
  });
});
