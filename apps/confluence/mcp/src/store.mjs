/**
 * store.mjs — cached, read-only view of the data directory.
 *
 * Files are re-read only when their size or mtime changes, so the recorder's
 * current month (which grows) is picked up and old months stay cached.
 */
import { readJsonl, readLedgerCsv, parseLedgerJson, normaliseRow, parseCandleDoc, candleMetaFromPath, seriesKey, mergeBars } from "./readers.mjs";
import { PathError } from "./data-dir.mjs";

const LEDGER_FILE = /\.jsonl$/i;
const EXPORT_FILE = /\.(csv|json|jsonl)$/i;
const CANDLE_FILE = /\.(json|jsonl)$/i;

export class LedgerStore {
  /** @param {import("./data-dir.mjs").DataDir} dataDir */
  constructor(dataDir) {
    this.dir = dataDir;
    this.fileCache = new Map(); // abs → { sig, items, bad, truncated, format }
    this.candleCache = new Map(); // abs → { sig, meta, bars }
  }

  async readLedgerFile(file) {
    const sig = `${file.size}:${file.mtimeMs}`;
    const hit = this.fileCache.get(file.abs);
    if (hit && hit.sig === sig) return hit;
    const L = this.dir.limits;
    let res;
    let format;
    if (/\.csv$/i.test(file.abs)) { format = "csv"; res = await readLedgerCsv(file.abs, { maxBytes: L.maxStreamBytes, maxItems: L.maxRows }); }
    else if (/\.jsonl$/i.test(file.abs)) { format = "jsonl"; res = await readJsonl(file.abs, { maxBytes: L.maxStreamBytes, maxItems: L.maxRows, map: normaliseRow }); }
    else if (/\.json$/i.test(file.abs)) {
      format = "json";
      if (file.size > L.maxJsonBytes) throw new PathError(`File too large (${file.size} bytes > ${L.maxJsonBytes}): ${file.rel}`);
      res = parseLedgerJson(this.dir.readText(file.rel, L.maxJsonBytes));
    } else throw new PathError(`Unsupported ledger file type: ${file.rel} (use .jsonl, .csv or .json)`);
    const entry = { sig, format, ...res };
    this.fileCache.set(file.abs, entry);
    return entry;
  }

  /** Files that make up the ledger: one explicit file, or ledger/** plus exports/**. */
  ledgerFiles(file) {
    if (file) {
      const st = this.dir.statFile(file);
      if (!st) throw new PathError(`File not found in the data directory: ${file}`);
      return { files: [{ ...st, rel: this.dir.rel(st.abs) }], truncated: false };
    }
    const a = this.dir.walk("ledger", (n) => LEDGER_FILE.test(n));
    const b = this.dir.walk("exports", (n) => EXPORT_FILE.test(n));
    return { files: [...a.files, ...b.files], truncated: a.truncated || b.truncated };
  }

  /**
   * Load every ledger row (deduplicated by id; the first file wins, recorder
   * files come first).
   */
  async loadRows({ file } = {}) {
    const { files, truncated: walkTruncated } = this.ledgerFiles(file);
    const byId = new Map();
    const report = [];
    let duplicates = 0;
    let invalid = 0;
    let truncated = walkTruncated;
    for (const f of files) {
      let entry;
      try { entry = await this.readLedgerFile(f); }
      catch (error) { report.push({ file: f.rel, error: error.message }); continue; }
      let added = 0;
      for (const r of entry.items) {
        if (byId.size >= this.dir.limits.maxRows) { truncated = true; break; }
        if (byId.has(r.id)) { duplicates++; continue; }
        byId.set(r.id, r); added++;
      }
      invalid += entry.bad;
      if (entry.truncated) truncated = true;
      report.push({ file: f.rel, format: entry.format, rows: entry.items.length, added, invalidLines: entry.bad });
    }
    return { rows: [...byId.values()], files: report, duplicates, invalid, truncated };
  }

  /* ---------------- candles ---------------- */
  readCandleFile(file) {
    const sig = `${file.size}:${file.mtimeMs}`;
    const hit = this.candleCache.get(file.abs);
    if (hit && hit.sig === sig) return hit;
    const text = this.dir.readText(file.rel, this.dir.limits.maxJsonBytes);
    const { meta, bars } = parseCandleDoc(text, /\.jsonl$/i.test(file.abs));
    const entry = { sig, meta, bars };
    this.candleCache.set(file.abs, entry);
    return entry;
  }

  /** Index candles/** → Map(seriesKey → file list). Files are parsed only when their name is ambiguous. */
  candleIndex() {
    const { files, truncated } = this.dir.walk("candles", (n) => CANDLE_FILE.test(n));
    const index = new Map();
    let unreadable = 0;
    let tooLarge = 0;
    for (const f of files) {
      if (f.size > this.dir.limits.maxJsonBytes) { tooLarge++; continue; }
      let meta = candleMetaFromPath(f.rel.replace(/^candles\//, ""));
      try {
        if (!meta) {
          const doc = this.readCandleFile(f);
          if (doc.meta.src && doc.meta.tf && doc.meta.pair) meta = { src: String(doc.meta.src).toLowerCase(), tf: String(doc.meta.tf), pair: String(doc.meta.pair).toUpperCase() };
        }
      } catch { unreadable++; continue; }
      if (!meta) { unreadable++; continue; }
      const key = seriesKey(meta.src, meta.tf, meta.pair);
      const list = index.get(key);
      if (list) list.push(f); else index.set(key, [f]);
    }
    return { index, files: files.length, unreadable, tooLarge, truncated };
  }

  /** Merged, time-sorted bars for one series ([] when none are cached). */
  candles(index, src, tf, pair) {
    const list = index.get(seriesKey(src, tf, pair));
    if (!list) return [];
    const groups = [];
    for (const f of list) {
      try { groups.push(this.readCandleFile(f).bars); } catch { /* unreadable file: skip */ }
    }
    return mergeBars(groups);
  }
}
