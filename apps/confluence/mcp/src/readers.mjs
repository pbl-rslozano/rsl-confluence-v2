/**
 * readers.mjs — parse the recorder folder and app exports into LedgerRow
 * objects and candle series. Everything here is read-only.
 *
 * Accepted ledger inputs
 *   ledger/YYYY-MM.jsonl        one LedgerRow JSON per line (recorder)
 *   exports/**.csv              app "Export CSV": LEDGER_CSV_COLUMNS + net_return_h1..h24
 *   exports/**.json             app "Export JSON": { format: "rsl-signal-ledger", rows: [...] }
 *   exports/**.jsonl            LedgerRow per line
 *   any of the above via the `file` argument of a tool (path inside the data dir)
 *
 * Candle cache (format still settling in the recorder, so parsing is tolerant)
 *   candles/<src>/<tf>/<PAIR>.json            or  …/<PAIR>/<YYYY-MM>.json chunks
 *   candles/<src>_<tf>_<PAIR>.json            (also ':' separated)
 *   content: [bar…] | { klines|candles|bars|data: [bar…], source?, interval?, symbol? }
 *   bar:     { time|t|openTime, open|o, high|h, low|l, close|c, volume|v }
 *            or [time, open, high, low, close, volume, …] (numbers or numeric strings)
 */
import { createReadStream, openSync, readSync, closeSync, statSync } from "node:fs";
import { createInterface } from "node:readline";

/* ------------------------------------------------------------------ *
 *  Ledger rows
 * ------------------------------------------------------------------ */
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isStr = (v) => typeof v === "string" && v.length > 0 && v.length <= 512;

/** Return a LedgerRow when the object carries the fields the analysis needs, else null. */
export function normaliseRow(o) {
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  if (!isStr(o.id) || !isStr(o.cfg) || !isStr(o.src) || !isStr(o.tf) || !isStr(o.pair)) return null;
  if (!isNum(o.t) || !isNum(o.sc) || !isNum(o.wb)) return null;
  if (o.m !== -1 && o.m !== 0 && o.m !== 1) return null;
  if (o.st !== 0 && o.st !== 1 && o.st !== 2) return null;
  const row = { ...o };
  row.ac = isStr(o.ac) ? o.ac : "unknown";
  row.sup = o.sup ? 1 : 0;
  row.uc = o.uc ? 1 : 0;
  row.live = o.live ? 1 : 0;
  if (!Array.isArray(row.bl)) row.bl = [];
  if (!isNum(row.tc)) row.tc = 0;
  if (!isNum(row.rec)) row.rec = 0;
  return row;
}

/** Stream a JSONL file; returns parsed objects and the number of unparseable lines. */
export async function readJsonl(abs, { maxBytes, maxItems = Infinity, map = (x) => x } = {}) {
  const size = statSync(abs).size;
  if (maxBytes && size > maxBytes) throw new Error(`File too large (${size} bytes > ${maxBytes})`);
  const items = [];
  let bad = 0;
  let truncated = false;
  const rl = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    if (items.length >= maxItems) { truncated = true; break; }
    let parsed;
    try { parsed = JSON.parse(line); } catch { bad++; continue; }
    const v = map(parsed);
    if (v == null) bad++; else items.push(v);
  }
  rl.close();
  return { items, bad, truncated };
}

/* ---------------- CSV ---------------- */
/** Undo the Core Kit's formula-injection guard (a leading apostrophe before = + - @ or a control char). */
const unsafeCell = (s) => (/^'[=+\-@\u0000-\u001F]/.test(s) ? s.slice(1) : s);

/** Minimal RFC 4180 parser over a stream; calls onRecord(fields[]) per record. */
async function streamCsv(abs, onRecord) {
  let field = "";
  let record = [];
  let inQuotes = false;
  let pendingQuote = false; // saw a quote inside quotes; next char decides
  let first = true;
  const endField = () => { record.push(field); field = ""; };
  const endRecord = () => { endField(); const r = record; record = []; return onRecord(r); };
  for await (let chunk of createReadStream(abs, { encoding: "utf8", highWaterMark: 1 << 20 })) {
    if (first) { chunk = chunk.replace(/^﻿/, ""); first = false; }
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];
      if (inQuotes) {
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') { field += '"'; continue; }
          inQuotes = false; // closing quote; fall through to normal handling
        } else if (ch === '"') { pendingQuote = true; continue; } else { field += ch; continue; }
      }
      if (ch === '"' && field === "") { inQuotes = true; continue; }
      if (ch === ",") { endField(); continue; }
      if (ch === "\r") continue;
      if (ch === "\n") { if (endRecord() === false) return; continue; }
      field += ch;
    }
  }
  if (pendingQuote) inQuotes = false;
  if (field !== "" || record.length) endRecord();
}

