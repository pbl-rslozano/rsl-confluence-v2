/**
 * recorder-core.mjs — one recording cycle, and the loop around it.
 *
 * A cycle mirrors the app's scan (apps/confluence/web/src/app/page.tsx `load`,
 * v2.3) step for step, with the engine's own functions:
 *
 *   1. fetchMarketData(tf, { source, limit, assetClass, klineLimit }) — warm start: 1,000 bars
 *      when the cached series is short or old, else 200. Also returns `universe`, the full
 *      unfiltered venue ranking (all classes), and perp basis.
 *   2. per series: mergeKlines(cache, fresh) → contiguousTail → scoreSeries → scan-record.liveRow (toLedgerRow + enrich)
 *      (live: true, rank = universe rank in the class view, universeRank = rank in the full
 *      ranking, rankSource "live", real quote volume, barCloseTime, barWhileClosed)
 *      → enrich(…) with the scan-wide relative-strength percentiles and BTC bars
 *   3. catch-up: runScanJobSafe({ catchUp }) — the app's catch-up code — for closed bars
 *      after this series' own cursor (full ENGINE_BARS windows only; rankSource "now"),
 *      each row enriched on the bars up to it, exactly as the app does
 *   4. append-only ledger (dedupe by row id), rankings log, derivatives log
 *      (v2.8, WP19: each row also logs the Pattern output — pd/pc — and the funding rate / open-interest
 *      change of a derivative snapshot ≤ 2 h before its bar close — fr/oiChg — from earlier cycles' snapshots)
 *   5. alerts, heartbeat
 *
 * Series whose fetch failed this cycle are not scored and not recorded (no
 * scoring from cached bars as if they were live); their cursor stays put, so
 * the next good cycle catches the missed bars up. A failed catch-up job also
 * leaves its cursor alone (retried next cycle), as in the app.
 *
 * Row assembly is shared with the app through web/src/lib/scan-record.ts
 * (v2.3), so app and recorder rows cannot drift apart.
 */
import { evaluateWorkspaceAlerts } from "./workspace-alerts.mjs";
import { join } from "node:path";
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readSync, renameSync, statSync } from "node:fs";
import {
  cachedDailyBars, catchUpContext, classifySymbol, contiguousTail, DERIV_MAX_AGE_MS, detectHistoricalPattern, ENGINE_BARS, engineConfigId, enrichCatchUp, fetchMarketData, INTERVAL_MS,
  fundTrend, liveRow, loadFundTrends, mergeKlines, packKlines, parseDerivativeSnapshots, rateLimitCooldown, RateLimitError, runScanJobSafe, scanShared, scoreSeries, venueTypeOf,
} from "./engine.mjs";
import { createGuardedFetch, installGlobalFetch, loadRecorderManifest, makeRedactor } from "./net.mjs";
import { createCandleCache, createJsonlAppender, createLedger, ensureDir, monthOf, readJson, writeJsonAtomic } from "./store.mjs";
import { createDerivsRecorder, LINEAR_TICKERS_URL } from "./derivs.mjs";
import { alertConfigFromEnv, createAlerter } from "./alerts.mjs";
import { cyclePeriodMs, derivsWake, nextWake, staleAfterMs } from "./schedule.mjs";
import { VERSION } from "./config.mjs";

const MAX_ERRORS_KEPT = 20;
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
/** v2.8 (WP19): derivative snapshots kept in memory for fr/oiChg (a previous OI reading is needed, so > 2 h). */
const DERIV_KEEP_MS = 3 * DERIV_MAX_AGE_MS;
const DERIV_SEED_BYTES = 4 * 1024 * 1024;

/** Last `bytes` of a JSONL file as complete lines (a torn first line is dropped; unparsable lines are skipped). */
function tailJsonl(path, bytes) {
  if (!existsSync(path)) return "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => { if (!l.trim()) return false; try { JSON.parse(l); return true; } catch { return false; } }).join("\n");
  } finally {
    closeSync(fd);
  }
}

/**
 * @param {object} config  parseConfig() result (plus optional fetchTimeoutMs)
 * @param {{ env?: object, baseFetch?: typeof fetch, log?: (line: string) => void, sleepUntil?: (until: number, signal?: AbortSignal) => Promise<void>, pause?: (ms: number) => Promise<void> }} [deps]
 *   injectable for tests; `pause` is the short throttle between open-interest requests.
 */
