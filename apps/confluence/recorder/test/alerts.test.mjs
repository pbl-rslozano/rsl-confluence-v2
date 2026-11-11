// Alert rules, dedupe, cooldown, persistence and secret redaction (mock Telegram / webhook; no network).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { alertConfigFromEnv, createAlerter, DISCLAIMER } from "../src/alerts.mjs";
import { createGuardedFetch, makeRedactor } from "../src/net.mjs";
import { mockExchange, STEP_4H, tempDir } from "./fixtures.mjs";

const TOKEN = "987654321:AAH-secret-token-value_0123456789xyz";
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-1001234567" };
const IV = STEP_4H;
const T = Date.UTC(2026, 9, 1);
const ctx = { src: "binance", tf: "4h", ac: "crypto", cfg: "abcdef0123456789" };

const row = (i, m, st, extra = {}) => ({
  id: `x|${i}`, cfg: ctx.cfg, src: "binance", tf: "4h", pair: "BTCUSDT", ac: "crypto", t: T + i * IV, tc: T + (i + 1) * IV, sc: m * (st === 2 ? 75 : st === 1 ? 60 : 20), m, st, sup: 0, ...extra,
});
const noRev = { reversal: { isReversal: false, direction: "NONE", confidence: "NONE" } };
const item = (r, score = noRev) => ({ row: r, score });

function setup(t, dir = tempDir(t), env = ENV, telegram) {
  const config = alertConfigFromEnv(env);
  const redact = makeRedactor(config.secrets);
  const ex = mockExchange({ telegram });
  const guard = createGuardedFetch({ baseFetch: ex.fetch, hosts: config.hosts, redact });
  const logs = [];
  const alerter = createAlerter({ outDir: dir, config, guard, redact, log: (l) => logs.push(l), ctx });
  return { dir, alerter, ex, logs, sent: () => ex.calls.filter((c) => c.host === "api.telegram.org") };
}

test("env config: channels on only when complete and valid; secrets listed for redaction", () => {
  assert.equal(alertConfigFromEnv({}).telegram, null);
  assert.equal(alertConfigFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN }).telegram, null, "chat id missing");
  const bad = alertConfigFromEnv({ TELEGRAM_BOT_TOKEN: "nope", TELEGRAM_CHAT_ID: "1" });
  assert.equal(bad.telegram, null);
  assert.ok(bad.warnings.every((w) => !w.includes("nope")), "warnings never echo the value");
  const ok = alertConfigFromEnv({ ...ENV, ALERT_WEBHOOK_URL: "https://hooks.example.test/a/b" });
  assert.deepEqual(ok.hosts, ["api.telegram.org", "hooks.example.test"]);
  assert.ok(ok.secrets.includes(TOKEN));
  assert.equal(alertConfigFromEnv({ ALERT_WEBHOOK_URL: "http://hooks.example.test/x" }).webhook, null, "https only");
});

test("STRONG transition alerts once; restart never repeats; cooldown in bars; flip to the other side alerts", async (t) => {
  const s = setup(t);
  s.alerter.evaluate([item(row(0, 1, 1))], IV, T);
  await s.alerter.flush(undefined, T);
  assert.equal(s.sent().length, 0, "first observation sets state only");

  s.alerter.evaluate([item(row(1, 1, 2))], IV, T + IV);
  await s.alerter.flush(undefined, T + IV);
  assert.equal(s.sent().length, 1);

  // Restart: a new alerter over the same state file sees the same bar again.
  const s2 = setup(t, s.dir);
  s2.alerter.evaluate([item(row(1, 1, 2))], IV, T + IV + 5);
  await s2.alerter.flush(undefined, T + IV + 5);
  assert.equal(s2.sent().length, 0, "same series + bar + kind is never sent twice");

  // MODERATE then STRONG again 2 bars later: inside the 6-bar cooldown.
  s2.alerter.evaluate([item(row(2, 1, 1))], IV);
  s2.alerter.evaluate([item(row(3, 1, 2))], IV);
  await s2.alerter.flush();
  assert.equal(s2.sent().length, 0, "cooldown");

  // 8 bars after the first alert: allowed again.
  s2.alerter.evaluate([item(row(8, 1, 1))], IV);
  s2.alerter.evaluate([item(row(9, 1, 2))], IV);
  await s2.alerter.flush();
  assert.equal(s2.sent().length, 1);

  // STRONG BULLISH → STRONG BEARISH is a direction change into STRONG.
  s2.alerter.evaluate([item(row(10, -1, 2))], IV);
  await s2.alerter.flush();
  assert.equal(s2.sent().length, 2);
});

test("message text: engine id, source/tf/pair, score, UTC bar close, disclaimer", async (t) => {
  const bodies = [];
  const s = setup(t, undefined, ENV, ({ body }) => { bodies.push(body); return new Response('{"ok":true}'); });
  s.alerter.evaluate([item(row(0, -1, 1))], IV);
  s.alerter.evaluate([item(row(1, -1, 2, { sc: -77 }))], IV);
  await s.alerter.flush();
  assert.equal(bodies.length, 1);
  const { text, chat_id } = bodies[0];
  assert.equal(chat_id, "-1001234567");
  assert.match(text, /BTCUSDT STRONG BEARISH Master Signal/);
  assert.match(text, /binance 4h · crypto · score -77/);
  assert.match(text, /Bar close: 2026-10-01 08:00 UTC/);
  assert.match(text, /Engine: abcdef0123456789/);
  assert.ok(text.includes(DISCLAIMER));
  assert.ok(!text.includes(TOKEN));
});