const DIR = { BUY: 1, SELL: -1, NEUTRAL: 0 };
const STRENGTH = { WEAK: 0, MODERATE: 1, STRONG: 2 };
const numOr = (s, d = 0) => (s === "" || s == null ? d : Number.isFinite(Number(s)) ? Number(s) : d);
const numOrNull = (s) => (s === "" || s == null || !Number.isFinite(Number(s)) ? null : Number(s));
const ms = (s) => { if (!s) return 0; const v = Date.parse(s); return Number.isFinite(v) ? v : 0; };

/**
 * Map one CSV record (by header position) to a LedgerRow. Header names come
 * from LEDGER_CSV_COLUMNS; `universe_rank` appears twice in the v2.3 list
 * (rk, then the unfiltered rank rku), so duplicates are told apart by occurrence.
 */
function csvRecordToRow(header, rec) {
  const get = (name, occurrence = 0) => {
    let seen = 0;
    for (let i = 0; i < header.length; i++) {
      if (header[i] === name) { if (seen === occurrence) return unsafeCell(rec[i] ?? ""); seen++; }
    }
    return undefined;
  };
  const dir = DIR[get("direction")];
  const st = STRENGTH[get("strength")];
  const row = {
    id: get("id"), cfg: get("config_id"), ev: get("engine_version") ?? "", app: get("app_version") ?? "",
    src: get("source"), tf: get("timeframe"), pair: get("pair"), ac: get("asset_class") || "unknown",
    t: ms(get("bar_open_utc")), tc: ms(get("bar_close_utc")), rec: ms(get("recorded_utc")),
    c: numOr(get("close")), sc: numOr(get("score"), NaN), m: dir, st,
    sup: numOr(get("suppressed")) ? 1 : 0, lv: numOr(get("low_volatility")) ? 1 : 0,
    v: numOr(get("valid_voters")), bu: numOr(get("bull")), be: numOr(get("bear")),
    er: numOrNull(get("efficiency_ratio")),
    bl: ["bloc_trend", "bloc_mean_reversion", "bloc_breakout", "bloc_flow"].map((c) => numOrNull(get(c))).filter((v) => v !== null),
    rk: numOr(get("universe_rank")), qv: numOr(get("quote_volume_24h")),
    rd: numOr(get("reversal_dir")), rc: numOr(get("reversal_conf")), wb: numOr(get("warm_bars"), NaN),
    live: numOr(get("live")) ? 1 : 0, uc: numOr(get("underlying_closed")) ? 1 : 0,
  };
  const rku = get("universe_rank", 1) ?? get("universe_rank_full") ?? get("universe_rank_unfiltered");
  if (rku !== undefined && rku !== "") row.rku = numOr(rku);
  const optional = [["rank_source", "rks", String], ["rs_percentile", "rs", numOrNull], ["btc_beta", "beta", numOrNull],
    ["htf_trend", "htf", numOrNull], ["taker_delta", "td", numOrNull], ["macro_event_hours", "mev", numOrNull],
    ["basis_pct", "bp", numOrNull], ["band_pinned", "pin", numOrNull], ["split_muted", "spl", numOrNull], ["earnings_window", "earn", numOrNull]];
  for (const [col, key, conv] of optional) {
    const v = get(col);
    if (v !== undefined && v !== "") row[key] = conv(v);
  }
  const net = {};
  header.forEach((h, i) => {
    const m = /^net_return_h(\d+)$/.exec(h);
    if (m && rec[i] !== "" && rec[i] !== undefined && Number.isFinite(Number(rec[i]))) net[m[1]] = Number(rec[i]);
  });
  const out = normaliseRow(row);
  if (out && Object.keys(net).length) out.xnet = net; // exported net returns (app costs at export time)
  return out;
}

export async function readLedgerCsv(abs, { maxBytes, maxItems = Infinity } = {}) {
  const size = statSync(abs).size;
  if (maxBytes && size > maxBytes) throw new Error(`File too large (${size} bytes > ${maxBytes})`);
  let header = null;
  const items = [];
  let bad = 0;
  let truncated = false;
  await streamCsv(abs, (rec) => {
    if (!header) {
      // An optional notice line may precede the header (Core Kit `notice`).
      if (rec.includes("id") && rec.includes("config_id")) header = rec.map((h) => unsafeCell(h.trim()));
      return true;
    }
    if (rec.length === 1 && rec[0] === "") return true;
    if (items.length >= maxItems) { truncated = true; return false; }
    const row = csvRecordToRow(header, rec);
    if (row) items.push(row); else bad++;
    return true;
  });
  if (!header) throw new Error("Not a ledger CSV (no id/config_id header)");
  return { items, bad, truncated };
}

