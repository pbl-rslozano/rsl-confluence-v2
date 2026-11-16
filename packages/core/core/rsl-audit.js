/**
 * rsl-audit.js — rsL Core Kit · 1.2.0
 * Append-only, SHA-256 hash-chained audit trail for quality records (ALCOA+ / draft EU GMP Annex 11 style).
 *
 * entry = { seq, at, actorId, event, record, reason, before, after, prev, hash }
 *   hash = SHA-256( canonicalJSON(entry without hash) ),  prev = previous hash (64 zeros for #1)
 *
 * Tamper-EVIDENT, not tamper-proof: anyone with file access can rewrite the whole chain.
 * Anchor the head hash in every export and printed report so a rewrite is detectable later.
 * actorId is an opaque id, so a person's display name can be pseudonymised (PDPL request)
 * without breaking the chain. Never put national ID / iqama numbers in the trail.
 */
import { canonicalJSON, sha256Hex } from './rsl-crypto.js';
import { guardedNow } from './rsl-clock.js';

export const GENESIS = '0'.repeat(64);
const COL = 'audit';
const seqId = (n) => String(n).padStart(10, '0');

/**
 * @param {StoragePort} port   from rsl-storage.js
 * @param {{ now?:()=>number }} opts
 */
export function createAuditTrail(port, { now = () => Date.now() } = {}) {
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  async function head() {
    return (await port.get(COL + '_meta', 'head')) || { seq: 0, hash: GENESIS, highWater: null };
  }

  /** Append one entry. Writes are serialised so concurrent calls cannot fork the chain. */
  function append({ actorId, event, record = null, reason = '', before = null, after = null }) {
    return serial(async () => {
      if (!actorId || !event) throw new Error('audit.append needs actorId and event');
      const h = await head();
      const clk = guardedNow(h.highWater, now());
      const entry = { seq: h.seq + 1, at: new Date(clk.now).toISOString(), actorId: String(actorId), event: String(event),
        record, reason: String(reason), before, after, prev: h.hash };
      entry.hash = await sha256Hex(canonicalJSON(entry));
      await port.put(COL, seqId(entry.seq), entry);
      await port.put(COL + '_meta', 'head', { seq: entry.seq, hash: entry.hash, highWater: clk.nextHighWater });
      if (clk.setBack) {
        // Record the anomaly as its own chained entry (never silently)
        const warn = { seq: entry.seq + 1, at: entry.at, actorId: 'system', event: 'clock.set-back', record: null,
          reason: `Device clock is behind the last trusted time (${new Date(h.highWater).toISOString()}).`, before: null, after: null, prev: entry.hash };
        warn.hash = await sha256Hex(canonicalJSON(warn));
        await port.put(COL, seqId(warn.seq), warn);
        await port.put(COL + '_meta', 'head', { seq: warn.seq, hash: warn.hash, highWater: clk.nextHighWater });
      }
      return entry;
    });
  }

  /** Recompute the whole chain. Returns { intact, count, brokenAt, head }. */
  async function verify() {
    const rows = (await port.list(COL)).map((r) => r.doc).sort((a, b) => a.seq - b.seq);
    let prev = GENESIS;
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      const { hash, ...rest } = e;
      if (e.seq !== i + 1 || e.prev !== prev || (await sha256Hex(canonicalJSON(rest))) !== hash)
        return { intact: false, count: rows.length, brokenAt: i + 1, head: prev };
      prev = hash;
    }
    const h = await head();
    if (h.hash !== prev || h.seq !== rows.length) return { intact: false, count: rows.length, brokenAt: rows.length, head: prev };
    return { intact: true, count: rows.length, brokenAt: null, head: prev };
  }

  async function entries({ record } = {}) {
    const rows = (await port.list(COL)).map((r) => r.doc).sort((a, b) => a.seq - b.seq);
    return record ? rows.filter((e) => e.record === record) : rows;
  }

  /** Short head reference for report footers: "AUD #128 · 3f9a…c21b". */
  async function footerRef() {
    const h = await head();
    return `AUD #${h.seq} · ${h.hash.slice(0, 4)}…${h.hash.slice(-4)}`;
  }

  return { append, verify, entries, head, footerRef };
}

/** Diff helper: only the changed fields go into before/after (keeps the trail readable). */
export function diffFields(before = {}, after = {}) {
  const b = {}, a = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (canonicalJSON(before?.[k] ?? null) !== canonicalJSON(after?.[k] ?? null)) { b[k] = before?.[k] ?? null; a[k] = after?.[k] ?? null; }
  }
  return { before: b, after: a };
}
