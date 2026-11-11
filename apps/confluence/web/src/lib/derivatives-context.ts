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