export function parseLedgerJson(text) {
  const doc = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : doc && doc.format === "rsl-signal-ledger" && Array.isArray(doc.rows) ? doc.rows : null;
  if (!list) throw new Error('Not a ledger JSON export (expected { format: "rsl-signal-ledger", rows: [...] })');
  const items = [];
  let bad = 0;
  for (const o of list) { const r = normaliseRow(o); if (r) items.push(r); else bad++; }
  return { items, bad, truncated: false, meta: Array.isArray(doc) ? {} : { app: doc.app, configId: doc.configId, source: doc.source, timeframe: doc.timeframe, costs: doc.costs } };
}

/* ------------------------------------------------------------------ *
 *  Candles
 * ------------------------------------------------------------------ */
const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const toNum = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
function toTime(v) {
  if (typeof v === "string" && !/^\d+(\.\d+)?$/.test(v.trim())) { const p = Date.parse(v); return Number.isFinite(p) ? p : NaN; }
  const n = toNum(v);
  if (!Number.isFinite(n)) return NaN;
  return n < 1e11 ? n * 1000 : n; // seconds → ms
}

/** Normalise any supported bar shape to a Kline or null. */
export function toKline(b) {
  let time, open, high, low, close, volume;
  if (Array.isArray(b)) [time, open, high, low, close, volume] = b;
  else if (b && typeof b === "object") {
    time = pick(b, ["time", "t", "openTime", "ts", "T"]);
    open = pick(b, ["open", "o"]); high = pick(b, ["high", "h"]); low = pick(b, ["low", "l"]);
    close = pick(b, ["close", "c"]); volume = pick(b, ["volume", "v"]);
  } else return null;
  const k = { time: toTime(time), open: toNum(open), high: toNum(high), low: toNum(low), close: toNum(close), volume: toNum(volume ?? 0) };
  if (!Number.isFinite(k.time) || !(k.open > 0) || !(k.high > 0) || !(k.low > 0) || !(k.close > 0)) return null;
  if (!Number.isFinite(k.volume)) k.volume = 0;
  return k;
}

/** Parse a candle document. Returns { meta, bars }. */
export function parseCandleDoc(text, isJsonl = false) {
  if (isJsonl) {
    const bars = [];
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s) continue;
      try { const k = toKline(JSON.parse(s)); if (k) bars.push(k); } catch { /* skip */ }
    }
    return { meta: {}, bars };
  }
  const doc = JSON.parse(text);
  const list = Array.isArray(doc) ? doc : doc && typeof doc === "object" ? pick(doc, ["klines", "candles", "bars", "data", "k"]) : null;
  const meta = doc && !Array.isArray(doc) && typeof doc === "object"
    ? { src: pick(doc, ["source", "src"]), tf: pick(doc, ["interval", "tf", "timeframe"]), pair: pick(doc, ["symbol", "pair"]) }
    : {};
  const bars = [];
  if (Array.isArray(list)) for (const b of list) { const k = toKline(b); if (k) bars.push(k); }
  return { meta, bars };
}

const CHUNK = /^\d{4}-\d{2}(-\d{2})?$/;
/** Derive { src, tf, pair } from a path relative to candles/ (null when ambiguous). */
export function candleMetaFromPath(relUnderCandles) {
  const parts = relUnderCandles.replace(/\.(jsonl?|JSONL?)$/, "").split("/").filter(Boolean);
  if (parts.length && CHUNK.test(parts[parts.length - 1])) parts.pop();
  // Recorder layout (apps/confluence/recorder/src/store.mjs): monthly bars live
  // under "1mo" (no clash with "1m" on case-insensitive disks) and Windows
  // device names get a leading "_" (e.g. "_CON").
  const tfOf = (tf) => (tf === "1mo" ? "1M" : tf);
  const pairOf = (p) => p.toUpperCase().replace(/^_(?=(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$)/, "");
  if (parts.length >= 3) {
    const [src, tf, pair] = parts.slice(-3);
    return { src: src.toLowerCase(), tf: tfOf(tf), pair: pairOf(pair) };
  }
  const tokens = parts.join("_").split(/[_:]/).filter(Boolean);
  if (tokens.length === 3) return { src: tokens[0].toLowerCase(), tf: tfOf(tokens[1]), pair: pairOf(tokens[2]) };
  return null;
}

export const seriesKey = (src, tf, pair) => `${String(src).toLowerCase()}|${tf}|${String(pair).toUpperCase()}`;

/** Merge bars by time (later files win, like mergeKlines in the app) and sort. */
export function mergeBars(groups) {
  const byTime = new Map();
  for (const g of groups) for (const b of g) byTime.set(b.time, b);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/* ------------------------------------------------------------------ *
 *  Tail of a file (newest JSONL record) without reading it all
 * ------------------------------------------------------------------ */
export function tailLines(abs, maxBytes = 256 * 1024) {
  const size = statSync(abs).size;
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(abs, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  let lines = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
  if (len < size && lines.length) lines = lines.slice(1); // first line may be cut
  return lines;
}
