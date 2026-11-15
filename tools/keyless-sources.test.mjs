// Tests for release check R20 (tools/checks/keyless-sources.mjs) — v2.8 (WP26): the path scan covers every
// relayed host (Coins.ph and Upbit), the OKX module is a public-source module, and no new source carries a
// private-API profile.
//   node --test tools/keyless-sources.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkKeylessSources, ROOT } from "./checks/keyless-sources.mjs";

const LIB = "apps/confluence/web/src/lib";
const FILES = [`${LIB}/coinsph.ts`, `${LIB}/public-hosts.ts`, `${LIB}/native-relay.ts`, `${LIB}/okx.ts`, `${LIB}/market-client.ts`, `${LIB}/private-api.ts`];

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), "r20-"));
  try {
    for (const f of FILES) { mkdirSync(dirname(join(dir, f)), { recursive: true }); cpSync(join(ROOT, f), join(dir, f)); }
    for (const [p, src] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), src); }
    return fn(checkKeylessSources(dir), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("R20 passes on the current tree", () => {
  const r = checkKeylessSources();
  assert.deepEqual(r.findings, []);
});

test("R20 passes on the fixture copy (baseline)", () => withFixture({}, (r) => assert.deepEqual(r.findings, [])));

const UPBIT_BAD = {
  "template after the proxy prefix": "fetch(`${UPBIT_PROXY_PREFIX}/v1/orders?state=wait`)",
  "template after the origin": "fetch(`${UPBIT_ORIGIN}/v1/accounts`)",
  "plain string": 'relayGet(rule, prefix, "/v1/withdraws/krw")',
  "single-quoted": "get('/v1/deposits')",
  "an unlisted public path": 'get("/v1/status/wallet")',
  "a near miss of a listed path": 'get("/v1/tickerx")',
};
for (const [name, src] of Object.entries(UPBIT_BAD)) {
  test(`R20 flags an Upbit path outside UPBIT_READ_PATHS: ${name}`, () =>
    withFixture({ [`${LIB}/bad-upbit.ts`]: `export const x = () => ${src};\n` }, (r) => {
      assert.equal(r.ok, false);
      assert.ok(r.findings.some((f) => f.startsWith(`${LIB}/bad-upbit.ts: Upbit path /v1/`) && f.endsWith("outside the read allowlist")), r.findings.join("\n"));
    }));
}

test("R20 allows the Upbit read paths, including a template under the candles prefix", () =>
  withFixture({
    [`${LIB}/good-upbit.ts`]: [
      'get("/v1/market/all")', 'get("/v1/ticker/all?quote_currencies=KRW")', 'get("/v1/ticker?markets=KRW-BTC")',
      'get("/v1/orderbook?markets=KRW-BTC")', "get(`/v1/candles/minutes/240?market=${m}`)", "get(`/v1/candles/${unit}?market=${m}`)",
      "get(`${UPBIT_PROXY_PREFIX}/v1/candles/days?market=KRW-BTC`)",
    ].map((l) => `export const a${Math.random().toString(36).slice(2)} = () => ${l};`).join("\n"),
  }, (r) => assert.deepEqual(r.findings, [])));

test("R20 still flags a Coins.ph path outside its allowlist", () =>
  withFixture({ [`${LIB}/bad-coinsph.ts`]: 'export const x = "/openapi/v1/order";\n' }, (r) =>
    assert.ok(r.findings.some((f) => f === `${LIB}/bad-coinsph.ts: Coins.ph path /openapi/v1/order outside the read allowlist`), r.findings.join("\n"))));

test("R20 ignores Upbit-looking paths in test files and comments", () =>
  withFixture({
    [`${LIB}/x.test.mjs`]: 'get("/v1/accounts")\n',
    [`${LIB}/commented.ts`]: '// relayGet(rule, p, "/v1/orders")\n/* "/v1/accounts" */\nexport const y = 1;\n',
  }, (r) => assert.deepEqual(r.findings, [])));

test("R20 flags a privateApi profile on a new source", () =>
  withFixture({}, (r0, dir) => {
    const p = join(dir, `${LIB}/market-client.ts`);
    writeFileSync(p, readFileSync(p, "utf8").replace('label: "OKX Perpetual",', 'label: "OKX Perpetual",\n    privateApi: "okx",'));
    const r = checkKeylessSources(dir);
    assert.ok(r.findings.includes("market-client.ts: okx-perp has a privateApi profile"), r.findings.join("\n"));
  }));

test("R20 flags the private-API code mentioning a new venue", () =>
  withFixture({}, (r0, dir) => {
    const p = join(dir, `${LIB}/private-api.ts`);
    writeFileSync(p, readFileSync(p, "utf8") + '\nexport const OKX_PROVIDER = "okx";\n');
    const r = checkKeylessSources(dir);
    assert.ok(r.findings.some((f) => f.startsWith(`${LIB}/private-api.ts: mentions OKX`)), r.findings.join("\n"));
  }));

test("R20 flags key handling in the OKX module", () =>
  withFixture({}, (r0, dir) => {
    const p = join(dir, `${LIB}/okx.ts`);
    writeFileSync(p, readFileSync(p, "utf8") + '\nconst h = { "OK-ACCESS-SIGN": sign(secret) };\n');
    const r = checkKeylessSources(dir);
    assert.ok(r.findings.includes(`${LIB}/okx.ts: key/signature/auth handling in a public source`), r.findings.join("\n"));
  }));
