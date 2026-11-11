/**
 * alerts.mjs — Phase F: optional Telegram / webhook alerts from the recorder.
 *
 * Configured ONLY by environment variables (nothing is written to disk):
 *   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   POST https://api.telegram.org/bot<token>/sendMessage
 *   ALERT_WEBHOOK_URL                       POST JSON to the user's own https endpoint
 *   ALERT_COOLDOWN_BARS (default 6)         same series + kind is quiet for this many bars
 *   ALERT_MAX_PER_CYCLE (default 10)        the rest are summarised in one message
 * The browser app never sends alerts; only this Node process does (ADR-0008).
 *
 * Triggers
 *   strong-bull / strong-bear  Master Signal moves INTO STRONG (from weaker, or from STRONG the other way)
 *   rev-up / rev-down          a HIGH or MODERATE reversal against the current trend (same rule as the app)
 *   failure / recovered        3 consecutive failed cycles, and the first good cycle after that alert
 *   deadman                    the heartbeat went stale (found on start-up or by `--check-heartbeat`)
 * Only the newest (live) bar can alert; catch-up bars only advance the
 * per-series state, so restarting after a gap never replays old signals.
 *
 * No duplicates, ever: each alert has a key (series + bar + kind) that is
 * written to alerts-state.json BEFORE the send. A crash after sending can
 * therefore only lose an alert, never repeat one. Transient send failures are
 * retried from an outbox (3 attempts within 2 h); permanent ones (HTTP 4xx
 * other than 429) are dropped and logged.
 *
 * Secrets: the bot token and webhook URL live only in memory; every error and
 * log line passes through the redactor.
 */
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "./store.mjs";

export const DISCLAIMER = "analysis only — not financial advice";
const TELEGRAM_HOST = "api.telegram.org";
const SENT_TTL_MS = 45 * 86_400_000;
const SERIES_TTL_MS = 60 * 86_400_000;
const RETRY_WINDOW_MS = 2 * 3_600_000;
const MAX_ATTEMPTS = 3;
const FAILURE_STREAK = 3;

const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{20,}$/;
const CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/;

export const fmtUtc = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Read alert channels from env. Invalid values disable that channel with a
 * warning that never contains the secret itself.
 */
export function alertConfigFromEnv(env = process.env) {
  const warnings = [];
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim();
  const webhookRaw = (env.ALERT_WEBHOOK_URL ?? "").trim();
  let telegram = null;
  if (token || chatId) {
    if (!TOKEN_RE.test(token)) warnings.push("TELEGRAM_BOT_TOKEN is missing or not a bot token; Telegram alerts off");
    else if (!CHAT_RE.test(chatId)) warnings.push("TELEGRAM_CHAT_ID is missing or invalid; Telegram alerts off");
    else telegram = { token, chatId };
  }
  let webhook = null;
  if (webhookRaw) {
    try {
      const u = new URL(webhookRaw);
      if (u.protocol !== "https:") warnings.push("ALERT_WEBHOOK_URL must be https; webhook alerts off");
      else webhook = { url: u.href, host: u.host.toLowerCase() };
    } catch {
      warnings.push("ALERT_WEBHOOK_URL is not a URL; webhook alerts off");
    }
  }
  const intOr = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : d;
  };
  return {
    telegram,
    webhook,
    cooldownBars: intOr(env.ALERT_COOLDOWN_BARS, 6, 0, 1000),
    maxPerCycle: intOr(env.ALERT_MAX_PER_CYCLE, 10, 1, 100),
    warnings,
    /** Strings the redactor must scrub. */
    secrets: [telegram?.token, webhook?.url, webhookRaw].filter(Boolean),
    /** Hosts to add to the runtime egress allowlist (ADR-0008). */
    hosts: [telegram ? TELEGRAM_HOST : null, webhook?.host].filter(Boolean),
  };
}

const LABEL = {
  "strong-bull": "STRONG BULLISH Master Signal",
  "strong-bear": "STRONG BEARISH Master Signal",
  "rev-up": "reversal UP",
  "rev-down": "reversal DOWN",
};

export function formatSignal(kind, row, extra = "") {
  return [
    `rsL Confluence: ${row.pair} ${LABEL[kind] ?? kind}${extra}`,
    `${row.src} ${row.tf} · ${row.ac} · score ${row.sc}`,
    `Bar close: ${fmtUtc(row.tc)}`,
    `Engine: ${row.cfg}`,
    DISCLAIMER,
  ].join("\n");
}

