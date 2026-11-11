// Egress control (ADR-0003 / ADR-0008): static source scan + runtime guard.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkEgress, formatEgressFindings } from "../../../../tools/check-egress.mjs";
import { createGuardedFetch, EgressBlockedError, loadRecorderManifest, makeRedactor } from "../src/net.mjs";
import { tempDir } from "./fixtures.mjs";

// Built at runtime so this test file itself contains no unlisted URL literal.
const SCHEME = "https" + "://";
const EVIL = "tracker.evil-cdn" + ".io";

test("the repository's recorder (and mcp) sources pass the egress check", () => {
  const r = checkEgress({ processes: ["recorder", "mcp"] });
  assert.equal(r.ok, true, formatEgressFindings(r));
  assert.ok(r.scanned > 5);
  assert.deepEqual(r.cspDrift, []);
});

test("check-egress fails on an unlisted host and on a runtime-built host", (t) => {
  const dir = tempDir(t);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "leak.mjs"), [
    `const ok = "${SCHEME}api.bybit.com/v5/market/tickers";`,
    `const bad = "${SCHEME}${EVIL}/collect?x=1";`,
    "const dyn = `" + SCHEME + "${host}/x`;",
    `const fixture = "${SCHEME}hooks.example.test/ok"; // RFC 6761 test TLD: allowed`,
  ].join("\n"));
  const r = checkEgress({ processes: ["recorder"], roots: { recorder: [dir] } });
  assert.equal(r.ok, false);
  assert.deepEqual(r.findings.map((f) => [f.line, f.host]), [[2, EVIL], [3, "${host}"]]);
  assert.match(formatEgressFindings(r), new RegExp(EVIL.replace(/\./g, "\\.")));
});

test("runtime guard: only https to manifest hosts; the base fetch is never reached otherwise", async () => {
  const manifest = loadRecorderManifest();
  assert.deepEqual(manifest.hosts, ["data-api.binance.vision", "api.bybit.com", "api.bitget.com"]);
  assert.ok(manifest.conditionalHosts.includes("api.telegram.org"));
  let reached = 0;
  const guard = createGuardedFetch({ baseFetch: async () => { reached++; return new Response("[]"); }, hosts: manifest.hosts });
  for (const url of [`${SCHEME}${EVIL}/x`, "http://api.bybit.com/v5/market/tickers", `${SCHEME}api.bybit.com:8443/x`, `${SCHEME}api.telegram.org/botX/sendMessage`]) {
    await assert.rejects(guard.fetch(url), EgressBlockedError, url);
  }
  assert.equal(reached, 0);
  assert.equal(guard.stats.blocked, 4);
  await guard.fetch(`${SCHEME}api.bybit.com/v5/market/time`);
  assert.equal(reached, 1);
  guard.allowHost("api.telegram.org"); // what the recorder does when Telegram env is set
  await guard.fetch(`${SCHEME}api.telegram.org/botX/sendMessage`, { method: "POST", body: "{}" });
  assert.equal(reached, 2);
});

test("runtime guard memo replays one payload to a second reader; timeouts abort hung requests", async () => {
  let calls = 0;
  const url = `${SCHEME}api.bybit.com/v5/market/tickers?category=linear`;
  const guard = createGuardedFetch({
    baseFetch: async (_u, init) => {
      calls++;
      if (_u.includes("hang")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      return new Response(JSON.stringify({ n: calls }), { headers: { "content-type": "application/json" } });
    },
    hosts: ["api.bybit.com"],
    timeoutMs: 50,
  });
  guard.memoize(url);
  assert.deepEqual(await (await guard.fetch(url)).json(), { n: 1 });
  assert.deepEqual(await (await guard.fetch(url)).json(), { n: 1 });
  assert.equal(calls, 1);
  guard.clearMemo();
  assert.deepEqual(await (await guard.fetch(url)).json(), { n: 2 });
  // AbortSignal.timeout's timer is unref'd (a real hung socket keeps the loop alive); hold the loop here.
  const keepAlive = setTimeout(() => {}, 5_000);
  await assert.rejects(guard.fetch(`${SCHEME}api.bybit.com/hang`), (e) => e.name === "TimeoutError");
  clearTimeout(keepAlive);
});

test("redactor scrubs configured secrets and any bot-token shape", () => {
  const redact = makeRedactor(["https://hooks.example.test/T1/super-secret"]);
  const text = redact(new Error("POST https://hooks.example.test/T1/super-secret failed; bot123456789:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK"));
  assert.ok(!text.includes("super-secret"));
  assert.ok(!text.includes("AAAbbb"));
  assert.match(text, /<redacted>.*<redacted>/);
});
