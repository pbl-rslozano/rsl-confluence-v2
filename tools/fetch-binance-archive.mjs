#!/usr/bin/env node
// fetch-binance-archive.mjs — v2.3 checksummed downloader for Binance public
// kline archives (data.binance.vision), for the replay/backtest tool.
//
//   node tools/fetch-binance-archive.mjs --symbols BTCUSDT,ETHUSDT --tf 4h --from 2024-01 --to 2026-09 --out ./klines
//   node tools/fetch-binance-archive.mjs --list --market spot          # every symbol ever archived, delisted ones marked
//
// • Every monthly ZIP is verified against its published .CHECKSUM (SHA-256)
//   before it is unpacked; a mismatch is an error, never a warning.
// • ZIPs are read with a minimal built-in reader (stored / deflate entries),
//   so no unzip dependency is needed. Only the CSV entry is written; entry
//   names are reduced to a basename (no path traversal).
// • `--list` reads the archive bucket listing, which keeps delisted symbols:
//   replaying only today's exchangeInfo symbols is survivorship bias.
//   Symbols missing from today's exchangeInfo are marked DELISTED.
// • Output files are named SYMBOL-INTERVAL-YYYY-MM.csv, the layout
//   replay.cli.mjs --csv-dir expects (µs timestamps are handled there).
//
// Network: data.binance.vision, the archive bucket listing host and
// data-api.binance.vision (exchangeInfo for --list). Node tool only — the app
// never contacts these hosts (ADR-0003 addendum). Not financial advice.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"]);
    return acc;
  }, []),
);
// The command line may only point at the archive hosts in tools/egress-manifest.json
// (review S3); tests pass other bases through the function arguments.
const ALLOWED_BASES = ["https://data.binance.vision", "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision", "https://data-api.binance.vision"];
const cliBase = (v, d) => {
  const b = String(v ?? d).replace(/\/$/, "");
  if (!ALLOWED_BASES.includes(b)) { console.error(`fetch-binance-archive: ${b} is not an allowed archive host`); process.exit(2); }
  return b;
};
const BASE = cliBase(args.base, "https://data.binance.vision");
const LIST_BASE = cliBase(args["list-base"], "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision");
const INFO_BASE = cliBase(args["info-base"], "https://data-api.binance.vision");
/** Limits: a monthly 1m archive is < 100 MB; anything larger is refused. */
const MAX_DOWNLOAD = 256 * 1024 * 1024;
const MAX_INFLATED = 1024 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const MARKET = args.market === "futures" ? "futures/um" : "spot";
const SAFE = /^[A-Z0-9]{2,30}$/;
const TF = /^(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1mo)$/;

if (args.help || args.h) {
  console.log(`Options:
  --symbols BTCUSDT,ETHUSDT   symbols to download
  --tf 4h                     kline interval (1m … 1w, 1mo)
  --from 2024-01 --to 2026-09 months, inclusive (UTC)
  --market spot|futures       spot (default) or USDⓈ-M futures
  --out ./klines              output folder
  --list                      list archived symbols (delisted marked) and exit`);
  process.exit(0);
}

/* ---------------- minimal ZIP reader ---------------- */
/**
 * Extract entries from a ZIP buffer (central directory; stored + deflate).
 * `want` stops at the first matching entry; total inflated output is capped.
 */
export function readZip(buf, { want = () => true, maxTotal = MAX_INFLATED } = {}) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP: bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (size > maxTotal - total) throw new Error(`ZIP: ${name} exceeds the size limit`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("ZIP: bad local header");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: Math.max(1, Math.min(size, maxTotal - total)) });
    else throw new Error(`ZIP: unsupported compression method ${method}`);
    if (data.length !== size) throw new Error(`ZIP: size mismatch for ${name}`);
    total += data.length;
    out.push({ name, data });
    if (want !== readZip.all) break; // first match only
  }
  return out;
}

readZip.all = () => true;
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
/** Parse a data.binance.vision .CHECKSUM file ("<hex>  <file name>"). */
export function parseChecksum(text) {
  const m = /^([0-9a-f]{64})\s+\*?(\S+)/i.exec(String(text).trim());
  return m ? { hash: m[1].toLowerCase(), file: m[2] } : null;
}

function months(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const out = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) out.push(`${y}-${String(m).padStart(2, "0")}`);
  return out;
}

/**
 * v2.8 (WP19): ms to wait before the next request for a Binance X-MBX-USED-WEIGHT-1M reading
 * (documented as X-MBX-USED-WEIGHT-(intervalNum)(intervalLetter)): 0 at or below 80% of `limit`,
 * rising linearly to a full minute at the limit; a missing or unreadable header is 0. Same rule as
 * paceFromUsedWeight in apps/confluence/web/src/lib/market-client.ts (parity is tested there).
 * The archive bucket sends no such header; the API mirror (exchangeInfo) does.
 */
