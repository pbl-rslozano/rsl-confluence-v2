/**
 * liquidation-feed.ts — v2.8 Step 4b (plan WP25, Task 2): the two liquidation websockets behind the radar gate.
 *
 * Context, never a vote: nothing here reaches scoring and nothing places a trade. The feed opens no socket until
 * `start()`; the radar runner calls `start()` / `stop()` under the same gate (`radarAllowed`) as every radar request, so
 * the default build at rest opens none (guide §16).
 *
 * Venues: Binance `!forceOrder@arr` (connected on open; Binance pushes only the latest liquidation per symbol per second,
 * so its totals are "sampled") and Bybit `allLiquidation.BTCUSDT` / `.ETHUSDT` (connected only once the subscribe is
 * acknowledged with `success: true`; `{"op":"ping"}` every 20 s). A close or error is a disconnection for the hour book
 * and a reconnect after 2 s, 4 s ... capped at 60 s (reset after 5 minutes connected). `stop()` closes both sockets,
 * clears every timer and counts as a disconnection; nothing fires afterwards (each socket carries a generation number).
 *
 * Liveness: a machine that sleeps (or a frozen tab) gets no `close`, so every roll-timer tick and message records a beat; a
 * beat more than 90 s after the previous one means the time between is a disconnection for every live venue (the slept
 * hours are never saved as complete zeros). Bybit must answer within about two ping intervals (any message, a pong
 * included) and acknowledge the subscribe within 10 s, else the socket is closed and reconnected through the backoff.
 *
 * Hours: `roll` runs on every message and every 60 s, and an hour closes only 5 s after it ends so late events still
 * count. Newly complete hours are saved (queued, merged with what is stored) into the "radar-liq" doc.
 * A read failure at load starts empty; a failed read at save time writes nothing (never overwrites what it could not read).
 */
import type { RadarThresholds } from "./alerts";
import { HourBook, LIQ_KEEP_HOURS, LIQ_KEEP_MS, normalizeLiqDoc, liquidationCascade, parseBinanceLiq, parseBybitLiq, type LiqEvent, type LiqHour, type LiqVenue } from "./liquidations";
import { RADAR_COLLECTION, RADAR_LIQ_ID, serialised, type RadarPort } from "./store";

export const BINANCE_LIQ_URL = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
export const BYBIT_LIQ_URL = "wss://stream.bybit.com/v5/public/linear";

export const LIQ_PING_MS = 20_000;
export const LIQ_ROLL_MS = 60_000;
export const LIQ_GRACE_MS = 5_000;
export const LIQ_BACKOFF_FIRST_MS = 2_000;
export const LIQ_BACKOFF_MAX_MS = 60_000;
export const LIQ_BACKOFF_RESET_MS = 5 * 60_000;
/** Beats further apart than this mean the machine slept (roll interval 60 s plus slack for background-tab throttling). */
export const LIQ_SLEEP_MS = 90_000;
/** Bybit silence (no message, pong included) tolerated before the socket is recycled: about two ping intervals. */
export const LIQ_SILENCE_MS = 45_000;
export const LIQ_SUBSCRIBE_MS = 10_000;

const WS_OPEN = 1;
const VENUES: LiqVenue[] = ["bybit", "binance"];
const URLS: Record<LiqVenue, string> = { bybit: BYBIT_LIQ_URL, binance: BINANCE_LIQ_URL };
const BYBIT_SUBSCRIBE = JSON.stringify({ op: "subscribe", args: ["allLiquidation.BTCUSDT", "allLiquidation.ETHUSDT"] });
const BYBIT_PING = JSON.stringify({ op: "ping" });

export interface WsLike {
  readyState: number;
  send(d: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", fn: (ev: any) => void): void;
}
export type WsCtor = new (url: string) => WsLike;

export interface FeedTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}
const realTimers: FeedTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface LiqVenueView {
  connected: boolean;
  since: number | null;
  long: number;
  short: number;
  coveredMs: number;
  complete: boolean;
  /** Binance pushes only the latest liquidation per symbol per second: its totals are a sample. */
  sampled: boolean;
  cascade: ReturnType<typeof liquidationCascade>;
}
export type LiqView = Record<LiqVenue, LiqVenueView>;

export interface LiquidationFeed {
  start(): void;
  stop(): void;
  running(): boolean;
  view(now: number, th: RadarThresholds): LiqView;
}

export interface LiquidationFeedDeps {
  WebSocketCtor: WsCtor;
  now: () => number;
  store: RadarPort;
  timers?: FeedTimers;
}

