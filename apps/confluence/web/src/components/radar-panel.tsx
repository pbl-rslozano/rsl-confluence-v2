"use client";
/**
 * radar-panel.tsx — v2.8 Step 4a (plan WP25, Task 6): the Radar tab and panel.
 *
 * Context, never a vote: nothing here reaches scoring, and no alert blocks or places a trade. The panel describes the
 * market through BTC (spec WP25). It is the only thing that starts the radar runner, and only while it is open (or while
 * `recordRadar` is on, which Task 7 adds): before the first open no radar host is contacted (RD-1).
 *
 * Mounting: the tab is portal-mounted on document.body (outside header, main and footer, so the design-unchanged guard
 * DS-1 / DS-2 does not measure it); the sheet portals itself. The sheet is non-modal (no overlay, no focus trap) so the
 * list stays usable beside it at >= 1024 px; below that it is a bottom sheet (max 80 vh).
 * Keys: one window keydown listener for R (ignored while typing, with a modifier, or while another dialog is open);
 * Esc is the sheet's own.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useRsl } from "@/rsl/RslContext";
import { ThanksSection } from "@/rsl/components/AboutDialog";
import { getLanguage } from "@rsl/core-kit/core/rsl-i18n.js";
import { useMediaQuery } from "@/lib/use-media-query";
import { shouldToggleRadar } from "@/lib/radar/radar-keys";
import { PROVIDERS } from "@/lib/providers";
import type { DepegReading } from "@/lib/quotes";
import { DEFAULT_THRESHOLDS, type RadarAlert, type RadarThresholds } from "@/lib/radar/alerts";
import { createLiquidationFeed } from "@/lib/radar/liquidation-feed";
import { createRadarRunner, radarAllowed, realFetchers, type RadarRunner, type RadarSnapshot } from "@/lib/radar/snapshot";
import { etfDailyTotals, parseEtfCsv, type EtfFlow } from "@/lib/radar/etf-csv";
import { loadEtfRows, saveEtfRows, type RadarPort } from "@/lib/radar/store";
import type { CotReport, CotGroup } from "@/lib/radar/cftc";
import type { FuturesPositioning } from "@/lib/radar/binance-futures";
import { THRESHOLD_FIELDS, radarUiSnapshot, setRadarOpen, setRadarSectionCollapsed, setRadarThresholds, useRadarUi, type RadarSection } from "@/lib/radar/radar-ui";

type T = (key: string, vars?: Record<string, string | number>) => string;
const DESKTOP_QUERY = "(min-width: 1024px)";
const PANEL_WIDTH = 420;
const ETF_MAX_BYTES = 1_000_000;

export interface RadarHostProps {
  /** The app's storage port (the "meta" collection holds the radar cache, ETF rows and context log). */
  port: RadarPort;
  /** The scan's current stablecoin readings (no fetch) and the scan source they came from. */
  depeg: DepegReading[] | undefined;
  depegSource: string;
  /** When the scan took those readings (ms): the depeg alert's "since". Without it the refresh time is used. */
  depegAt?: number;
  /** Record radar context setting (Task 7). False until it exists. */
  recordRadar?: boolean;
}

const TAB_SELECTOR = '[data-testid="radar-tab"]';
const focusTab = () => (document.querySelector(TAB_SELECTOR) as HTMLElement | null)?.focus();

/** Bottom edge (px) of the app header while `active`, kept current on resize; 0 when there is no header. */
function useHeaderBottom(active: boolean): number {
  const subscribe = useCallback((cb: () => void) => {
    if (!active) return () => undefined;
    const header = document.querySelector("header");
    const ro = typeof ResizeObserver === "undefined" || !header ? null : new ResizeObserver(cb);
    if (header) ro?.observe(header);
    window.addEventListener("resize", cb);
    return () => { ro?.disconnect(); window.removeEventListener("resize", cb); };
  }, [active]);
  const get = useCallback(() => (active ? Math.max(0, Math.round(document.querySelector("header")?.getBoundingClientRect().bottom ?? 0)) : 0), [active]);
  return useSyncExternalStore(subscribe, get, () => 0);
}