test("reversal alerts: HIGH/MODERATE against the trend only; catch-up rows never alert", async (t) => {
  const s = setup(t);
  const rev = (direction, confidence, isReversal = true) => ({ reversal: { isReversal, direction, confidence } });
  s.alerter.observe([row(0, 0, 0), row(1, 0, 0)]); // catch-up: state only
  s.alerter.evaluate([item(row(2, 0, 0), rev("UP", "LOW"))], IV);
  s.alerter.evaluate([item(row(3, 0, 0), rev("UP", "HIGH", false))], IV);
  await s.alerter.flush();
  assert.equal(s.sent().length, 0);
  s.alerter.evaluate([item(row(4, 0, 0), rev("UP", "MODERATE"))], IV);
  s.alerter.evaluate([item(row(5, 0, 0), rev("UP", "HIGH"))], IV); // same direction within cooldown
  s.alerter.evaluate([item(row(6, 0, 0), rev("DOWN", "HIGH"))], IV);
  await s.alerter.flush();
  assert.equal(s.sent().length, 2, "rev-up once, rev-down once");
});

test("send failures: token redacted in logs and state, retried from the outbox, never duplicated", async (t) => {
  let fail = true;
  let seenStateBeforeSend = false;
  const dir = tempDir(t);
  const s = setup(t, dir, ENV, ({ url }) => {
    // Mark-before-send: the key is already on disk when the request leaves.
    seenStateBeforeSend = readFileSync(join(dir, "alerts-state.json"), "utf8").includes("strong-bull");
    if (fail) throw new TypeError(`fetch failed: connect ECONNREFUSED for ${url.href}`);
    return new Response('{"ok":true}');
  });
  s.alerter.evaluate([item(row(0, 1, 0))], IV);
  s.alerter.evaluate([item(row(1, 1, 2))], IV);
  const r1 = await s.alerter.flush(undefined, T);
  assert.equal(r1.failed, 1);
  assert.ok(seenStateBeforeSend);
  assert.ok(s.logs.some((l) => l.includes("<redacted>")), "error logged with the token scrubbed");
  assert.ok(s.logs.every((l) => !l.includes(TOKEN)));
  assert.ok(!readFileSync(join(dir, "alerts-state.json"), "utf8").includes(TOKEN));

  fail = false;
  await s.alerter.flush(undefined, T + 30_000); // backoff not over yet
  assert.equal(s.sent().length, 1, "no retry before the backoff");
  const r3 = await s.alerter.flush(undefined, T + 3 * 60_000);
  assert.equal(r3.sent, 1);
  await s.alerter.flush(undefined, T + 10 * 60_000);
  assert.equal(s.sent().length, 2, "exactly one failed attempt + one successful retry");
});

test("permanent 4xx is dropped; Telegram 429 retry_after is honoured; flood is summarised", async (t) => {
  let status = 400;
  const s = setup(t, undefined, { ...ENV, ALERT_MAX_PER_CYCLE: "3" }, () => new Response(JSON.stringify({ ok: false, parameters: { retry_after: 120 } }), { status }));
  s.alerter.evaluate([item(row(0, 1, 0))], IV);
  s.alerter.evaluate([item(row(1, 1, 2))], IV);
  await s.alerter.flush(undefined, T);
  assert.equal(s.alerter.pending(), 0, "400 = bad token/chat: dropped, not retried forever");

  status = 429;
  s.alerter.evaluate([item(row(2, -1, 2))], IV);
  await s.alerter.flush(undefined, T);
  await s.alerter.flush(undefined, T + 90_000);
  assert.equal(s.sent().length, 2, "429: waits retry_after (120 s)");

  status = 200;
  const many = ["AUSDT", "BUSDT", "CUSDT", "DUSDT", "EUSDT"].flatMap((pair) => [row(20, 1, 0, { pair }), row(21, 1, 2, { pair })]);
  s.alerter.observe(many.filter((r) => r.st === 0));
  s.alerter.evaluate(many.filter((r) => r.st === 2).map((r) => item(r)), IV);
  const before = s.sent().length;
  await s.alerter.flush(undefined, T + 200_000);
  const newCalls = s.sent().length - before;
  assert.ok(newCalls <= 4, `capped at ALERT_MAX_PER_CYCLE (+ due retry), got ${newCalls}`);
});

test("alerts off without env: no state file, no requests", async (t) => {
  const dir = tempDir(t);
  const s = setup(t, dir, {});
  assert.equal(s.alerter.enabled, false);
  s.alerter.evaluate([item(row(0, 1, 0)), item(row(1, 1, 2))], IV);
  await s.alerter.flush();
  assert.equal(s.ex.calls.length, 0);
  assert.throws(() => readFileSync(join(dir, "alerts-state.json")));
});

test("legacy alert transitions and cooldowns are isolated by scoring profile", async (t) => {
  const s = setup(t);
  const custom = "custom0123456789";
  s.alerter.evaluate([item(row(0, 1, 1))], IV, T);
  s.alerter.evaluate([item(row(0, 1, 1, { cfg: custom }))], IV, T);
  assert.equal(s.alerter.evaluate([item(row(1, 1, 2))], IV, T + IV), 1);
  assert.equal(s.alerter.evaluate([item(row(1, 1, 2, { cfg: custom }))], IV, T + IV), 1);
  await s.alerter.flush(undefined, T + IV);
  assert.equal(s.sent().length, 2);
});
