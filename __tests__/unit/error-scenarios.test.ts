import { describe, it, expect } from "@jest/globals";
import {
  buildToolErrorPayload,
  getEvernoteErrorMeta,
  evernoteErrorName,
} from "../../src/errors.js";

const fixedNow = () => new Date("2026-07-07T00:00:00.000Z");

describe("buildToolErrorPayload", () => {
  it("classifies rate limits (errorCode 19) with retryAfterSeconds", () => {
    const err: any = new Error("rate limit reached");
    err.errorCode = 19;
    err.rateLimitDuration = 2144;

    const payload = buildToolErrorPayload("evernote_get_note", err, fixedNow);
    expect(payload).toEqual({
      error: "rate_limited",
      tool: "evernote_get_note",
      message: "rate limit reached",
      errorCode: 19,
      errorName: "RATE_LIMIT_REACHED",
      retryAfterSeconds: 2144,
      timestamp: "2026-07-07T00:00:00.000Z",
    });
  });

  it("classifies non-rate-limit Evernote errors and names the code", () => {
    const err: any = new Error("auth expired");
    err.errorCode = 9;

    const payload = buildToolErrorPayload("evernote_search_notes", err, fixedNow);
    expect(payload.error).toBe("evernote_error");
    expect(payload.errorCode).toBe(9);
    expect(payload.errorName).toBe("AUTH_EXPIRED");
    expect(payload.retryAfterSeconds).toBeUndefined();
  });

  it("unwraps a wrapped originalError (as EvernoteAPI.updateNote produces)", () => {
    const original: any = new Error("underlying");
    original.errorCode = 19;
    original.rateLimitDuration = 5;
    const wrapped: any = new Error("Failed to update note g1: underlying");
    wrapped.originalError = original;

    const payload = buildToolErrorPayload("evernote_update_note", wrapped, fixedNow);
    expect(payload.error).toBe("rate_limited");
    expect(payload.errorCode).toBe(19);
    expect(payload.retryAfterSeconds).toBe(5);
  });

  it("handles a plain Error with no Evernote metadata", () => {
    const payload = buildToolErrorPayload(
      "evernote_health_check",
      new Error("network down"),
      fixedNow,
    );
    expect(payload).toEqual({
      error: "evernote_error",
      tool: "evernote_health_check",
      message: "network down",
      timestamp: "2026-07-07T00:00:00.000Z",
    });
    expect(payload.errorCode).toBeUndefined();
    expect(payload.errorName).toBeUndefined();
  });

  it("omits retryAfterSeconds when rateLimitDuration is absent or zero", () => {
    const err: any = new Error("rate limit reached");
    err.errorCode = 19;
    err.rateLimitDuration = 0;
    const payload = buildToolErrorPayload("evernote_get_note", err, fixedNow);
    expect(payload.error).toBe("rate_limited");
    expect(payload.retryAfterSeconds).toBeUndefined();
  });
});

describe("getEvernoteErrorMeta / evernoteErrorName", () => {
  it("reads code + duration off the error and its originalError", () => {
    expect(getEvernoteErrorMeta({ errorCode: 8 })).toEqual({
      errorCode: 8,
      rateLimitDuration: undefined,
    });
    expect(
      getEvernoteErrorMeta({ originalError: { errorCode: 19, rateLimitDuration: 30 } }),
    ).toEqual({ errorCode: 19, rateLimitDuration: 30 });
  });

  it("maps known EDAM codes and returns undefined for unknown", () => {
    expect(evernoteErrorName(19)).toBe("RATE_LIMIT_REACHED");
    expect(evernoteErrorName(8)).toBe("INVALID_AUTH");
    expect(evernoteErrorName(999)).toBeUndefined();
    expect(evernoteErrorName(undefined)).toBeUndefined();
  });
});
