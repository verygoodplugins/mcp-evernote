/**
 * Structured error shaping for tool responses.
 *
 * Evernote's Thrift API raises EDAMSystemException/EDAMUserException with a
 * numeric `errorCode` (the EDAMErrorCode enum) and, for rate limits, a
 * `rateLimitDuration` in SECONDS. This module turns those into a small,
 * machine-parseable JSON payload so an agent can read `retryAfterSeconds` and
 * reschedule instead of guessing from prose.
 */

// EDAMErrorCode enum (subset that callers benefit from seeing by name).
// https://dev.evernote.com/doc/reference/Errors.html#Enum_EDAMErrorCode
const EDAM_ERROR_NAMES: Record<number, string> = {
  1: "UNKNOWN",
  2: "BAD_DATA_FORMAT",
  3: "PERMISSION_DENIED",
  4: "INTERNAL_ERROR",
  5: "DATA_REQUIRED",
  6: "LIMIT_REACHED",
  7: "QUOTA_REACHED",
  8: "INVALID_AUTH",
  9: "AUTH_EXPIRED",
  10: "DATA_CONFLICT",
  11: "ENML_VALIDATION",
  12: "SHARD_UNAVAILABLE",
  13: "LEN_TOO_SHORT",
  14: "LEN_TOO_LONG",
  15: "TOO_FEW",
  16: "TOO_MANY",
  17: "UNSUPPORTED_OPERATION",
  18: "TAKEN_DOWN",
  19: "RATE_LIMIT_REACHED",
  20: "BUSINESS_SECURITY_LOGIN_REQUIRED",
  21: "DEVICE_LIMIT_REACHED",
};

/** EDAMErrorCode.RATE_LIMIT_REACHED */
export const RATE_LIMIT_ERROR_CODE = 19;

export interface ToolErrorPayload {
  /** `rate_limited` iff errorCode 19; otherwise `evernote_error`. */
  error: "rate_limited" | "evernote_error";
  tool: string;
  message: string;
  errorCode?: number;
  errorName?: string;
  /** Seconds to wait before retrying, from Evernote's rateLimitDuration. */
  retryAfterSeconds?: number;
  timestamp: string;
}

/**
 * Extract Evernote error metadata, unwrapping the `originalError` that
 * `EvernoteAPI` wraps around SDK failures (see updateNote's enhanced error).
 */
export function getEvernoteErrorMeta(error: any): {
  errorCode?: number;
  rateLimitDuration?: number;
} {
  const original = error?.originalError ?? error;
  return {
    errorCode: error?.errorCode ?? original?.errorCode,
    rateLimitDuration: error?.rateLimitDuration ?? original?.rateLimitDuration,
  };
}

/** Look up the EDAMErrorCode name for a numeric code, if known. */
export function evernoteErrorName(errorCode?: number): string | undefined {
  return errorCode != null ? EDAM_ERROR_NAMES[errorCode] : undefined;
}

/**
 * Build the JSON error body returned to the agent from a failed tool call.
 * `now` is injectable for deterministic tests.
 */
export function buildToolErrorPayload(
  tool: string,
  error: any,
  now: () => Date = () => new Date(),
): ToolErrorPayload {
  const { errorCode, rateLimitDuration } = getEvernoteErrorMeta(error);
  const payload: ToolErrorPayload = {
    error:
      errorCode === RATE_LIMIT_ERROR_CODE ? "rate_limited" : "evernote_error",
    tool,
    message: errorMessageOf(error),
    timestamp: now().toISOString(),
  };
  if (errorCode != null) {
    payload.errorCode = errorCode;
    const name = evernoteErrorName(errorCode);
    if (name) {
      payload.errorName = name;
    }
  }
  if (typeof rateLimitDuration === "number" && rateLimitDuration > 0) {
    payload.retryAfterSeconds = rateLimitDuration;
  }
  return payload;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error) || String(error);
  } catch {
    return String(error);
  }
}
