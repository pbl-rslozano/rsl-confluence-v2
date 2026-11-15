/** v2.8 (WP19) bounds shared with the ledger sanitiser (no imports here: this module also runs under plain Node). */
/** |funding| above 5 % per interval is not a real print (same bound as the recorder). */
export const FR_MAX = 0.05;
/** Open-interest change bounds, %: it cannot fall more than 100 %; ×100 in one step is not a real reading. */
export const OI_CHG_MIN = -100;
export const OI_CHG_MAX = 10_000;

export interface DerivativeSnapshot {
  pair: string;
  t: number;
  fr: number | null;
  fi: number | null;
  oi: number | null;
  oit: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseDerivativeSnapshots(text: string): DerivativeSnapshot[] {
  const records = new Map<string, DerivativeSnapshot>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const value = JSON.parse(line);
    if (value?.venue !== "bybit" || value.cat !== "linear" ||
        typeof value.pair !== "string" || !/^[A-Z0-9]{2,30}$/.test(value.pair)) continue;
    const t = finite(value.t);
    if (t === null || t <= 0 || t > 8.64e15) continue;
    const rate = finite(value.fr);
    const oi = finite(value.oi);
    const oit = finite(value.oit);
    const fi = finite(value.fi);
    records.set(value.pair + "|" + t, {
      pair: value.pair, t,
      fr: rate !== null && Math.abs(rate) <= 0.05 ? rate : null,
      fi: fi !== null && fi > 0 ? fi : null,
      oi: oi !== null && oi >= 0 && oit !== null && oit > 0 && oit <= t ? oi : null,
      oit: oit !== null && oit > 0 && oit <= t ? oit : null,
    });
  }
  return [...records.values()].sort((a, b) => b.t - a.t).slice(0, 10_000);
}

export function summarizeDerivatives(records: DerivativeSnapshot[], pair: string, now: number) {
  const rows = records.filter((row) => row.pair === pair && row.t <= now);
  const latest = rows[0];
  const interest = rows.filter((row) => row.oi !== null && row.oit !== null)
    .sort((a, b) => (b.oit ?? 0) - (a.oit ?? 0));
  const current = interest[0];
  const previous = interest.find((row) => row.oit !== current?.oit);
  const openInterest = current?.oi ?? null;
  const priorInterest = previous?.oi ?? null;
  return {
    latest,
    openInterest,
    interestTime: current?.oit ?? null,
    stale: !!latest && now - latest.t > 2 * 60 * 60 * 1000,
    interestStale: current?.oit != null && now - current.oit > 2 * 60 * 60 * 1000,
    changePercent: openInterest !== null && priorInterest !== null && priorInterest > 0
      ? 100 * (openInterest - priorInterest) / priorInterest : null,
  };
}

/** v2.8 (WP19): a snapshot older than this at the signal bar's close is not recorded. */
export const DERIV_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/**
 * v2.8 (WP19) ledger context for one row: Bybit linear funding rate (fraction
 * per interval) and open-interest change (%) between the two newest distinct
 * open-interest readings. Only readings taken AT or BEFORE the signal bar's
 * close `tc` and at most 2 h before it are used (a later reading would be
 * look-ahead); otherwise null. Logged, never scored. Pure.
 */
export function derivativeFields(records: ReadonlyArray<DerivativeSnapshot>, pair: string, tc: number): { fr: number | null; oiChg: number | null } {
  if (!Number.isFinite(tc)) return { fr: null, oiChg: null };
  const fresh = (t: number | null) => t !== null && t <= tc && tc - t <= DERIV_MAX_AGE_MS;
  let latest: DerivativeSnapshot | undefined;
  for (const r of records) if (r.pair === pair && r.fr !== null && fresh(r.t) && (!latest || r.t > latest.t)) latest = r;
  // Newest open-interest reading in the window, and the newest earlier one with a different timestamp.
  const oi = records.filter((r) => r.pair === pair && r.oi !== null && r.oit !== null && r.t <= tc && r.oit <= tc)
    .sort((a, b) => (b.oit as number) - (a.oit as number));
  const cur = oi[0] && fresh(oi[0].oit) ? oi[0] : undefined;
  const prev = cur ? oi.find((r) => (r.oit as number) < (cur.oit as number)) : undefined;
  const oiChg = cur && prev && (prev.oi as number) > 0 ? (100 * ((cur.oi as number) - (prev.oi as number))) / (prev.oi as number) : null;
  // Same bounds as the ledger sanitiser, so a recorded row always re-imports.
  const fr = latest && latest.fr !== null && Math.abs(latest.fr) <= FR_MAX ? latest.fr : null;
  return { fr, oiChg: oiChg !== null && Number.isFinite(oiChg) && oiChg >= OI_CHG_MIN && oiChg <= OI_CHG_MAX ? oiChg : null };
}