export function createRecorder(config, { env = process.env, baseFetch = globalThis.fetch, log: logSink, sleepUntil, pause } = {}) {
  const { source, tf, limit, assetClass, outDir } = config;
  const intervalMs = INTERVAL_MS[tf];
  const cfg = engineConfigId(config.profile);
  const appVersion = `recorder-${VERSION}`;
  ensureDir(outDir);

  /* -------- egress: manifest hosts + alert hosts only when configured -------- */
  const manifest = loadRecorderManifest();
  const alertConfig = alertConfigFromEnv(env);
  const redact = makeRedactor(alertConfig.secrets);
  const hosts = [...manifest.hosts];
  for (const h of alertConfig.hosts) {
    const isTelegram = h === "api.telegram.org";
    if ((isTelegram && manifest.conditionalHosts.includes(h)) || (!isTelegram && manifest.allowsUserWebhook)) hosts.push(h);
    else alertConfig.warnings.push(`alert host ${h} is not permitted by tools/egress-manifest.json; channel will fail`);
  }
  const guard = createGuardedFetch({ baseFetch, hosts, timeoutMs: config.fetchTimeoutMs ?? 20_000, redact });

  /* -------- logging (stdout + rotating <out>/recorder.log), always redacted -------- */
  const logPath = join(outDir, "recorder.log");
  const log = (msg) => {
    const line = `${new Date().toISOString()} ${redact(msg)}`;
    if (logSink) logSink(line);
    else console.log(line);
    try {
      if (statSync(logPath, { throwIfNoEntry: false })?.size > LOG_ROTATE_BYTES) renameSync(logPath, `${logPath}.1`);
      appendFileSync(logPath, line + "\n");
    } catch { /* logging must never stop recording */ }
  };
  alertConfig.warnings.forEach((w) => log(`warning: ${w}`));

  /* -------- persistent state -------- */
  const ledger = createLedger(outDir);
  const cache = createCandleCache(outDir, source, tf);
  const appendJsonl = createJsonlAppender();
  const statePath = join(outDir, "state.json");
  const heartbeatPath = join(outDir, "heartbeat.json");
  const state = readJson(statePath, null)?.schema === 1 ? readJson(statePath, null) : { schema: 1, cursors: {} };
  const previousHeartbeat = readJson(heartbeatPath, null);
  const ctx = { src: source, tf, ac: assetClass, cfg };
  const alerter = createAlerter({ outDir, config: alertConfig, guard, redact, log, ctx });
  const derivs = createDerivsRecorder({ guard, oiTop: config.oiTop ?? 10, ...(pause ? { sleep: pause } : {}) });
  const derivsOn = config.derivs === "on" || (config.derivs === "auto" && source === "bybit-perp");
  // v2.8 (WP19): recent snapshots (this month's log tail, then each cycle's) → fr / oiChg on the rows.
  let derivHistory = [];
  if (derivsOn) {
    try {
      const now = Date.now();
      derivHistory = [monthOf(now - DERIV_KEEP_MS), monthOf(now)].filter((m, i, a) => a.indexOf(m) === i)
        .flatMap((m) => parseDerivativeSnapshots(tailJsonl(join(outDir, "derivs", `${m}.jsonl`), DERIV_SEED_BYTES)))
        .filter((r) => r.t >= now - DERIV_KEEP_MS);
    } catch (error) {
      log(`warning: derivative snapshots not reloaded (${error instanceof Error ? error.message : String(error)})`);
      derivHistory = [];
    }
  }

  const memory = new Map(); // pair → { len, newest } of the contiguous cached tail
  const hb = {
    schema: 1,
    version: VERSION,
    pid: process.pid,
    cfg,
    src: source,
    tf,
    ac: assetClass,
    limit,
    startedAt: Date.now(),
    status: "starting",
    cycles: 0,
    lastCycleAt: null,
    lastCycleMs: null,
    lastSuccessAt: previousHeartbeat?.lastSuccessAt ?? null,
    // A failure streak survives restarts, so `--once` runs from a scheduler still reach 3.
    consecutiveFailures: previousHeartbeat?.cfg === cfg ? previousHeartbeat.consecutiveFailures ?? 0 : 0,
    streakStartedAt: previousHeartbeat?.cfg === cfg ? previousHeartbeat.streakStartedAt ?? null : null,
    rowsWritten: 0,
    rowsWrittenTotal: 0,
    lastCycle: null,
    errors: [],
    rateLimitedUntil: null,
    nextWakeAt: null,
    staleAfterMs: staleAfterMs(tf, config.intervalSeconds),
    // Read by apps/confluence/mcp recorder_health: `at` = dead-man reference
    // (last SUCCESSFUL cycle, not merely the last write), `intervalMs` = cycle period.
    at: previousHeartbeat?.lastSuccessAt ?? null,
    intervalMs: cyclePeriodMs(tf, config.intervalSeconds),
    alerts: alertConfig.telegram || alertConfig.webhook ? { channels: [alertConfig.telegram && "telegram", alertConfig.webhook && "webhook"].filter(Boolean) } : null,
  };
  // Recorder-side cooldown (own rate limits, and a venue cooldown that outlives
  // the process: a `--once` run started by a scheduler 5 min after a Bybit ban
  // must not knock again before the ban is over).
  let pauseUntil = Number(previousHeartbeat?.rateLimitedUntil) > Date.now() ? Number(previousHeartbeat.rateLimitedUntil) : 0;

  const pushError = (msg) => {
    hb.errors.push({ at: new Date().toISOString(), msg: redact(msg).slice(0, 400) });
    if (hb.errors.length > MAX_ERRORS_KEPT) hb.errors.splice(0, hb.errors.length - MAX_ERRORS_KEPT);
  };
  const writeHeartbeat = () => {
    hb.at = hb.lastSuccessAt;
    try {
      writeJsonAtomic(heartbeatPath, hb);
    } catch (error) {
      log(`heartbeat write failed: ${error instanceof Error ? error.message : error}`);
    }
  };

  /** Dead-man on start-up: the previous heartbeat says nothing succeeded for too long. */
  function checkStartupGap(now = Date.now()) {
    const last = previousHeartbeat?.lastSuccessAt;
    if (last && now - last > hb.staleAfterMs) {
      log(`recorder was not recording from ${new Date(last).toISOString()} (${Math.round((now - last) / 60_000)} min)`);
      alerter.deadman({ lastSuccessAt: last, staleForMs: now - last, now, detail: `Restarted; catch-up fills up to ${config.catchUpMax} bars per series.` });
    }
  }

  const cachedTail = (pair) => {
    let info = memory.get(pair);
    if (!info) {
      const tail = contiguousTail(cache.load(pair), intervalMs);
      info = { len: tail.length, newest: tail.length ? tail[tail.length - 1].time : 0 };
      memory.set(pair, info);
    }
    return info;
  };

  const classOf = (symbol) => {
    const c = classifySymbol(source, symbol, venueTypeOf(source, symbol));
    return c === "excluded" ? "crypto" : c;
  };

  /* ================================ one cycle ================================ */
  /**
   * Bybit linear snapshot for `symbols` at `at`: logged, added to the in-memory
   * history used for fr / oiChg; a rate limit pauses every request (cycle and
   * pre-close snapshot alike). Returns { n, warnings, rateLimitedUntil }.
   */
  async function takeDerivs(symbols, at, signal) {
    const snap = await derivs.snapshot(symbols, at, signal);
    if (snap.records.length) appendJsonl(join(outDir, "derivs", `${monthOf(at)}.jsonl`), snap.records);
    derivHistory = [...derivHistory.filter((r) => r.t >= at - DERIV_KEEP_MS), ...snap.records];
    const warnings = snap.errors.slice(0, 5);
    let rateLimitedUntil = null;
    if (snap.rateLimit) {
      pauseUntil = Date.now() + snap.rateLimit.retryAfterMs;
      rateLimitedUntil = pauseUntil;
      warnings.push(`derivatives: ${snap.rateLimit.message}`);
    }
    return { n: snap.records.length, warnings, rateLimitedUntil };
  }
  /** Universe of the last successful cycle (best rank first) — the pre-close snapshot reuses it. */
  let derivSymbols = [];

  /**
   * v2.8 (WP19 fix round 1): derivatives-only wake before a bar close — no candles,
   * no scoring, no ledger rows; same hosts and pacing as the cycle's snapshot.
   */
  async function derivsOnly(signal) {
    if (!derivsOn || !derivSymbols.length || signal?.aborted) return null;
    const at = Date.now();
    if (rateLimitCooldown() > 0 || pauseUntil > at) { log("pre-close derivatives snapshot skipped (rate-limit cooldown)"); return null; }
    guard.clearMemo();
    try {
      const r = await takeDerivs(derivSymbols, at, signal);
      for (const w of r.warnings) pushError(w);
      log(`pre-close derivatives snapshot: ${r.n} records${r.rateLimitedUntil ? ", RATE LIMITED" : ""}`);
      return r;
    } catch (error) {
      if (!(error?.name === "AbortError" && signal?.aborted)) pushError(`derivatives: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function cycle(signal) {
    const started = Date.now();
    guard.clearMemo();
    const stats0 = { ...guard.stats };
    const result = { ok: false, at: started, symbols: 0, scored: 0, liveRows: 0, catchUpRows: 0, written: 0, duplicates: 0, feedErrors: 0, derivs: 0, rateLimitedUntil: null, warnings: [], newestBarOpen: 0, alerts: 0 };
    let failure = null;
    const live = [];
    const catchUp = [];
    let rankUniverse = null;
    try {
      const cooling = Math.max(rateLimitCooldown(), pauseUntil - started);
      if (cooling > 0) throw new RateLimitError(`rate-limit cooldown active for ${Math.ceil(cooling / 1000)} s`, cooling);
      // The funding step reads the same linear ticker list the engine requests for bybit-perp: one request.
      if (derivsOn) guard.memoize(LINEAR_TICKERS_URL);

      // 1 — universe, full ranking and candles through the engine (direct fetch, closed bars only, freshness gate).
      const data = await fetchMarketData(tf, {
        source,
        limit,
        assetClass,
        signal,
        klineLimit: (symbol) => {
          const h = cachedTail(symbol);
          return h.len >= ENGINE_BARS && Date.now() - h.newest < intervalMs * 150 ? 200 : 1000;
        },
      });
      result.symbols = data.tickers.length;
      if (data.rateLimitedUntil) result.rateLimitedUntil = data.rateLimitedUntil;
      for (const e of data.errors) if (e.reason !== "RATE_LIMIT") pushError(`${e.symbol}: ${e.reason} ${e.message}`);
      const universe = Array.isArray(data.universe) ? data.universe : null;
      if (!universe) result.warnings.push("engine returned no full ranking (data.universe); rku not recorded");

      // 2 — merge cached + fresh bars per series (same order of operations as the app).
      const prepared = data.tickers.map((t) => {
        const recent = data.klines[t.symbol] ?? [];
        if (!recent.length) return { t, kl: [], fresh: false };
        const merged = mergeKlines(cache.load(t.symbol), recent);
        cache.save(t.symbol, merged);
        const kl = contiguousTail(merged, data.intervalMs);
        memory.set(t.symbol, { len: kl.length, newest: kl[kl.length - 1].time });
        return { t, kl, fresh: true };
      });
      const freshList = prepared.filter((p) => p.fresh && p.kl.length);
      result.feedErrors = prepared.length - freshList.length;
      // v2.3: rows are assembled by the web lib's scan-record.ts — the same
      // code the app uses — so the two can never drift apart.
      const seriesOf = (t, kl) => ({ symbol: t.symbol, rank: t.rank, quoteVolume: parseFloat(t.quoteVolume) || 0, ac: classOf(t.symbol), kl });
      const recordCtx = {
        src: source, tf, intervalMs: data.intervalMs, appVersion, universe: universe ?? undefined, basisBySymbol: data.basisBySymbol, recordedAt: started,
        ...(derivHistory.length ? { derivatives: derivHistory } : {}),
      };
      const shared = scanShared(freshList.map((p) => seriesOf(p.t, p.kl)), universe ?? undefined);

      // 3 — live rows and catch-up rows.
      const cursorUpdates = {};
      for (const { t, kl } of freshList) {
        const ac = classOf(t.symbol);
        // Volume usability is decided by scoreSeries on the scored window itself,
        // exactly as the app and replay do (v2.3 review C11).
        const volumeAvailable = true;
        const last = kl[kl.length - 1];
        result.newestBarOpen = Math.max(result.newestBarOpen, last.time);

        const score = scoreSeries(kl, { intervalMs: data.intervalMs, volumeAvailable, assetClass: ac, profile: config.profile });
        if (score.usable) {
          // v2.8 (WP19): the Pattern output, computed as the app's scan job does (memoised per series).
          const pattern = detectHistoricalPattern(kl, {
            volumeAvailable, intervalMs: data.intervalMs, currentConfluence: score.confluence, currentReversal: score.reversal,
            cacheKey: `${source}:${tf}:${t.symbol}${config.profile ? `|${cfg}` : ""}`,
          });
          const row = liveRow({ ...seriesOf(t, kl), pattern }, score, recordCtx, shared);
          if (row) {
            live.push({ row, score });
            result.scored++;
          }
        }

        const key = `${cfg}|${source}|${tf}|${t.symbol}`;
        // No cursor yet = first sight of this series: start forward, never
        // back-fill bars from before it entered the scan (review C6).
        const known = state.cursors[key];
        const since = known ?? 0;
        if (config.catchUpMax > 0 && known !== undefined && kl.length > 1 && since < kl[kl.length - 2].time) {
          const job = runScanJobSafe({
            key: `${source}:${tf}:${t.symbol}`,
            packed: packKlines(kl),
            intervalMs: data.intervalMs,
            volumeAvailable,
            assetClass: ac,
            profile: config.profile,
            catchUp: { since, max: config.catchUpMax, ctx: catchUpContext(seriesOf(t, kl), recordCtx, shared) },
          });
          if (job.error) {
            result.warnings.push(`catch-up ${t.symbol}: ${job.error}`);
            continue; // cursor not advanced: retried next cycle
          }
          catchUp.push(...enrichCatchUp(job.catchUpRows ?? [], kl, recordCtx, shared));
        }
        cursorUpdates[key] = last.time;
      }

      // 3b — v2.8 (WP21): Fund trend per row, a logged benchmark that never enters the score. Daily bars come
      // from the row's own source (one request per crypto pair per UTC day, same hosts, venue gates, 429 halt);
      // a row logs the value from the daily bars closed at or before its own bar close (no look-ahead).
      if (freshList.length && !signal?.aborted) {
        try {
          const feed = await loadFundTrends(source, freshList.map(({ t }) => ({ symbol: t.symbol, ac: classOf(t.symbol) })), Date.now(), { signal });
          for (const row of [...catchUp, ...live.map((x) => x.row)]) {
            if (row.ac !== "crypto") continue;
            const st = feed.get(row.pair);
            const v = st && "na" in st ? null : fundTrend(cachedDailyBars(source, row.pair), row.tc)?.value;
            row.ft = typeof v === "number" ? Math.round(v * 10) / 10 : null;
          }
          const cooling = rateLimitCooldown(source);
          if ([...feed.values()].some((x) => "na" in x && x.na === "loading") && cooling > 0) {
            result.rateLimitedUntil = Math.max(result.rateLimitedUntil ?? 0, Date.now() + cooling);
            pauseUntil = Math.max(pauseUntil, result.rateLimitedUntil);
          }
        } catch (error) {
          if (error?.name === "AbortError" && signal?.aborted) throw error;
          result.warnings.push(`fund trend: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 4 — ledger (append-only, idempotent), then cursors.
      const { written, duplicates } = ledger.record([...catchUp, ...live.map((x) => x.row)]);
      Object.assign(state.cursors, cursorUpdates);
      writeJsonAtomic(statePath, state);
      result.written = written;
      result.duplicates = duplicates;
      result.liveRows = live.length;
      result.catchUpRows = catchUp.length;

      // Open horizons (review C14): a pair that left the scan still needs bars
      // until its newest row's longest horizon has closed, or that outcome can
      // never be measured. Candles only — no rows are recorded for it.
      state.open = state.open ?? {};
      const horizonMs = 25 * data.intervalMs; // longest horizon (24) + entry bar
      for (const { row } of live) state.open[`${source}|${tf}|${row.pair}`] = row.t;
      const scanned = new Set(data.tickers.map((x) => x.symbol));
      const missing = Object.entries(state.open)
        .filter(([k, t0]) => k.startsWith(`${source}|${tf}|`) && t0 + horizonMs > started - data.intervalMs)
        .map(([k]) => k.split("|")[2])
        .filter((p) => !scanned.has(p))
        .slice(0, 20);
      for (const [k, t0] of Object.entries(state.open)) if (t0 + horizonMs <= started - data.intervalMs) delete state.open[k];
      if (missing.length && !result.rateLimitedUntil && !signal?.aborted) {
        try {
          // v2.8 (Task 8 review): never floored — a recorded pair that fell under the liquidity floor still
          // needs bars until its horizon closes, or its outcome can never be measured.
          const extra = await fetchMarketData(tf, { source, assets: missing.map((p) => p.replace(/USDT$/, "")), limit: missing.length, assetClass: "all", signal, klineLimit: () => 200, liquidityFloorUsd: 0 });
          for (const [sym, recent] of Object.entries(extra.klines)) {
            if (missing.includes(sym) && recent.length) cache.save(sym, mergeKlines(cache.load(sym), recent));
          }
          result.openHorizonPairs = missing.length;
        } catch (error) {
          result.warnings.push(`open-horizon candles: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      writeJsonAtomic(statePath, state);

      if (universe && !result.rateLimitedUntil && data.errors.length === 0) rankUniverse = universe.map((entry) => entry.p);
      if (universe) {
        appendJsonl(join(outDir, "rankings", `${monthOf(started)}.jsonl`), [{
          t: started, src: source, tf, cls: "all", view: assetClass, bar: result.newestBarOpen || null, n: universe.length,
          ranks: universe.map((u) => [u.p, u.qv]),
        }]);
      }

      // Derivatives: never after a rate limit in this cycle.
      if (derivsOn) derivSymbols = data.tickers.map((t) => t.symbol);
      if (derivsOn && !result.rateLimitedUntil && !signal?.aborted) {
        const snap = await takeDerivs(derivSymbols, started, signal);
        result.derivs = snap.n;
        result.warnings.push(...snap.warnings);
        if (snap.rateLimitedUntil) result.rateLimitedUntil = Math.max(result.rateLimitedUntil ?? 0, snap.rateLimitedUntil);
      }
      // A cycle succeeds when at least one series delivered fresh closed bars
      // (a young series that is still too short to score is not a failure).
      result.ok = freshList.length > 0;
      if (!result.ok) failure = `no fresh candles (${result.feedErrors}/${data.tickers.length} feeds unavailable)`;
    } catch (error) {
      if (error?.name === "AbortError" && signal?.aborted) {
        failure = "stopped";
      } else if (error instanceof RateLimitError) {
        failure = error.message;
        result.rateLimitedUntil = Date.now() + Math.max(rateLimitCooldown(), error.retryAfterMs, pauseUntil - Date.now());
        pauseUntil = Math.max(pauseUntil, result.rateLimitedUntil);
      } else {
        // undici reports every network failure as "fetch failed"; the useful part is the cause.
        const cause = error?.cause ? ` (${error.cause.code ?? ""}${error.cause.code && error.cause.message ? " " : ""}${error.cause.message ?? ""})` : "";
        failure = error instanceof Error ? `${error.name}: ${error.message}${cause}` : String(error);
      }
    }

    /* -------- alerts + heartbeat (also after a failed cycle) -------- */
    const now = Date.now();
    hb.cycles++;
    hb.lastCycleAt = now;
    hb.lastCycleMs = now - started;
    hb.rowsWritten = result.written;
    hb.rowsWrittenTotal += result.written;
    hb.rateLimitedUntil = result.rateLimitedUntil;
    if (result.ok) {
      hb.lastSuccessAt = now;
      hb.consecutiveFailures = 0;
      hb.streakStartedAt = null;
    } else if (failure !== "stopped") {
      hb.consecutiveFailures++;
      if (!hb.streakStartedAt) hb.streakStartedAt = started;
      pushError(failure);
    }
    for (const w of result.warnings) pushError(w);
    try {
      alerter.observe(catchUp);
      result.alerts = alerter.evaluate(live, intervalMs, now);
      if (failure !== "stopped") alerter.health({ ok: result.ok, consecutiveFailures: hb.consecutiveFailures, streakStartedAt: hb.streakStartedAt, lastError: failure ?? "", now });
      await alerter.flush(signal, now);
      result.alerts += evaluateWorkspaceAlerts(outDir, catchUp, live, result.ok && rankUniverse && tf !== "1M"
        ? { bar: result.newestBarOpen, intervalMs, symbols: rankUniverse } : undefined);
    } catch (error) {
      pushError(`alerts: ${error instanceof Error ? error.message : error}`);
    }
    const requests = guard.stats.requests - stats0.requests;
    hb.lastCycle = { ...result, warnings: result.warnings.length, requests, memoHits: guard.stats.memoHits - stats0.memoHits, error: failure ? redact(failure) : null };
    hb.status = result.ok ? "ok" : failure === "stopped" ? "stopping" : "failing";
    writeHeartbeat();
    log(result.ok
      ? `cycle ok: ${result.scored}/${result.symbols} scored, ${result.written} rows written (${result.catchUpRows} catch-up, ${result.duplicates} dup), ${result.feedErrors} feed errors, ${result.derivs} derivs, ${requests} requests${result.rateLimitedUntil ? ", RATE LIMITED" : ""}`
      : `cycle failed (${hb.consecutiveFailures} in a row): ${failure}`);
    return { ...result, error: failure };
  }

  /* ================================ loop ================================ */
  async function run(signal, { once = false } = {}) {
    const restore = installGlobalFetch(guard);
    const sleeper = sleepUntil ?? interruptibleSleep;
    try {
      checkStartupGap();
      for (;;) {
        const r = await cycle(signal);
        if (once || signal?.aborted) return r;
        const wake = nextWake({
          now: Date.now(), tf, newestBarOpen: r.newestBarOpen, intervalSeconds: config.intervalSeconds, graceMs: config.graceMs,
          ok: r.ok, consecutiveFailures: hb.consecutiveFailures, cooldownUntil: Math.max(r.rateLimitedUntil ?? 0, Date.now() + rateLimitCooldown()),
        });
        hb.nextWakeAt = wake;
        hb.status = r.ok ? "sleeping" : "retrying";
        writeHeartbeat();
        log(`next cycle at ${new Date(wake).toISOString()}`);
        // v2.8 (WP19 fix round 1): on a once-per-bar cadence longer than 2 h, snapshot derivatives shortly
        // before the close so the next rows can log fr / oiChg (≤ 2 h old, never after the close).
        const pre = derivsOn && r.ok ? derivsWake({ now: Date.now(), wake, tf, newestBarOpen: r.newestBarOpen, maxAgeMs: DERIV_MAX_AGE_MS }) : null;
        if (pre !== null) {
          await sleeper(pre, signal);
          if (signal?.aborted) return r;
          await derivsOnly(signal);
          writeHeartbeat();
        }
        await sleeper(wake, signal);
        if (signal?.aborted) return r;
      }
    } finally {
      hb.status = "stopped";
      hb.nextWakeAt = null;
      writeHeartbeat();
      alerter.save();
      restore();
    }
  }

  return { cycle, run, guard, heartbeat: hb, state, checkStartupGap, alerter, cfg, outDir, installFetch: () => installGlobalFetch(guard), log };
}

/**
 * Sleep until wall-clock `until`, in ≤ 60 s steps so a laptop that slept or a
 * clock change is noticed within a minute, and so very long waits (1M bars)
 * never overflow setTimeout's 24.8-day limit. Resolves early on abort.
 */
export async function interruptibleSleep(until, signal) {
  while (!signal?.aborted) {
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, Math.min(left, 60_000));
      function done() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
  }
}

/** `--check-heartbeat`: stale = no successful cycle within staleAfterMs. */
export function readHeartbeatStatus(outDir, now = Date.now()) {
  const hb = readJson(join(outDir, "heartbeat.json"), null);
  if (!hb) return { exists: false, stale: true, hb: null, staleForMs: Infinity };
  const last = hb.lastSuccessAt ?? 0;
  const limitMs = Number(hb.staleAfterMs) || 12 * 3_600_000;
  return { exists: true, stale: now - last > limitMs, hb, staleForMs: now - last };
}
