// Route error mapping (hosted history route 429). Run: npm run test:routeerr
import { test } from "node:test";
import assert from "node:assert/strict";
import { statusForError, errorResponseInit } from "./route-errors.ts";
import { RateLimitError, assertNotCoolingDown, noteVenueRateLimit, resetRateLimitForTests } from "./market-client.ts";

test("a venue rate limit maps to 429 with Retry-After in whole seconds (rounded up)", () => {
  const err = new RateLimitError("rate limited (429).", 12_001);
  assert.equal(statusForError(err), 429);
  assert.deepEqual(errorResponseInit(err), { status: 429, headers: { "Retry-After": "13" } });
});

test("an active venue cooldown thrown by assertNotCoolingDown maps to 429 with its remaining seconds", () => {
  resetRateLimitForTests();
  noteVenueRateLimit("binance", new RateLimitError("ban", 30_000));
  let caught;
  try { assertNotCoolingDown("binance"); } catch (e) { caught = e; }
  assert.ok(caught, "the cooldown throws");
  const init = errorResponseInit(caught);
  assert.equal(init.status, 429);
  const secs = Number(init.headers["Retry-After"]);
  assert.ok(Number.isInteger(secs) && secs >= 1 && secs <= 30, `Retry-After ${secs}`);
  resetRateLimitForTests();
});

test("a rate limit with no usable cooldown still maps to 429, without a Retry-After header", () => {
  assert.deepEqual(errorResponseInit(new RateLimitError("x", 0)), { status: 429 });
  assert.deepEqual(errorResponseInit(new RateLimitError("x", Number.NaN)), { status: 429 });
});

test("every other failure stays 502", () => {
  for (const e of [new Error("HTTP 500"), new TypeError("fetch failed"), new DOMException("aborted", "AbortError"), "boom", null, undefined]) {
    assert.equal(statusForError(e), 502);
    assert.deepEqual(errorResponseInit(e), { status: 502 });
  }
});