export function RadarHost({ port, depeg, depegSource, depegAt, recordRadar = false }: RadarHostProps) {
  const rsl = useRsl();
  const { t } = rsl;
  const ui = useRadarUi();
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const rtl = getLanguage(rsl.lang)?.dir === "rtl";
  const mounted = useSyncExternalStore(() => () => undefined, () => true, () => false);
  const headerBottom = useHeaderBottom(ui.open && desktop);
  /** True when the user (tab or R key) opened the panel: only then does opening move the focus into it. */
  const userOpened = useRef(false);

  /* ---- runner: created once; its getters read the latest props through refs ---- */
  const live = useRef({ open: ui.open, record: recordRadar, thresholds: ui.thresholds, depeg: depeg ?? [], source: depegSource, depegAt });
  useEffect(() => { live.current = { open: ui.open, record: recordRadar, thresholds: ui.thresholds, depeg: depeg ?? [], source: depegSource, depegAt }; });
  const runnerRef = useRef<RadarRunner | null>(null);
  const [snap, setSnap] = useState<RadarSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const allowed = radarAllowed({ panelOpen: ui.open, recordRadar });

  useEffect(() => {
    const runner = createRadarRunner({
      now: () => Date.now(),
      fetchers: realFetchers,
      store: port,
      thresholds: () => live.current.thresholds,
      depeg: () => live.current.depeg,
      depegSource: () => live.current.source,
      depegAt: () => live.current.depegAt,
      allowed: () => radarAllowed({ panelOpen: live.current.open, recordRadar: live.current.record }),
      // One feed per runner: its sockets open only when the runner starts (the gate above) and close when it stops.
      liquidations: createLiquidationFeed({ WebSocketCtor: WebSocket, now: () => Date.now(), store: port }),
    });
    runnerRef.current = runner;
    setSnap(runner.latest());
    const off = runner.subscribe((s, info) => { setSnap(s); setFailed(!!info?.lastError); });
    return () => { off(); runner.stop(); runnerRef.current = null; };
  }, [port]);

  // The gate: start while allowed, stop otherwise (the timers stop; nothing is requested).
  useEffect(() => {
    const runner = runnerRef.current;
    if (!runner) return;
    if (allowed) runner.start(); else runner.stop();
  }, [allowed, port]);

  // A changed threshold re-runs the alert rules over the last fetched inputs: no request, no log row.
  const thKey = JSON.stringify(ui.thresholds);
  useEffect(() => { runnerRef.current?.rethreshold(); }, [thKey]);

  // Only an OPEN by the user moves focus into the panel; closing must not leave the flag set (a later cross-tab open would steal focus).
  const toggle = useCallback(() => { userOpened.current = !live.current.open; setRadarOpen(!live.current.open); }, []);

  /* ---- the R key ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shouldToggleRadar(e, document)) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  if (!mounted) return null;
  const side = desktop ? (rtl ? "left" : "right") : "bottom";
  // The tab sits at the inline end of the page (physical right; physical left in RTL) and is hidden while the panel is open:
  // the panel has its own close control. Physical properties on purpose: the tab uses a vertical writing mode.
  const tab = ui.open ? null : createPortal(
    <button
      type="button"
      data-testid="radar-tab"
      aria-expanded={false}
      aria-controls="radar-panel"
      aria-label={t("radar.tabLabel")}
      title={t("radar.tabLabel")}
      onClick={toggle}
      style={{ position: "fixed", [rtl ? "left" : "right"]: 0, top: "50%", transform: "translateY(-50%)", zIndex: 25 }}
      className={`${rtl ? "rounded-r-md border-l-0" : "rounded-l-md border-r-0"} border border-zinc-700 bg-zinc-900 px-1.5 py-3 text-xs font-semibold tracking-wide text-zinc-100 shadow-md hover:bg-zinc-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400 [writing-mode:vertical-rl]`}
    >
      {t("radar.tab")}
    </button>,
    document.body,
  );
  return (
    <>
      {tab}
      <Sheet open={ui.open} onOpenChange={setRadarOpen} modal={false}>
        <SheetContent
          side={side}
          id="radar-panel"
          data-testid="radar-panel"
          data-side={side}
          closeLabel={t("radar.close")}
          style={desktop ? { top: headerBottom, height: `calc(100dvh - ${headerBottom}px)` } : undefined}
          className={
            "radar-sheet gap-0 overflow-y-auto border-zinc-800 bg-zinc-900 p-0 text-zinc-100 " +
            (desktop ? "w-[420px] max-w-[100vw] sm:max-w-[420px]" : "max-h-[80vh] w-full")
          }
          aria-labelledby="radar-title"
          aria-describedby="radar-desc"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (userOpened.current) document.getElementById("radar-title")?.focus();
            userOpened.current = false;
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const a = document.activeElement;
            // Focus was in the closed panel (or dropped to the page): give it back to the tab.
            if (!a || a === document.body) focusTab();
          }}
          onFocusOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => {
            // The list stays usable beside the panel on a wide screen; the bottom sheet closes on a tap outside.
            if (desktop) e.preventDefault();
          }}
        >
          <RadarBody snap={snap} failed={failed} ui={ui} port={port} t={t} formatNumber={rsl.i18n.formatNumber} formatDate={rsl.i18n.formatDate} />
        </SheetContent>
      </Sheet>
    </>
  );
}

/* ------------------------------------------------------------------ */

interface BodyProps {
  snap: RadarSnapshot | null;
  failed: boolean;
  ui: { collapsed: string[]; thresholds: RadarThresholds };
  port: RadarPort;
  t: T;
  formatNumber: (n: number, opt?: Intl.NumberFormatOptions) => string;
  formatDate: (d: Date | number, opt?: Intl.DateTimeFormatOptions) => string;
}

const providerName = (id: string) => PROVIDERS.find((p) => p.id === id)?.name ?? id;
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** A usable time: a finite number above 0 (an asOf of 0 means "no time", never shown). */
const usable = (ms: unknown): ms is number => isNum(ms) && ms > 0;

function RadarBody({ snap, failed, ui, port, t, formatNumber, formatDate }: BodyProps) {
  const num = (n: number, dp: number, signed = false) =>
    formatNumber(n, { minimumFractionDigits: dp, maximumFractionDigits: dp, signDisplay: signed ? "exceptZero" : "auto" });
  const pct = (n: number | null | undefined, dp = 2, signed = true) => (isNum(n) ? `${num(n, dp, signed)} %` : "—");
  // The time of day; with the date when it is not today (day-old data must not look current).
  const clock = (ms: number) =>
    new Date(ms).toDateString() === new Date().toDateString()
      ? formatDate(ms, { timeStyle: "short", hour12: false })
      : formatDate(ms, { dateStyle: "medium", timeStyle: "short", hour12: false });
  const day = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? iso : formatDate(d, { dateStyle: "medium", timeZone: "UTC" });
  };
  const usd = (n: number, signed = false) =>
    formatNumber(n, { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2, signDisplay: signed ? "exceptZero" : "auto" });
  const whole = (n: number) => formatNumber(Math.round(n), { maximumFractionDigits: 0 });
  // A signed whole number: the sign comes from the locale formatter (it carries its own direction mark), never a hand-built "+": right in RTL.
  const sign = (n: number) => formatNumber(Math.round(n), { maximumFractionDigits: 0, signDisplay: "exceptZero" });

  const stale = snap?.stale ?? {};
  const gone = new Set(snap?.unavailable ?? []);
  /** The time a premium row's shown value was last good, when that source did not answer this time (else undefined). */
  const rowStale = (id: "us" | "kr" | "ph") => stale[`regional:${id}`] ?? stale.regional;
  /** The "Updated" line of a section: its data time (else the snapshot's time), or the unavailable line. */
  const status = (id: string, keys: string[], dataTime?: number, alsoStale: string[] = []) => {
    const staleAt = [...keys, ...alsoStale].map((k) => stale[k]).filter((x) => isNum(x));
    const allGone = keys.length > 0 && keys.every((k) => gone.has(k));
    if (!snap) return null;
    if (allGone) return <span data-testid={`radar-status-${id}`} className="text-amber-300">{t("radar.unavailable")}</span>;
    if (staleAt.length) {
      const last = Math.min(...staleAt);
      return <span data-testid={`radar-status-${id}`} className="text-amber-300">{usable(last) ? t("radar.unavailableLast", { time: clock(last) }) : t("radar.unavailable")}</span>;
    }
    return <span data-testid={`radar-status-${id}`} className="text-zinc-400">{t("radar.updated", { time: clock(usable(dataTime) ? dataTime : snap.t) })}</span>;
  };

  const posTimes = snap ? ([snap.positioning.BTCUSDT?.asOf, snap.positioning.ETHUSDT?.asOf].filter(usable) as number[]) : [];
  const alertsTime = snap?.t;

  return (
    <div className="flex flex-col">
      <div className="px-4 pb-2 pt-4 pr-12">
        <SheetTitle id="radar-title" tabIndex={-1} className="text-base outline-none">{t("radar.title")}</SheetTitle>
        <SheetDescription id="radar-desc" className="mt-1 text-xs text-zinc-400">{t("radar.desc")}</SheetDescription>
        {failed && <p role="status" data-testid="radar-error" className="mt-2 text-xs text-amber-300">{t("radar.error")}</p>}
        {!snap && <p data-testid="radar-loading" className="mt-2 text-xs text-zinc-400">{t("radar.loading")}</p>}
      </div>

      {/* ---------- Positioning ---------- */}
      <Sec collapsed={ui.collapsed} id="positioning" title={t("radar.sec.positioning")}
        right={status("positioning", ["positioning:BTCUSDT", "positioning:ETHUSDT"], posTimes.length ? Math.max(...posTimes) : undefined)}>
        <p className="text-zinc-400">{t("radar.pos.note")}</p>
        {(["BTCUSDT", "ETHUSDT"] as const).map((sym) => (
          <PositioningRow key={sym} sym={sym} p={snap?.positioning[sym] ?? null} staleAt={stale[`positioning:${sym}`]}
            gone={gone.has(`positioning:${sym}`)} t={t} num={num} pct={pct} whole={whole} clock={clock} loaded={!!snap} />
        ))}
      </Sec>

      {/* ---------- Buyer pressure ---------- */}
      <Sec collapsed={ui.collapsed} id="buyer" title={t("radar.sec.buyer")} right={status("buyer", ["buyer"], snap?.buyer?.asOf)}>
        {snap?.buyer ? (
          <>
            <p className="text-zinc-400">{t("radar.buyer.note")}</p>
            <Sparkline values={snap.buyer.takerShare.slice(-24)} label={t("radar.buyer.spark")} />
            <SessionShares s={snap.buyer.sessions} t={t} whole={whole} />
          </>
        ) : snap ? <p className="text-amber-300">{t("radar.unavailable")}</p> : null}
      </Sec>

      {/* ---------- Regional demand ---------- */}
      <Sec collapsed={ui.collapsed} id="regional" title={t("radar.sec.regional")} right={status("regional", ["regional"], snap?.regional?.asOf, ["regional:us", "regional:kr", "regional:ph"])}>
        <p className="text-zinc-400">{t("radar.reg.note")}</p>
        {([
          ["us", snap?.regional?.usPct, "radar.reg.usNote", "coinbase"],
          ["kr", snap?.regional?.krPct, "radar.reg.krNote", "upbit"],
          ["ph", snap?.regional?.phPct, "radar.reg.phNote", "coinsph"],
        ] as const).map(([id, value, noteKey, src]) => (
          <div key={id} data-testid={`radar-prem-${id}`} className="rounded border border-zinc-800 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-zinc-100">{t(`radar.reg.${id}`)}</span>
              <span className="font-mono text-sm" dir="ltr" data-testid={`radar-prem-${id}-value`}>
                {isNum(value) ? pct(value, 2, true) : <span className="text-amber-300">{snap ? t("radar.unavailable") : "—"}</span>}
              </span>
            </div>
            {isNum(value) && isNum(rowStale(id)) && (
              <p className="mt-0.5 text-[11px] text-amber-300" data-testid={`radar-prem-${id}-stale`}>
                {usable(rowStale(id)) ? t("radar.unavailableLast", { time: clock(rowStale(id) as number) }) : t("radar.unavailable")}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-zinc-400" data-testid={`radar-prem-${id}-note`} data-source={src}>{t(noteKey)}</p>
          </div>
        ))}
      </Sec>

      {/* ---------- Institutions ---------- */}
      <Sec collapsed={ui.collapsed} id="institutions" title={t("radar.sec.institutions")}
        right={status("institutions", ["cot:BTC", "cot:ETH"])}>
        <p className="text-zinc-400">{t("radar.inst.note")}</p>
        {(["BTC", "ETH"] as const).map((a) => (
          <CotBlock key={a} asset={a} r={snap?.cot[a] ?? null} staleAt={stale[`cot:${a}`]} loaded={!!snap}
            t={t} whole={whole} sign={sign} day={day} clock={clock} />
        ))}
        <p>
          <a className="text-cyan-300 underline-offset-2 hover:underline" data-testid="radar-cot-source" href={PROVIDERS.find((p) => p.id === "cftc")?.apiDocs} target="_blank" rel="noopener noreferrer">
            {t("radar.inst.source")}
          </a>
        </p>
        <EtfBlock port={port} t={t} usd={usd} day={day} />
        <GatewayRow label={t("radar.etf.live")} testId="radar-etf-live" t={t} />
      </Sec>

      {/* ---------- Alerts ---------- */}
      <Sec collapsed={ui.collapsed} id="alerts" title={t("radar.sec.alerts")}
        right={status("alerts", ["breakaway", "supply"], alertsTime)}>
        <p className="text-zinc-400">{t("radar.alerts.note")}</p>
        {snap && snap.alerts.length === 0 && <p data-testid="radar-alerts-none">{t("radar.alerts.none")}</p>}
        <ul className="space-y-1.5" data-testid="radar-alerts">
          {(snap?.alerts ?? []).map((a) => <AlertItem key={a.code} a={a} th={ui.thresholds} t={t} num={num} pct={pct} usd={usd} clock={clock} staleAt={a.kind === "breakaway" ? stale.breakaway : undefined} />)}
        </ul>
        <LeftOut snap={snap} t={t} />
        <Thresholds value={ui.thresholds} t={t} />
        <GatewayRow label={t("radar.whale")} testId="radar-whale" t={t} />
        <p>
          <a className="text-cyan-300 underline-offset-2 hover:underline" data-testid="radar-hacks-link" href="https://defillama.com/hacks" target="_blank" rel="noopener noreferrer">
            {t("radar.hacks")}
          </a>
        </p>
      </Sec>

      {/* ---------- Data sources & thanks ---------- */}
      <div className="px-4 pb-4">
        <ThanksSection testId="radar-sec-sources" open={!ui.collapsed.includes("sources")}
          onToggle={(open) => setRadarSectionCollapsed("sources", !open)} />
      </div>
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Sec({ id, title, children, right, collapsed }: { id: RadarSection; title: string; children: React.ReactNode; right?: React.ReactNode; collapsed: string[] }) {
  return (
    <details
      data-testid={`radar-sec-${id}`}
      open={!collapsed.includes(id)}
      onToggle={(e) => setRadarSectionCollapsed(id, !(e.currentTarget as HTMLDetailsElement).open)}
      className="border-b border-zinc-800 px-4 py-2"
    >
      <summary className="flex cursor-pointer select-none flex-wrap items-baseline justify-between gap-x-2 py-1 text-sm font-semibold text-zinc-100">
        <span>{title}</span>
        <span className="text-[11px] font-normal">{right}</span>
      </summary>
      <div className="space-y-2 pb-2 pt-1 text-xs text-zinc-300">{children}</div>
    </details>
  );
}


function GatewayRow({ label, testId, t }: { label: string; testId: string; t: T }) {
  return <p data-testid={testId} className="rounded border border-dashed border-zinc-700 px-2 py-1.5 text-zinc-400">{t("radar.gateway", { label })}</p>;
}

function Row({ sym, label, value, id }: { sym: string; label: string; value: React.ReactNode; id: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" data-testid={`radar-${sym}-${id}`}>
      <dt className="text-zinc-400">{label}</dt>
      <dd className="font-mono text-zinc-100"><bdi>{value}</bdi></dd>
    </div>
  );
}

function PositioningRow({ sym, p, staleAt, gone, loaded, t, num, pct, whole, clock }: {
  sym: "BTCUSDT" | "ETHUSDT"; p: FuturesPositioning | null; staleAt: number | undefined; gone: boolean; loaded: boolean; t: T;
  num: (n: number, dp: number, signed?: boolean) => string; pct: (n: number | null | undefined, dp?: number, signed?: boolean) => string;
  whole: (n: number) => number | string; clock: (ms: number) => string;
}) {
  const asset = sym === "BTCUSDT" ? "BTC" : "ETH";
  const long = p && isNum(p.longShortRatio) && p.longShortRatio >= 0 ? (p.longShortRatio / (1 + p.longShortRatio)) * 100 : null;
  return (
    <div data-testid={`radar-pos-${sym}`} className="rounded border border-zinc-800 px-2 py-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-semibold text-zinc-100" dir="ltr">{asset}</span>
        {staleAt !== undefined && <span className="text-[11px] text-amber-300">{usable(staleAt) ? t("radar.unavailableLast", { time: clock(staleAt) }) : t("radar.unavailable")}</span>}
        {gone && <span className="text-[11px] text-amber-300">{t("radar.unavailable")}</span>}
      </div>
      {p ? (
        <dl className="mt-1 space-y-0.5">
          <Row sym={sym} id="funding" label={t("radar.pos.funding")}
            value={isNum(p.fundingRate) ? `${num(p.fundingRate * 100, 4, true)} %${isNum(p.fundingPctl30d) ? ` · ${t("radar.pos.pctl", { pctl: whole(p.fundingPctl30d) })}` : ""}` : "—"} />
          <Row sym={sym} id="oi" label={t("radar.pos.oi")}
            value={isNum(p.oi) ? `${whole(p.oi)} ${asset}${isNum(p.oiChg24hPct) ? ` · ${t("radar.pos.oiChg", { chg: pct(p.oiChg24hPct, 2, true) })}` : ""}` : "—"} />
          <Row sym={sym} id="ls" label={t("radar.pos.ls")}
            value={isNum(p.longShortRatio) ? `${num(p.longShortRatio, 2)}${long !== null ? ` · ${t("radar.pos.lsLong", { share: whole(long) })}` : ""}` : "—"} />
          <Row sym={sym} id="taker" label={t("radar.pos.taker")} value={isNum(p.takerBuySellRatio) ? num(p.takerBuySellRatio, 2) : "—"} />
          <Row sym={sym} id="basis" label={t("radar.pos.basis")} value={pct(p.basisPct, 2, true)} />
        </dl>
      ) : loaded && !gone && staleAt === undefined ? <p className="mt-1 text-amber-300">{t("radar.unavailable")}</p> : null}
    </div>
  );
}

function Sparkline({ values, label }: { values: (number | null)[]; label: string }) {
  const W = 240, H = 36, n = Math.max(values.length, 1), bw = W / n;
  return (
    <svg data-testid="radar-spark" role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="h-9 w-full max-w-[260px]" preserveAspectRatio="none" direction="ltr">
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="currentColor" strokeOpacity="0.25" strokeDasharray="2 2" />
      {values.map((v, i) => {
        if (!isNum(v)) return null;
        const h = Math.max(1, Math.min(1, Math.max(0, v)) * H);
        return <rect key={i} data-bar={i} x={i * bw + 0.5} y={H - h} width={Math.max(bw - 1, 1)} height={h} fill={v >= 0.5 ? "#34d399" : "#fb7185"} />;
      })}
    </svg>
  );
}

function SessionShares({ s, t, whole }: { s: { asia: number; europe: number; us: number }; t: T; whole: (n: number) => number | string }) {
  const total = s.asia + s.europe + s.us;
  if (!(total > 0)) return null;
  const share = (x: number) => whole((x / total) * 100);
  return <p data-testid="radar-sessions" dir="auto">{t("radar.buyer.sessions", { asia: share(s.asia), europe: share(s.europe), us: share(s.us) })}</p>;
}

function CotBlock({ asset, r, staleAt, loaded, t, whole, sign, day, clock }: {
  asset: "BTC" | "ETH"; r: CotReport | null; staleAt: number | undefined; loaded: boolean; t: T;
  whole: (n: number) => number | string; sign: (n: number) => string; day: (iso: string) => string; clock: (ms: number) => string;
}) {
  const group = (label: string, g: CotGroup | null, id: string) => (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2" data-testid={`radar-cot-${asset}-${id}`}>
      <span className="text-zinc-400">{label}</span>
      <span className="font-mono text-zinc-100">
        <bdi>{g ? (g.netChg !== null
          ? t("radar.inst.group", { long: whole(g.long), short: whole(g.short), net: sign(g.net), delta: sign(g.netChg) })
          : t("radar.inst.groupNoDelta", { long: whole(g.long), short: whole(g.short), net: sign(g.net) })) : "—"}</bdi>
      </span>
    </div>
  );
  return (
    <div data-testid={`radar-cot-${asset}`} className="rounded border border-zinc-800 px-2 py-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold text-zinc-100" dir="ltr">{asset}</span>
        {r && <span className="text-[11px] text-zinc-400" data-testid={`radar-cot-${asset}-date`}>{t("radar.inst.asOf", { date: day(r.reportDate) })}</span>}
      </div>
      {r ? (
        <div className="mt-1 space-y-0.5">
          {group(t("radar.inst.am"), r.assetManagers, "am")}
          {group(t("radar.inst.lf"), r.leveragedFunds, "lf")}
        </div>
      ) : loaded ? <p className="mt-1 text-amber-300">{t("radar.unavailable")}</p> : null}
      {r && staleAt !== undefined && <p className="mt-1 text-[11px] text-amber-300">{usable(staleAt) ? t("radar.unavailableLast", { time: clock(staleAt) }) : t("radar.unavailable")}</p>}
    </div>
  );
}

function EtfBlock({ port, t, usd, day }: { port: RadarPort; t: T; usd: (n: number, signed?: boolean) => string; day: (iso: string) => string }) {
  const [rows, setRows] = useState<EtfFlow[]>([]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  useEffect(() => { let live = true; void loadEtfRows(port).then((r) => { if (live) setRows(r); }); return () => { live = false; }; }, [port]);
  const days = useMemo(() => etfDailyTotals(rows, 10), [rows]);

  const onFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    if (file.size > ETF_MAX_BYTES) { setMsg({ kind: "err", text: t("radar.etf.tooBig") }); return; }
    let text: string;
    try { text = await file.text(); } catch { setMsg({ kind: "err", text: t("radar.etf.readFail") }); return; }
    const parsed = parseEtfCsv(text);
    const saved = parsed.rows.length ? await saveEtfRows(port, parsed.rows) : rows;
    if (saved === null) { setMsg({ kind: "err", text: t("radar.etf.saveFail") }); return; }
    setRows(saved);
    setMsg({ kind: "ok", text: t("radar.etf.result", { n: parsed.rows.length, rejected: parsed.rejected, duplicates: parsed.duplicates }) });
  }, [port, rows, t]);

  return (
    <div data-testid="radar-etf" className="rounded border border-zinc-800 px-2 py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-zinc-100">{t("radar.etf.title")}</span>
        <label className="cursor-pointer rounded border border-zinc-700 px-2 py-1 text-[11px] text-cyan-300 hover:bg-zinc-800">
          {t("radar.etf.import")}
          <input type="file" data-testid="radar-etf-file" accept=".csv,text/csv" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onFile(f); }} />
        </label>
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">{t("radar.etf.hint")}</p>
      {msg && <p role="status" data-testid="radar-etf-result" className={`mt-1 ${msg.kind === "ok" ? "text-emerald-300" : "text-amber-300"}`}>{msg.text}</p>}
      {days.length === 0 ? (
        <p data-testid="radar-etf-empty" className="mt-1 text-zinc-400">{t("radar.etf.empty")}</p>
      ) : (
        <table data-testid="radar-etf-days" className="mt-1 w-full text-[11px]">
          <caption className="sr-only">{t("radar.etf.days")}</caption>
          <tbody>
            {[...days].reverse().map((d) => (
              <tr key={d.date} data-testid="radar-etf-day">
                <td className="py-0.5 text-zinc-400">{day(d.date)}</td>
                <td className={`py-0.5 text-end font-mono ${d.total < 0 ? "text-rose-300" : "text-emerald-300"}`} dir="ltr">{usd(d.total, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AlertItem({ a, th, t, num, pct, usd, clock, staleAt }: {
  a: RadarAlert; staleAt?: number; th: RadarThresholds; t: T; num: (n: number, dp: number, signed?: boolean) => string; pct: (n: number | null | undefined, dp?: number, signed?: boolean) => string;
  usd: (n: number, signed?: boolean) => string; clock: (ms: number) => string;
}) {
  const v = a.trigger.vars;
  const n = (x: unknown) => (isNum(x) ? x : 0);
  let key = a.trigger.key;
  let vars: Record<string, string | number> = {};
  if (key === "radar.alert.breakaway") vars = { venue: String(v.venue ?? ""), pct: pct(n(v.pct), 2, true), bars: n(v.bars) };
  else if (key === "radar.alert.volume") vars = { z: num(n(v.z), 1), pct: pct(n(v.pct), 0, true) };
  else if (key === "radar.alert.depeg") {
    const level = String(v.level ?? "");
    vars = { coin: String(v.coin ?? ""), reference: String(v.reference ?? ""), dev: pct(n(v.dev), 2, true), level: ["watch", "warning", "severe"].includes(level) ? t(`depeg.${level}`) : level };
  } else if (key === "radar.alert.supply") {
    // pct and usd are signed (+ mint, − redemption): the direction is said in words.
    key = n(v.usd) < 0 ? "radar.alert.supplyDown" : "radar.alert.supplyUp";
    vars = { pct: pct(Math.abs(n(v.pct)), 2, false), usd: usd(Math.abs(n(v.usd))), pctl: n(v.pctl) };
  }
  const known = ["radar.alert.breakaway", "radar.alert.volume", "radar.alert.depeg", "radar.alert.supplyUp", "radar.alert.supplyDown"].includes(key);
  return (
    <li data-testid="radar-alert" data-code={a.code} data-stale={staleAt !== undefined ? "true" : undefined} className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
      <p dir="auto">{known ? t(key, vars) : a.code}</p>
      {a.kind === "breakaway" && <p className="text-[11px] text-zinc-400" data-testid="radar-alert-threshold">{t("radar.alerts.thBreakaway", { pct: pct(th.breakAwayPct, 1, false), bars: th.breakAwayBars })}</p>}
      {a.kind === "volume" && <p className="text-[11px] text-zinc-400" data-testid="radar-alert-threshold">{t("radar.alerts.thVolume", { z: num(th.volumeZ, 1) })}</p>}
      <p className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-zinc-400">
        {usable(a.since) && <span>{t("radar.alerts.since", { time: clock(a.since) })}</span>}
        {staleAt !== undefined && <span className="text-amber-300" data-testid="radar-alert-stale">{usable(staleAt) ? t("radar.unavailableLast", { time: clock(staleAt) }) : t("radar.unavailable")}</span>}
        <a className="text-cyan-300 underline-offset-2 hover:underline" data-testid="radar-alert-source" href={a.sourceUrl} target="_blank" rel="noopener noreferrer">{t("radar.alerts.source")}</a>
      </p>
    </li>
  );
}

function LeftOut({ snap, t }: { snap: RadarSnapshot | null; t: T }) {
  if (!snap) return null;
  const lines: string[] = [];
  for (const k of snap.unavailable) {
    if (k.startsWith("breakaway:")) lines.push(t("radar.alerts.leftOut", { venue: providerName(k.slice(10)) }));
    else if (k.startsWith("standing:")) lines.push(t("radar.alerts.leftOutStanding", { venue: providerName(k.slice(9)) }));
  }
  if (snap.unavailable.includes("breakaway")) lines.push(t("radar.alerts.breakawayOff"));
  if (snap.unavailable.includes("volume")) lines.push(t("radar.alerts.volumeOff"));
  if (snap.unavailable.includes("supply")) lines.push(t("radar.alerts.supplyOff"));
  if (!lines.length) return null;
  return <ul data-testid="radar-leftout" className="list-disc space-y-0.5 ps-4 text-[11px] text-zinc-400">{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
}

function ThresholdField({ id, label, value, t }: { id: keyof RadarThresholds; label: string; value: number; t: T }) {
  const f = THRESHOLD_FIELDS[id];
  // `draft` is what the user is typing (null = not editing: show the stored value). A valid value is stored at once; an
  // invalid one stays in the field, marked, and the stored value is kept.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const n = Number(shown);
  const invalid = shown.trim() === "" || !Number.isFinite(n) || n < f.min || n > f.max || (!!f.int && !Number.isInteger(n));
  const msgId = `radar-th-${id}-msg`;
  return (
    <div>
      <label className="flex items-center justify-between gap-2">
        <span>{label}</span>
        <input
          type="number" min={f.min} max={f.max} step={f.step} dir="ltr" data-testid={`radar-th-${id}`} value={shown}
          aria-invalid={invalid} aria-describedby={invalid ? msgId : undefined}
          className={`w-20 rounded border bg-zinc-950 px-1.5 py-0.5 text-end font-mono text-zinc-100 ${invalid ? "border-rose-500" : "border-zinc-700"}`}
          onChange={(e) => {
            const text = e.target.value;
            setDraft(text);
            const next = Number(text);
            if (text.trim() !== "" && Number.isFinite(next) && next >= f.min && next <= f.max && (!f.int || Number.isInteger(next))) {
              setRadarThresholds({ ...radarUiSnapshot().thresholds, [id]: next });
            }
          }}
          onBlur={() => setDraft(null)}
        />
      </label>
      <p id={msgId} aria-live="polite" data-testid={`radar-th-${id}-msg`} className={invalid ? "mt-0.5 text-end text-[11px] text-rose-300" : "sr-only"}>
        {invalid ? t(f.int ? "radar.th.invalidWhole" : "radar.th.invalid", { min: f.min, max: f.max }) : ""}
      </p>
    </div>
  );
}

function Thresholds({ value, t }: { value: RadarThresholds; t: T }) {
  return (
    <details data-testid="radar-thresholds" className="rounded border border-zinc-800 px-2 py-1.5">
      <summary className="cursor-pointer select-none font-semibold text-zinc-100">{t("radar.th.title")}</summary>
      <p className="mt-1 text-[11px] text-zinc-400" data-testid="radar-th-note">{t("radar.th.note")}</p>
      <div className="mt-1.5 space-y-1.5">
        <ThresholdField id="breakAwayPct" label={t("radar.th.breakAwayPct")} value={value.breakAwayPct} t={t} />
        <ThresholdField id="breakAwayBars" label={t("radar.th.breakAwayBars")} value={value.breakAwayBars} t={t} />
        <ThresholdField id="volumeZ" label={t("radar.th.volumeZ")} value={value.volumeZ} t={t} />
        <ThresholdField id="supplyPctl" label={t("radar.th.supplyPctl")} value={value.supplyPctl} t={t} />
      </div>
      <button type="button" data-testid="radar-th-reset" className="mt-2 rounded border border-zinc-700 px-2 py-1 text-[11px] text-cyan-300 hover:bg-zinc-800"
        onClick={() => setRadarThresholds(DEFAULT_THRESHOLDS)}>{t("radar.th.reset")}</button>
    </details>
  );
}
