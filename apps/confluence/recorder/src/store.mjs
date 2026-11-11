/**
 * store.mjs — everything the recorder keeps on disk (plain files, no database).
 *
 *   <out>/ledger/YYYY-MM.jsonl     append-only ledger rows (LedgerRow, one JSON per line), month of the BAR time
 *   <out>/ledger/YYYY-MM.ids       row ids of that file, line for line — the dedupe index
 *   <out>/rankings/YYYY-MM.jsonl   full unfiltered venue ranking per cycle
 *   <out>/derivs/YYYY-MM.jsonl     funding / open-interest snapshots (logged, never scored)
 *   <out>/candles/<src>/<tf>/<PAIR>.json   the recorder's own candle cache (≤ CANDLE_CAP bars)
 *   <out>/state.json  heartbeat.json  alerts-state.json  recorder.lock
 *
 * Crash safety: JSON documents are written to a temp file and renamed over the
 * target (atomic on NTFS, APFS and ext4). JSONL files are only ever appended,
 * one write call per batch; a line torn by a crash (no trailing newline) is cut
 * off the next time the file is opened, and the .ids index is rebuilt from the
 * .jsonl whenever their line counts disagree — so the ledger itself is always
 * the source of truth and a restart can never record a row twice.
 *
 * Windows: every path is built with path.join; file names use only [A-Z0-9_-.]
 * and timeframe folders are case-safe ("1M" month vs "1m" minute would be the
 * same folder on NTFS/APFS). rename() is retried on EPERM/EBUSY/EACCES, which
 * Windows returns while an antivirus or the app has the target open.
 */
import { appendFileSync, closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CANDLE_CAP = 2_000;

export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

/** Timeframe → folder name that cannot collide on a case-insensitive filesystem. */
export function tfDir(tf) {
  if (tf === "1M") return "1mo";
  if (!/^[0-9]{1,2}[mhdw]$/.test(tf)) throw new Error(`unsafe timeframe for a path: ${tf}`);
  return tf;
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/;
/** Exchange symbols are untrusted: same rule as the engine (A–Z, 0–9), plus Windows device names. */
export function safeFileStem(symbol) {
  if (!/^[A-Z0-9]{2,30}$/.test(symbol)) throw new Error(`unsafe symbol for a file name: ${String(symbol).slice(0, 40)}`);
  return WINDOWS_RESERVED.test(symbol) ? `_${symbol}` : symbol;
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 6 || !["EPERM", "EBUSY", "EACCES"].includes(error?.code)) throw error;
      sleepSync(40 * (attempt + 1));
    }
  }
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function writeJsonAtomic(path, value) {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  try {
    renameRetry(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Cut a torn final line (crash mid-append) so the file ends on "\n". Returns bytes removed. */
export function repairTail(path) {
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  if (size === 0) return 0;
  const fd = openSync(path, "r+");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    if (last[0] === 0x0a) return 0;
    // Scan back for the previous newline in 64 KiB steps.
    const chunk = Buffer.alloc(65_536);
    let pos = size;
    let keep = 0;
    while (pos > 0) {
      const start = Math.max(0, pos - chunk.length);
      const n = readSync(fd, chunk, 0, pos - start, start);
      const i = chunk.subarray(0, n).lastIndexOf(0x0a);
      if (i >= 0) {
        keep = start + i + 1;
        break;
      }
      pos = start;
    }
    ftruncateSync(fd, keep);
    return size - keep;
  } finally {
    closeSync(fd);
  }
}

function lines(text) {
  if (!text) return [];
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

/** Append records to a JSONL file (torn tail repaired once per file per process). */
export function createJsonlAppender() {
  const repaired = new Set();
  return (path, records) => {
    if (!records.length) return 0;
    ensureDir(dirname(path));
    if (!repaired.has(path)) {
      repairTail(path);
      repaired.add(path);
    }
    appendFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    return records.length;
  };
}

/* ------------------------------------------------------------------ *
 *  Ledger: append-only JSONL + per-month id index
 * ------------------------------------------------------------------ */
// A row id is `${cfg}|${src}|${tf}|${pair}|${t}`; toLedgerRow puts `id` first,
// so the index can be rebuilt without parsing whole rows.
const ID_AT_START = /^\{"id":"((?:[^"\\]|\\.)*)"/;
const MAX_LOADED_MONTHS = 4;

export function createLedger(outDir) {
  const dir = join(outDir, "ledger");
  const months = new Map(); // month → Set<id>, insertion order = LRU
  const append = createJsonlAppender();

  const paths = (month) => ({ rows: join(dir, `${month}.jsonl`), ids: join(dir, `${month}.ids`) });

  function rebuildIndex(month) {
    const p = paths(month);
    const rowLines = existsSync(p.rows) ? lines(readFileSync(p.rows, "utf8")) : [];
    // One index line per ledger line (also for an unreadable line) keeps the
    // line counts equal, so the rebuild is not repeated on every start.
    const ids = rowLines.map((line) => {
      const m = ID_AT_START.exec(line);
      if (m) return JSON.parse(`"${m[1]}"`);
      try {
        return String(JSON.parse(line).id ?? "#invalid");
      } catch {
        return "#invalid";
      }
    });
    writeJsonlIds(p.ids, ids);
    return ids;
  }

  function writeJsonlIds(path, ids) {
    ensureDir(dirname(path));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, ids.length ? ids.join("\n") + "\n" : "");
    renameRetry(tmp, path);
  }

  function load(month) {
    const hit = months.get(month);
    if (hit) {
      months.delete(month);
      months.set(month, hit);
      return hit;
    }
    const p = paths(month);
    repairTail(p.rows);
    repairTail(p.ids);
    let ids = existsSync(p.ids) ? lines(readFileSync(p.ids, "utf8")) : [];
    const rowCount = existsSync(p.rows) ? countNewlines(p.rows) : 0;
    if (ids.length !== rowCount) ids = rebuildIndex(month);
    const set = new Set(ids);
    months.set(month, set);
    while (months.size > MAX_LOADED_MONTHS) months.delete(months.keys().next().value);
    return set;
  }

  /** Append rows not yet recorded. Returns { written, duplicates }. */
  function record(rows) {
    const byMonth = new Map();
    for (const r of rows) {
      if (!r || typeof r.id !== "string" || !Number.isFinite(r.t)) continue;
      const m = monthOf(r.t);
      const list = byMonth.get(m);
      if (list) list.push(r);
      else byMonth.set(m, [r]);
    }
    let written = 0;
    let duplicates = 0;
    for (const [month, list] of byMonth) {
      const seen = load(month);
      const fresh = [];
      for (const r of list) {
        if (seen.has(r.id)) {
          duplicates++;
          continue;
        }
        seen.add(r.id); // also dedupes within the batch
        fresh.push(r);
      }
      if (!fresh.length) continue;
      const p = paths(month);
      // Rows first, then ids: a crash in between leaves ids < rows, which the
      // next load() detects and repairs by rebuilding from the rows.
      append(p.rows, fresh);
      appendFileSync(p.ids, fresh.map((r) => r.id).join("\n") + "\n");
      written += fresh.length;
    }
    return { written, duplicates };
  }

  function has(id, t) {
    return load(monthOf(t)).has(id);
  }

  return { record, has, dir };
}