interface Slot {
  gen: number;
  ws: WsLike | null;
  connected: boolean;
  since: number | null;
  attempt: number;
  reconnect: unknown;
  ping: unknown;
  /** Pending "no subscribe reply" deadline (Bybit). */
  sub: unknown;
  /** Time of the last frame received on the current socket. */
  lastRx: number;
}

/** Union by hour (first wins), oldest first, newest LIQ_KEEP_HOURS, none older than LIQ_KEEP_MS before `now`. */
function mergeHours(now: number, ...lists: LiqHour[][]): LiqHour[] {
  const byH = new Map<number, LiqHour>();
  for (const l of lists) for (const x of l) if (!byH.has(x.h)) byH.set(x.h, x);
  const out = [...byH.values()].filter((x) => x.h >= now - LIQ_KEEP_MS).sort((a, b) => a.h - b.h);
  return out.length > LIQ_KEEP_HOURS ? out.slice(out.length - LIQ_KEEP_HOURS) : out;
}

export function createLiquidationFeed(deps: LiquidationFeedDeps): LiquidationFeed {
  const timers = deps.timers ?? realTimers;
  const books: Record<LiqVenue, HourBook> = { bybit: new HourBook("bybit"), binance: new HourBook("binance") };
  /** Hours read back from the store (the books only know what this session saw). */
  let loaded: Record<LiqVenue, LiqHour[]> = { bybit: [], binance: [] };
  const slots: Record<LiqVenue, Slot> = {
    bybit: { gen: 0, ws: null, connected: false, since: null, attempt: 0, reconnect: null, ping: null, sub: null, lastRx: 0 },
    binance: { gen: 0, ws: null, connected: false, since: null, attempt: 0, reconnect: null, ping: null, sub: null, lastRx: 0 },
  };
  let isRunning = false;
  let rollTimer: unknown = null;
  let lastBeat: number | null = null;

  const clock = (): number => { const t = deps.now(); return Number.isFinite(t) ? t : 0; };

  const readDoc = async (): Promise<Record<LiqVenue, LiqHour[]>> => normalizeLiqDoc((await deps.store.get(RADAR_COLLECTION, RADAR_LIQ_ID) as { hours?: unknown } | null)?.hours, clock());

  // Load what an earlier session stored. A failure starts empty and never throws.
  void (async () => {
    try { loaded = await readDoc(); } catch { /* start empty */ }
  })();

  function persist(): Promise<void> {
    return serialised(async () => {
      try {
        const stored = await readDoc(); // a throw here skips the write
        const now = clock();
        const hours = { bybit: mergeHours(now, stored.bybit, books.bybit.hours(), loaded.bybit), binance: mergeHours(now, stored.binance, books.binance.hours(), loaded.binance) };
        await deps.store.put(RADAR_COLLECTION, RADAR_LIQ_ID, { v: 1, hours });
      } catch { /* the hours stay in memory; the next save writes them */ }
    });
  }

  function rollAll(): void {
    const now = clock();
    let any = false;
    for (const v of VENUES) if (books[v].roll(now, LIQ_GRACE_MS).length) any = true;
    if (any) void persist();
  }

  function clearSlotTimers(s: Slot): void {
    if (s.reconnect !== null) { timers.clearTimeout(s.reconnect); s.reconnect = null; }
    if (s.ping !== null) { timers.clearInterval(s.ping); s.ping = null; }
    if (s.sub !== null) { timers.clearTimeout(s.sub); s.sub = null; }
  }

  /** Record a sign of life. A long silence of the whole feed means the machine slept: the time between is a disconnection. */
  function beat(): void {
    const now = clock();
    if (lastBeat !== null && now - lastBeat > LIQ_SLEEP_MS) {
      for (const v of VENUES) {
        if (!slots[v].connected) continue;
        books[v].disconnected(lastBeat);
        books[v].connected(now);
      }
    }
    if (lastBeat === null || now > lastBeat) lastBeat = now;
  }

  function markConnected(v: LiqVenue, s: Slot): void {
    if (s.connected) return;
    const t = clock();
    if (s.sub !== null) { timers.clearTimeout(s.sub); s.sub = null; }
    s.connected = true;
    s.since = t;
    books[v].connected(t);
  }

  /** A socket went down (close or error): once per socket, the slot's generation says whether it is still the current one. */
  function down(v: LiqVenue, s: Slot, gen: number): void {
    if (!isRunning || s.gen !== gen) return;
    beat(); // a wake-up first: the slept time is a gap that began at the last beat, not at this close
    s.gen++; // later events of this socket (an error, then its close) are ignored
    const t = clock();
    const wasUpFor = s.connected && s.since !== null ? t - s.since : 0;
    if (s.ws) { try { s.ws.close(); } catch { /* already closed */ } s.ws = null; }
    if (s.ping !== null) { timers.clearInterval(s.ping); s.ping = null; }
    if (s.sub !== null) { timers.clearTimeout(s.sub); s.sub = null; }
    s.connected = false;
    s.since = null;
    books[v].disconnected(t);
    if (wasUpFor >= LIQ_BACKOFF_RESET_MS) s.attempt = 0;
    const delay = Math.min(LIQ_BACKOFF_MAX_MS, LIQ_BACKOFF_FIRST_MS * 2 ** s.attempt);
    s.attempt++;
    s.reconnect = timers.setTimeout(() => { s.reconnect = null; if (isRunning) open(v); }, delay);
  }

  function onMessage(v: LiqVenue, s: Slot, gen: number, data: unknown): void {
    beat();
    s.lastRx = clock();
    if (typeof data !== "string") return;
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { return; }
    const now = clock();
    if (v === "bybit" && msg && typeof msg === "object" && (msg as { op?: unknown }).op === "subscribe") {
      if ((msg as { success?: unknown }).success === true) markConnected(v, s);
      else down(v, s, gen); // the subscribe was refused: close and retry through the backoff
      return;
    }
    const events: LiqEvent[] = v === "bybit" ? parseBybitLiq(msg, now) : parseBinanceLiq(msg, now);
    for (const e of events) books[v].add(e);
    rollAll();
  }

  function open(v: LiqVenue): void {
    const s = slots[v];
    const gen = ++s.gen;
    let ws: WsLike;
    try {
      ws = new deps.WebSocketCtor(URLS[v]);
    } catch {
      down(v, s, gen); // a constructor that throws is a failed connection: back off and retry
      return;
    }
    s.ws = ws;
    s.lastRx = clock();
    const live = () => isRunning && s.gen === gen;
    ws.addEventListener("open", () => {
      if (!live()) return;
      if (v === "binance") { markConnected(v, s); return; }
      s.lastRx = clock();
      try { ws.send(BYBIT_SUBSCRIBE); } catch { /* the close handler reconnects */ }
      if (s.sub !== null) timers.clearTimeout(s.sub);
      s.sub = timers.setTimeout(() => { s.sub = null; if (live() && !s.connected) down(v, s, gen); }, LIQ_SUBSCRIBE_MS);
      if (s.ping !== null) timers.clearInterval(s.ping);
      s.ping = timers.setInterval(() => {
        if (!live()) return;
        if (clock() - s.lastRx > LIQ_SILENCE_MS) { down(v, s, gen); return; } // no pong, no frame: the socket is dead
        if (ws.readyState !== WS_OPEN) return;
        try { ws.send(BYBIT_PING); } catch { /* the close handler reconnects */ }
      }, LIQ_PING_MS);
    });
    ws.addEventListener("message", (ev) => { if (live()) onMessage(v, s, gen, ev?.data); });
    ws.addEventListener("close", () => down(v, s, gen));
    ws.addEventListener("error", () => down(v, s, gen));
  }

  return {
    start() {
      if (isRunning) return;
      isRunning = true;
      lastBeat = clock();
      rollTimer = timers.setInterval(() => { if (isRunning) { beat(); rollAll(); } }, LIQ_ROLL_MS);
      for (const v of VENUES) open(v);
    },
    stop() {
      if (!isRunning) return;
      isRunning = false;
      lastBeat = null;
      const t = clock();
      if (rollTimer !== null) { timers.clearInterval(rollTimer); rollTimer = null; }
      for (const v of VENUES) {
        const s = slots[v];
        s.gen++;
        clearSlotTimers(s);
        if (s.ws) { try { s.ws.close(); } catch { /* already closed */ } s.ws = null; }
        s.connected = false;
        s.since = null;
        books[v].disconnected(t); // time while stopped is not covered
      }
    },
    running: () => isRunning,
    view(now, th) {
      const out = {} as LiqView;
      for (const v of VENUES) {
        const s = slots[v];
        const l = books[v].last60(now);
        const hours = mergeHours(now, books[v].hours(), loaded[v]);
        out[v] = {
          connected: s.connected,
          since: s.since,
          long: l.long,
          short: l.short,
          coveredMs: l.coveredMs,
          complete: l.complete,
          sampled: v === "binance",
          cascade: liquidationCascade(v, hours, l, th, now),
        };
      }
      return out;
    },
  };
}
