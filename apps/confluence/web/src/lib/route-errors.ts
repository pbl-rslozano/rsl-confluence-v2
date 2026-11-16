/**
 * HTTP status for an error thrown inside an /api route. A venue rate limit (RateLimitError, including the
 * cooldown thrown by assertNotCoolingDown) is 429 with Retry-After in seconds, so a client can tell
 * "refused, try later" from a real failure (502). Detected by `reason` so it also holds across module copies.
 */
import type { RateLimitError } from "./market-client";

function isRateLimit(error: unknown): error is RateLimitError {
  return typeof error === "object" && error !== null && (error as { reason?: unknown }).reason === "RATE_LIMIT";
}

export function statusForError(error: unknown): 429 | 502 {
  return isRateLimit(error) ? 429 : 502;
}

/** `init` for NextResponse.json: the status, plus Retry-After (whole seconds, rounded up) when the error carries a cooldown. */
export function errorResponseInit(error: unknown): { status: 429 | 502; headers?: Record<string, string> } {
  const status = statusForError(error);
  if (status === 429 && isRateLimit(error) && Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    return { status, headers: { "Retry-After": String(Math.ceil(error.retryAfterMs / 1000)) } };
  }
  return { status };
}
