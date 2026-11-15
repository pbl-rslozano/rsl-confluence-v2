// Tests for tools/fetch-binance-archive.mjs against a local fixture server (no network).
import { createServer } from "node:http";
import { deflateRawSync, crc32 } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readZip, sha256, parseChecksum, download, listSymbols, paceFromUsedWeight } from "./fetch-binance-archive.mjs";

let passed = 0; let failed = 0;
const ok = (n, c, x = "") => { if (c) { passed++; console.log("  ok   - " + n); } else { failed++; console.log("  FAIL - " + n + (x ? "  [" + x + "]" : "")); } };

function makeZip(name, data, method = 8) {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const crc = crc32(data);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
  const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(method, 10);
  cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, body, cen, nameBuf, eocd]);
}

const csv = Buffer.from("1735689600000000,1,2,0.5,1.5,100,1735703999999999,150,10,60,90,0\n");
const good = makeZip("BTCUSDT-4h-2025-01.csv", csv);
const bad = makeZip("ETHUSDT-4h-2025-01.csv", csv);
const routes = new Map([
  ["/data/spot/monthly/klines/BTCUSDT/4h/BTCUSDT-4h-2025-01.zip", good],
  ["/data/spot/monthly/klines/BTCUSDT/4h/BTCUSDT-4h-2025-01.zip.CHECKSUM", Buffer.from(`${sha256(good)}  BTCUSDT-4h-2025-01.zip\n`)],
  ["/data/spot/monthly/klines/ETHUSDT/4h/ETHUSDT-4h-2025-01.zip", bad],
  ["/data/spot/monthly/klines/ETHUSDT/4h/ETHUSDT-4h-2025-01.zip.CHECKSUM", Buffer.from(`${"0".repeat(64)}  ETHUSDT-4h-2025-01.zip\n`)],
  ["/data/spot/monthly/klines/SOLUSDT/4h/SOLUSDT-4h-2025-01.zip", good],
  ["/list", Buffer.from("<ListBucketResult><Prefix>data/spot/monthly/klines/</Prefix><CommonPrefixes><Prefix>data/spot/monthly/klines/BTCUSDT/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>data/spot/monthly/klines/LUNAUSDT/</Prefix></CommonPrefixes><IsTruncated>false</IsTruncated></ListBucketResult>")],
  ["/api/v3/exchangeInfo", Buffer.from(JSON.stringify({ symbols: [{ symbol: "BTCUSDT", status: "TRADING" }] }))],
]);
/** v2.8 (WP19): Binance API responses carry X-MBX-USED-WEIGHT-1M; the archive bucket does not. */
let usedWeight = null;
const server = createServer((req, res) => {
  const path = req.url.split("?")[0];
  const body = routes.get(path);
  if (!body) { res.statusCode = 404; res.end(); return; }
  if (usedWeight && path.startsWith("/api/")) res.setHeader("X-MBX-USED-WEIGHT-1M", usedWeight);
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const out = mkdtempSync(join(tmpdir(), "bn-archive-"));
try {
  ok("ZIP reader extracts a deflated entry", readZip(good)[0].data.equals(csv));
  ok("ZIP reader extracts a stored entry", readZip(makeZip("a.csv", csv, 0))[0].data.equals(csv));
  let bomb = "";
  try { readZip(makeZip("big.csv", Buffer.alloc(4096, 65)), { maxTotal: 1024 }); } catch (e) { bomb = String(e); }
  ok("ZIP reader refuses entries over the inflate cap (zip bomb)", /size limit/.test(bomb), bomb);
  const { spawnSync } = await import("node:child_process");
  const { cpSync, mkdtempSync: mk } = await import("node:fs");
  const spaced = join(mk(join(tmpdir(), "with space ")), "fetch archive.mjs");
  cpSync(new URL("./fetch-binance-archive.mjs", import.meta.url), spaced);
  const run = spawnSync(process.execPath, [spaced, "--help"], { encoding: "utf8" });
  ok("runs as a script from a path with spaces", /Options:/.test(run.stdout), run.stderr.slice(0, 120));
  const badBase = spawnSync(process.execPath, [spaced, "--symbols", "BTCUSDT", "--base", "https://evil.example"], { encoding: "utf8" });
  ok("--base is limited to the archive hosts", badBase.status === 2 && /not an allowed archive host/.test(badBase.stderr));
  ok("CHECKSUM parser", parseChecksum(`${"a".repeat(64)}  X.zip`)?.file === "X.zip" && parseChecksum("junk") === null);
  const s = await download({ symbols: ["BTCUSDT"], tf: "4h", from: "2025-01", to: "2025-02", out, base, log: () => {} });
  ok("verified archive is unpacked; a missing month is reported", s.written === 1 && s.missing === 1, JSON.stringify(s));
  ok("CSV written under the replay naming scheme", readFileSync(join(out, "BTCUSDT-4h-2025-01.csv")).equals(csv));
  const again = await download({ symbols: ["BTCUSDT"], tf: "4h", from: "2025-01", to: "2025-01", out, base, log: () => {} });
  ok("existing months are skipped", again.skipped === 1 && again.written === 0);
  let err = "";
  try { await download({ symbols: ["ETHUSDT"], tf: "4h", from: "2025-01", to: "2025-01", out, base, log: () => {} }); } catch (e) { err = String(e); }
  ok("SHA-256 mismatch is an error", /mismatch/.test(err), err);
  err = "";
  try { await download({ symbols: ["SOLUSDT"], tf: "4h", from: "2025-01", to: "2025-01", out, base, log: () => {} }); } catch (e) { err = String(e); }
  ok("missing CHECKSUM refuses the archive", /CHECKSUM missing/.test(err), err);
  err = "";
  try { await download({ symbols: ["../X"], tf: "4h", from: "2025-01", to: "2025-01", out, base, log: () => {} }); } catch (e) { err = String(e); }
  ok("unsafe symbols are rejected", /Invalid symbol/.test(err));
  const list = await listSymbols({ listBase: `${base}/list`, infoBase: base });
  ok("archive listing keeps delisted symbols and marks them", list.length === 2 && list.find((x) => x.symbol === "LUNAUSDT")?.delisted === true && list.find((x) => x.symbol === "BTCUSDT")?.delisted === false, JSON.stringify(list));
  // v2.8 (WP19): pacing on Binance's used-weight header (Node fetch reads it).
  ok("WP19 paceFromUsedWeight('5000') > 0, ('100') === 0, (null) === 0", paceFromUsedWeight("5000") > 0 && paceFromUsedWeight("100") === 0 && paceFromUsedWeight(null) === 0);
  ok("WP19 paceFromUsedWeight: 80% of 6,000 → 0; the limit → 60 s", paceFromUsedWeight("4800") === 0 && paceFromUsedWeight("6000") === 60_000);
  let t0 = Date.now();
  await listSymbols({ listBase: `${base}/list`, infoBase: base });
  ok("WP19 no used-weight header → only the fixed pacing", Date.now() - t0 < 1_000, String(Date.now() - t0));
  usedWeight = "4830"; // 30 of 1,200 over the 80% threshold → 1.5 s
  t0 = Date.now();
  await listSymbols({ listBase: `${base}/list`, infoBase: base });
  ok("WP19 a used-weight reading above 80% pauses before the next request", Date.now() - t0 >= 1_400, String(Date.now() - t0));
  usedWeight = null;
} finally {
  server.close();
  rmSync(out, { recursive: true, force: true });
}
console.log(`\nArchive downloader: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