export function createAlerter({ outDir, config, guard, redact = String, log = () => {}, ctx }) {
  const enabled = Boolean(config.telegram || config.webhook);
  const path = join(outDir, "alerts-state.json");
  const blank = () => ({ schema: 1, sent: {}, cool: {}, series: {}, outbox: [], failure: { alertedFor: null } });
  let state = blank();
  if (enabled) {
    const loaded = readJson(path, null);
    if (loaded?.schema === 1) state = { ...blank(), ...loaded };
  }
  const queue = [];
  const persist = () => {
    if (enabled) writeJsonAtomic(path, state);
  };

  const seriesKey = (r) => `${r.cfg}|${r.src}|${r.tf}|${r.pair}`;

  function enqueue(key, kind, text, fields, now) {
    if (state.sent[key]) return false; // already sent (or sending) — never twice
    queue.push({ key, kind, text, fields, now });
    return true;
  }

  /** Catch-up rows: advance per-series state only (bar order), never alert. */
  function observe(rows) {
    if (!enabled) return;
    for (const r of [...rows].sort((a, b) => a.t - b.t)) {
      const prev = state.series[seriesKey(r)];
      if (!prev || r.t > prev.t) state.series[seriesKey(r)] = { t: r.t, m: r.m, st: r.st };
    }
  }

  /**
   * Live rows of this cycle with their scores ({ row, score }).
   * `intervalMs` scales the cooldown; `now` is wall-clock time.
   */
  function evaluate(items, intervalMs, now = Date.now()) {
    if (!enabled) return 0;
    let queued = 0;
    const cooldownMs = config.cooldownBars * intervalMs;
    const cooled = (r, kind) => {
      const last = state.cool[`${seriesKey(r)}|${kind}`];
      return last !== undefined && r.t - last < cooldownMs;
    };
    for (const { row: r, score } of [...items].sort((a, b) => a.row.t - b.row.t)) {
      const key = seriesKey(r);
      const prev = state.series[key];
      if (prev && r.t <= prev.t) continue; // bar already evaluated (restart within the bar)
      const kinds = [];
      // Into STRONG: a known previous state that was not STRONG in this direction.
      if (r.st === 2 && r.m !== 0 && !r.sup && prev && !(prev.st === 2 && prev.m === r.m)) kinds.push(r.m > 0 ? "strong-bull" : "strong-bear");
      // Reversal: identical filter to the app's alert (page.tsx activeReversals).
      const rev = score?.reversal;
      if (rev && rev.isReversal && rev.direction !== "NONE" && (rev.confidence === "HIGH" || rev.confidence === "MODERATE")) kinds.push(rev.direction === "UP" ? "rev-up" : "rev-down");
      for (const kind of kinds) {
        if (cooled(r, kind)) continue;
        const extra = kind.startsWith("rev") ? ` (${rev.confidence})` : "";
        if (enqueue(`${key}|${r.t}|${kind}`, kind, formatSignal(kind, r, extra), { pair: r.pair, src: r.src, tf: r.tf, ac: r.ac, cfg: r.cfg, score: r.sc, barOpen: r.t, barClose: r.tc }, now)) {
          state.cool[`${key}|${kind}`] = r.t;
          queued++;
        }
      }
      state.series[key] = { t: r.t, m: r.m, st: r.st };
    }
    return queued;
  }

  /** Recorder health after each cycle. */
  function health({ ok, consecutiveFailures, streakStartedAt, lastError, now = Date.now() }) {
    if (!enabled) return;
    const head = `${ctx.src} ${ctx.tf} · ${ctx.ac} · engine ${ctx.cfg}`;
    if (!ok && consecutiveFailures >= FAILURE_STREAK && state.failure.alertedFor !== streakStartedAt) {
      state.failure.alertedFor = streakStartedAt;
      enqueue(`failure|${ctx.src}|${ctx.tf}|${streakStartedAt}`, "failure",
        [`rsL Confluence recorder: ${consecutiveFailures} consecutive failed cycles`, head, `Failing since: ${fmtUtc(streakStartedAt)}`, `Last error: ${redact(lastError).slice(0, 300)}`, "Signals are not being recorded.", DISCLAIMER].join("\n"),
        { failures: consecutiveFailures, since: streakStartedAt }, now);
    } else if (ok && state.failure.alertedFor) {
      const since = state.failure.alertedFor;
      state.failure.alertedFor = null;
      enqueue(`recovered|${ctx.src}|${ctx.tf}|${since}`, "recovered",
        [`rsL Confluence recorder: recording again`, head, `Was failing since: ${fmtUtc(since)}`, DISCLAIMER].join("\n"), { since }, now);
    }
  }

  /** Stale heartbeat (start-up after downtime, or the --check-heartbeat watchdog). */
  function deadman({ lastSuccessAt, staleForMs, now = Date.now(), detail = "" }) {
    if (!enabled) return false;
    return enqueue(`deadman|${ctx.src}|${ctx.tf}|${lastSuccessAt}`, "deadman",
      [`rsL Confluence recorder: no successful cycle for ${Math.round(staleForMs / 60_000)} min`, `${ctx.src} ${ctx.tf} · ${ctx.ac}`, `Last success: ${lastSuccessAt ? fmtUtc(lastSuccessAt) : "never"}`, detail, DISCLAIMER].filter(Boolean).join("\n"),
      { lastSuccessAt }, now);
  }

  /* -------------------------------- sending -------------------------------- */
  async function sendTelegram(text, signal) {
    const { token, chatId } = config.telegram;
    // Host written literally so tools/check-egress.mjs can verify it.
    const res = await guard.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal,
    });
    if (res.ok) return { ok: true };
    let retryAfter = 0;
    try {
      retryAfter = Number((await res.json())?.parameters?.retry_after) || 0;
    } catch { /* body is not JSON */ }
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, retryAfterMs: retryAfter * 1000, error: `Telegram HTTP ${res.status}` };
  }

  async function sendWebhook(item, signal) {
    const res = await guard.fetch(config.webhook.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "rsl-confluence-recorder", kind: item.kind, text: item.text, disclaimer: DISCLAIMER, ...item.fields }),
      signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, retryAfterMs: 0, error: `webhook HTTP ${res.status}` };
  }

  /** Send everything queued this cycle plus due retries. Never throws. */
  async function flush(signal, now = Date.now()) {
    if (!enabled) return { sent: 0, failed: 0 };
    // Over the cap: the rest become one summary line instead of a flood.
    if (queue.length > config.maxPerCycle) {
      const rest = queue.splice(config.maxPerCycle - 1);
      for (const r of rest) state.sent[r.key] = now; // counted as delivered via the summary
      queue.push({ key: `summary|${now}`, kind: "summary", now, fields: { count: rest.length },
        text: [`rsL Confluence: ${rest.length} more alerts this cycle`, rest.map((r) => r.text.split("\n")[0].replace("rsL Confluence: ", "")).slice(0, 30).join("; "), DISCLAIMER].join("\n") });
    }
    for (const item of queue.splice(0)) {
      state.sent[item.key] = now;
      state.outbox.push({ ...item, channels: [config.telegram && "telegram", config.webhook && "webhook"].filter(Boolean), attempts: 0, firstAt: now, nextAt: now });
    }
    // Mark-before-send: persisted now, so a crash mid-send cannot cause a repeat.
    prune(now);
    persist();
    let sent = 0;
    let failed = 0;
    for (const item of state.outbox) {
      if (item.nextAt > now || signal?.aborted) continue;
      item.attempts++;
      for (const ch of [...item.channels]) {
        let result;
        try {
          result = ch === "telegram" ? await sendTelegram(item.text, signal) : await sendWebhook(item, signal);
        } catch (error) {
          result = { ok: false, permanent: false, retryAfterMs: 0, error: error instanceof Error ? error.message : String(error) };
        }
        if (result.ok || result.permanent) item.channels = item.channels.filter((c) => c !== ch);
        if (result.ok) sent++;
        else {
          failed++;
          log(`alert ${item.kind} via ${ch} failed${result.permanent ? " (dropped)" : ""}: ${redact(result.error)}`);
          if (result.retryAfterMs) item.nextAt = now + result.retryAfterMs;
        }
      }
      if (item.channels.length && item.nextAt <= now) item.nextAt = now + 60_000 * 2 ** item.attempts;
    }
    state.outbox = state.outbox.filter((i) => i.channels.length && i.attempts < MAX_ATTEMPTS && now - i.firstAt < RETRY_WINDOW_MS);
    persist();
    return { sent, failed };
  }

  function prune(now) {
    for (const [k, at] of Object.entries(state.sent)) if (now - at > SENT_TTL_MS) delete state.sent[k];
    for (const [k, s] of Object.entries(state.series)) if (now - s.t > SERIES_TTL_MS) delete state.series[k];
    for (const [k, t] of Object.entries(state.cool)) if (now - t > SERIES_TTL_MS) delete state.cool[k];
  }

  return {
    enabled,
    channels: [config.telegram && "telegram", config.webhook && "webhook"].filter(Boolean),
    observe,
    evaluate,
    health,
    deadman,
    flush,
    pending: () => queue.length + state.outbox.length,
    /** Save state that changed without a send (e.g. series updates). */
    save: persist,
  };
}
