/**
 * rsl-clock.js — rsL Core Kit · 1.2.0
 * Monotonic clock with bounded skew, shared by licensing and the audit trail.
 * Offline devices can have their clocks set back; this keeps time moving forward
 * without letting one bad reading (CMOS reset, VM snapshot) freeze the app in the future.
 */

export const DAY_MS = 86_400_000;
export const MAX_SKEW_DAYS = 30;

/**
 * @param {number|null} highWater  largest trusted time seen before (ms since epoch), or null
 * @param {number} real            Date.now()
 * @returns {{ now:number, nextHighWater:number, ignored:number|null, setBack:boolean }}
 *   now            — time the app should use
 *   nextHighWater  — value to persist (never lower than before unless the old mark was ignored)
 *   ignored        — the stored mark when it was more than MAX_SKEW_DAYS ahead and therefore dropped
 *   setBack        — true when the real clock is more than one day behind the mark (audit this)
 */
export function guardedNow(highWater, real, maxSkewDays = MAX_SKEW_DAYS) {
  const hw = Number.isFinite(highWater) ? highWater : 0;
  if (hw > real + maxSkewDays * DAY_MS) {
    return { now: real, nextHighWater: real, ignored: hw, setBack: false };
  }
  const now = Math.max(real, hw);
  return { now, nextHighWater: now, ignored: null, setBack: hw - real > DAY_MS };
}

/**
 * Persisting wrapper. `stores` is a list of { get():Promise<number|null>, set(n):Promise<void> }
 * (e.g. IndexedDB + localStorage). The largest value that passes the skew test wins.
 */
export async function readGuardedNow(stores, real = Date.now(), maxSkewDays = MAX_SKEW_DAYS) {
  const marks = [];
  for (const s of stores) {
    try { const v = await s.get(); if (Number.isFinite(v)) marks.push(v); } catch { /* unreadable store = no mark */ }
  }
  const valid = marks.filter((m) => m <= real + maxSkewDays * DAY_MS);
  const best = valid.length ? Math.max(...valid) : (marks.length ? Math.max(...marks) : null);
  const r = guardedNow(best, real, maxSkewDays);
  for (const s of stores) { try { await s.set(r.nextHighWater); } catch { /* best effort */ } }
  return r;
}

/** UTC calendar date helpers. A date D ends at D T23:59:59.999Z (inclusive). */
export function parseISODate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t;
}
export const endOfDayUTC = (s) => { const t = parseISODate(s); return t === null ? null : t + DAY_MS - 1; };
export const daysLeft = (endMs, now) => Math.ceil((endMs - now) / DAY_MS);
