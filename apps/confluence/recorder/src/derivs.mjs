/**
 * derivs.mjs — funding rate and open interest snapshots (Bybit V5 public, linear).
 *
 * Logged-but-unscored context: nothing here feeds a score or a ledger row. It
 * exists so funding and positioning can later be tested as filters against the
 * recorded signals (docs/measurement.md — the cost model currently assumes a
 * flat 1 bp / 8 h).
 *
 * Per cycle:
 *   • /v5/market/tickers?category=linear     → fundingRate, nextFundingTime (one call, all symbols;
 *                                              the engine's own ticker call when --source bybit-perp)
 *   • /v5/market/instruments-info?category=linear → fundingInterval (minutes), cached 6 h, paged
 *   • /v5/market/open-interest?…&intervalTime=1h&limit=1 → open interest, top --oi-top symbols only,
 *                                              one request at a time with a pause between
 *
 * Every payload is shape-checked field by field; a bad record is dropped and
 * counted, a bad response ends this step only — the cycle never fails here. A
 * rate-limit response stops the step and is reported to the caller, which then
 * pauses all derivatives requests for the venue's cooldown.
 */
import { getJson } from "./net.mjs";
import { RateLimitError } from "./engine.mjs";

const BYBIT = "https://api.bybit.com";
export const LINEAR_TICKERS_URL = `${BYBIT}/v5/market/tickers?category=linear`;
const INSTRUMENT_TTL_MS = 6 * 3_600_000;

const finite = (v) => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && !/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v.trim())) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const epochMs = (v) => {
  const n = finite(v);
  // Plausible ms timestamps only (2015 … 2100); rejects seconds and garbage.
  return n !== null && Number.isInteger(n) && n > 1.42e12 && n < 4.1e12 ? n : null;
};

export function createDerivsRecorder({ guard, oiTop = 10, pauseMs = 150, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  let fundingIntervals = { at: 0, map: new Map() };

  async function loadFundingIntervals(signal) {
    if (Date.now() - fundingIntervals.at < INSTRUMENT_TTL_MS && fundingIntervals.map.size) return fundingIntervals.map;
    const map = new Map();
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const url = `${BYBIT}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const json = await getJson(guard.fetch, url, "Bybit instruments (funding interval)", signal);
      const list = json?.result?.list;
      if (!Array.isArray(list)) throw new Error("instruments-info: result.list missing");
      for (const it of list) {
        const minutes = finite(it?.fundingInterval);
        if (typeof it?.symbol === "string" && minutes !== null && minutes > 0 && minutes <= 1440) map.set(it.symbol, minutes);
      }
      cursor = typeof json.result.nextPageCursor === "string" ? json.result.nextPageCursor : "";
      if (!cursor) break;
    }
    fundingIntervals = { at: Date.now(), map };
    return map;
  }

  /**
   * @param {string[]} symbols universe symbols, best rank first
   * @returns {Promise<{ records: object[], errors: string[], rateLimit: RateLimitError | null }>}
   */
  async function snapshot(symbols, now, signal) {
    const errors = [];
    const records = [];
    let rateLimit = null;
    const fail = (error, what) => {
      if (error instanceof RateLimitError) rateLimit = error;
      else if (!(error?.name === "AbortError")) errors.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    };

    // 1 — funding from the linear ticker list (memoised: same URL as the engine's bybit-perp ticker call).
    let tickers = null;
    try {
      guard.memoize(LINEAR_TICKERS_URL);
      const json = await getJson(guard.fetch, LINEAR_TICKERS_URL, "Bybit linear tickers (funding)", signal);
      if (!Array.isArray(json?.result?.list)) throw new Error("tickers: result.list missing");
      tickers = new Map(json.result.list.filter((t) => typeof t?.symbol === "string").map((t) => [t.symbol, t]));
    } catch (error) {
      fail(error, "funding");
      return { records, errors, rateLimit };
    }

    // 2 — funding interval (cached; a failure leaves fi = null, not the whole step).
    let intervals = new Map();
    if (!rateLimit) {
      try {
        intervals = await loadFundingIntervals(signal);
      } catch (error) {
        fail(error, "funding interval");
      }
    }

    const wanted = symbols.filter((s) => tickers.has(s));
    const bySymbol = new Map();
    for (const pair of wanted) {
      const t = tickers.get(pair);
      const fr = finite(t.fundingRate);
      const nft = epochMs(t.nextFundingTime);
      if (fr === null || Math.abs(fr) > 0.05) {
        // |rate| > 5 % per interval is not a real funding print.
        errors.push(`funding ${pair}: invalid fundingRate`);
        continue;
      }
      bySymbol.set(pair, {
        t: now,
        venue: "bybit",
        cat: "linear",
        pair,
        fr,
        nft,
        fi: intervals.get(pair) ?? null,
        mp: finite(t.markPrice),
        oi: null,
        oit: null,
      });
    }

    // 3 — open interest for the top few only (one request per symbol, throttled).
    for (const pair of wanted.slice(0, Math.max(0, oiTop))) {
      if (rateLimit || signal?.aborted) break;
      const rec = bySymbol.get(pair);
      if (!rec) continue;
      try {
        const url = `${BYBIT}/v5/market/open-interest?category=linear&symbol=${encodeURIComponent(pair)}&intervalTime=1h&limit=1`;
        const json = await getJson(guard.fetch, url, `Bybit open interest ${pair}`, signal);
        const row = Array.isArray(json?.result?.list) ? json.result.list[0] : undefined;
        const oi = finite(row?.openInterest);
        const oit = epochMs(row?.timestamp);
        if (oi === null || oi < 0 || oit === null) errors.push(`open interest ${pair}: invalid payload`);
        else {
          rec.oi = oi;
          rec.oit = oit;
        }
      } catch (error) {
        fail(error, `open interest ${pair}`);
      }
      await sleep(pauseMs);
    }

    records.push(...bySymbol.values());
    return { records, errors, rateLimit };
  }

  return { snapshot };
}