export function paceFromUsedWeight(header, limit = 6000) {
  if (header == null || String(header).trim() === "") return 0;
  const used = Number(header);
  if (!Number.isFinite(used) || used < 0 || !(limit > 0)) return 0;
  const start = limit * 0.8;
  if (used <= start) return 0;
  return Math.min(60_000, Math.ceil(((used - start) / (limit - start)) * 60_000));
}

async function get(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  const pause = paceFromUsedWeight(res.headers.get("x-mbx-used-weight-1m"));
  const paced = async (v) => { if (pause > 0) await new Promise((r) => setTimeout(r, pause)); return v; }; // above 80%: wait before the next request
  if (res.status === 404) return paced(null);
  if (res.status === 429 || res.status === 418) throw new Error(`Rate limited (${res.status}) — stop and retry later.`);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > MAX_DOWNLOAD) throw new Error(`${url}: ${len} bytes exceeds the download limit`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error(`${url}: exceeds the download limit`);
  return paced(buf);
}

export async function download({ symbols, tf, from, to, out, base = BASE, market = MARKET, log = console.log }) {
  if (!TF.test(tf)) throw new Error(`Invalid interval ${tf}`);
  mkdirSync(out, { recursive: true });
  const summary = { written: 0, missing: 0, skipped: 0 };
  for (const symbol of symbols) {
    if (!SAFE.test(symbol)) throw new Error(`Invalid symbol ${symbol}`);
    for (const month of months(from, to)) {
      const file = `${symbol}-${tf}-${month}.zip`;
      const target = join(out, `${symbol}-${tf}-${month}.csv`);
      if (existsSync(target)) { summary.skipped++; continue; }
      const url = `${base}/data/${market}/monthly/klines/${symbol}/${tf}/${file}`;
      const zip = await get(url);
      if (!zip) { summary.missing++; log(`  – ${file} not archived`); continue; }
      const sumText = await get(`${url}.CHECKSUM`);
      const sum = sumText ? parseChecksum(sumText.toString("utf8")) : null;
      if (!sum) throw new Error(`${file}: CHECKSUM missing or unreadable — refusing to use an unverified archive`);
      if (sum.file !== file) throw new Error(`${file}: CHECKSUM names ${sum.file}`);
      const actual = sha256(zip);
      if (actual !== sum.hash) throw new Error(`${file}: SHA-256 mismatch (expected ${sum.hash}, got ${actual})`);
      const csv = readZip(zip, { want: (n) => basename(n).toLowerCase().endsWith(".csv") })[0];
      if (!csv) throw new Error(`${file}: no CSV entry`);
      writeFileSync(target, csv.data);
      summary.written++;
      log(`  ✓ ${file} (sha256 ok)`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  return summary;
}

/** Every symbol in the archive listing; those absent from today's exchangeInfo are delisted. */
export async function listSymbols({ listBase = LIST_BASE, infoBase = INFO_BASE, market = MARKET } = {}) {
  const prefix = `data/${market}/monthly/klines/`;
  const symbols = new Set();
  let marker = "";
  for (let guard = 0; guard < 100; guard++) {
    const xml = (await get(`${listBase}?delimiter=/&prefix=${encodeURIComponent(prefix)}${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`))?.toString("utf8") ?? "";
    const found = [...xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix);
    for (const p of found) { const s = p.slice(prefix.length).replace(/\/$/, ""); if (SAFE.test(s)) symbols.add(s); }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !found.length) break;
    marker = found[found.length - 1];
  }
  let live = null;
  if (market === "spot") {
    const info = await get(`${infoBase}/api/v3/exchangeInfo?permissions=SPOT`);
    if (info) live = new Set((JSON.parse(info.toString("utf8")).symbols ?? []).filter((s) => s.status === "TRADING").map((s) => s.symbol));
  }
  return [...symbols].sort().map((s) => ({ symbol: s, delisted: live ? !live.has(s) : null }));
}

// pathToFileURL handles spaces and Windows drive letters (review C13).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    if (args.list) {
      const list = await listSymbols();
      for (const s of list) console.log(`${s.symbol}${s.delisted ? "  DELISTED" : ""}`);
      console.log(`${list.length} archived symbols, ${list.filter((s) => s.delisted).length} delisted.`);
    } else {
      const symbols = String(args.symbols ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!symbols.length) throw new Error("Pass --symbols (see --help).");
      const s = await download({
        symbols, tf: args.tf ?? "4h", from: args.from ?? "2024-01", to: args.to ?? new Date().toISOString().slice(0, 7),
        out: resolve(args.out ?? "klines"),
      });
      console.log(`${s.written} written, ${s.skipped} already present, ${s.missing} not archived.`);
    }
  } catch (error) {
    console.error(`fetch-binance-archive: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