function countNewlines(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n = 0;
    let pos = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, pos);
      if (read <= 0) break;
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) n++;
      pos += read;
    }
    return n;
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 *  Candle cache (one JSON per series, newest CANDLE_CAP bars)
 * ------------------------------------------------------------------ */
export function createCandleCache(outDir, src, tf) {
  const dir = join(outDir, "candles", src, tfDir(tf));
  const pathOf = (pair) => join(dir, `${safeFileStem(pair)}.json`);
  return {
    load(pair) {
      const doc = readJson(pathOf(pair), null);
      if (!doc || doc.schema !== 1 || !Array.isArray(doc.bars)) return [];
      const out = [];
      for (const b of doc.bars) {
        if (!Array.isArray(b) || b.length < 6 || !b.slice(0, 6).every(Number.isFinite)) continue;
        const k = { time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] };
        if (Number.isFinite(b[6])) k.takerBuy = b[6]; // v2.3 context only (taker delta), never scored
        out.push(k);
      }
      return out;
    },
    save(pair, klines) {
      const bars = klines.slice(-CANDLE_CAP).map((k) => (k.takerBuy === undefined ? [k.time, k.open, k.high, k.low, k.close, k.volume] : [k.time, k.open, k.high, k.low, k.close, k.volume, k.takerBuy]));
      ensureDir(dir);
      const path = pathOf(pair);
      const tmp = `${path}.${process.pid}.tmp`;
      // Compact (no indentation): 2,000 bars ≈ 120 KB per series.
      writeFileSync(tmp, JSON.stringify({ schema: 1, src, tf, pair, updatedAt: Date.now(), bars }));
      renameRetry(tmp, path);
    },
    dir,
  };
}

/* ------------------------------------------------------------------ *
 *  Single-instance lock
 * ------------------------------------------------------------------ */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence test (Windows too)
    return true;
  } catch (error) {
    return error?.code === "EPERM"; // exists but owned by someone else
  }
}

/** Take <out>/recorder.lock, or throw if another live recorder owns this folder. */
export function acquireLock(outDir) {
  ensureDir(outDir);
  const path = join(outDir, "recorder.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx"); // atomic create-if-absent
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => {
        const owner = readJson(path, null);
        if (owner?.pid === process.pid) rmSync(path, { force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = readJson(path, null);
      if (owner && owner.pid !== process.pid && pidAlive(owner.pid)) {
        throw new Error(`another recorder (pid ${owner.pid}) is already writing to ${outDir}`);
      }
      rmSync(path, { force: true }); // stale lock from a crashed run
    }
  }
  throw new Error(`could not take the lock in ${outDir}`);
}
