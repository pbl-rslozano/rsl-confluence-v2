"use client";
/**
 * fear-greed.tsx — v2.8 WP29 (Task 2): the collapsed Crypto Fear & Greed widget.
 *
 * Context only: nothing here reaches scoring, the ledger, alerts or any paper-trading rule.
 * The chip (FearGreedToggle) sits at the end of the counts line; the panel (FearGreedPanel) is mounted only while open.
 * Fetch gate: `api.alternative.me` is contacted only by the open panel — the cache shows at once, a fetch follows when
 * there is no cache or it is older than an hour, the panel re-checks every 15 minutes while open, and closing aborts.
 * A collapsed widget makes no request (not even on hover). Alternative.me's terms: the source is named right next to the gauge.
 * Every provider value is rendered as text (no innerHTML). The gauge is not mirrored in right-to-left languages
 * (0 is on the left everywhere, as on Alternative.me); the 31-day history reads oldest -> newest in reading order, so it is.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { getLanguage } from "@rsl/core-kit/core/rsl-i18n.js";
import { useRsl } from "@/rsl/RslContext";
import { FNG_COLORS, fetchFng, fngBand, isFngFresh, loadFngCache, saveFngCache, type FngBand, type FngData, type FngPort } from "@/lib/fear-greed";

export const FNG_OPEN_KEY = "fng.open";
export const FNG_PAGE_URL = "https://alternative.me/crypto/fear-and-greed-index/";
const RECHECK_MS = 15 * 60_000;
const BANDS: FngBand[] = ["extremeFear", "fear", "neutral", "greed", "extremeGreed"];

let openCache: boolean | null = null;
const openListeners = new Set<() => void>();
const readOpen = (): boolean => { try { return localStorage.getItem(FNG_OPEN_KEY) === "1"; } catch { return false; } };
const openSnapshot = (): boolean => (openCache ??= readOpen());
const subscribeOpen = (l: () => void) => { openListeners.add(l); return () => { openListeners.delete(l); }; };

/**
 * Open state, remembered per device (try/catch: the widget works for the session when storage is blocked). The server snapshot is
 * "closed", so the static page hydrates the same everywhere and then reads the stored choice.
 */
export function useFngOpen(): [boolean, (open: boolean) => void] {
  const open = useSyncExternalStore(subscribeOpen, openSnapshot, () => false);
  const set = useCallback((next: boolean) => {
    openCache = next;
    try { localStorage.setItem(FNG_OPEN_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    for (const l of [...openListeners]) l();
  }, []);
  return [open, set];
}

export function FearGreedToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useRsl();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <button
      type="button"
      data-testid="fng-toggle"
      aria-expanded={open}
      aria-controls="fng-panel"
      onClick={onToggle}
      className="ms-auto inline-flex h-4 items-center gap-1 whitespace-nowrap rounded px-1 text-[11px] uppercase tracking-wider text-zinc-400 hover:text-zinc-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-400"
    >
      <span>{t("fng.toggle")}</span>
      <Chevron className="h-3 w-3 rtl:-scale-x-100" aria-hidden="true" />
    </button>
  );
}

const css = (c: string) => ({ ["--fng-c" as string]: c }) as React.CSSProperties;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Port of the kit's gaugeSvg geometry (arc radius 119, needle 90, pivot 160,155), 0 on the left. The viewBox is 30 px taller than the kit's
 * (320 x 240) so the value, band and date sit below the pivot: in the kit the needle runs through the value for mid-range readings.
 */
function Gauge({ value, band, label, updated, ariaLabel }: { value: number; band: FngBand; label: string; updated: string; ariaLabel: string }) {
  const polar = (angle: number, r: number): [number, number] => [160 + r * Math.cos(angle), 155 - r * Math.sin(angle)];
  const stops = [0, 25, 45, 56, 76, 100];
  const needle = polar(Math.PI * (1 - value / 100), 90);
  const txt = (extra: object) => ({ fontFamily: "Arial, sans-serif", textAnchor: "middle" as const, ...extra });
  return (
    <svg data-testid="fng-gauge" role="img" aria-label={ariaLabel} viewBox="0 0 320 240" className="h-auto w-full max-w-[320px]">
      <path d="M 41 155 A 119 119 0 0 1 279 155" fill="none" strokeWidth={16} style={{ stroke: "var(--color-zinc-700)" }} />
      {BANDS.map((b, i) => {
        const p = polar(Math.PI * (1 - stops[i] / 100), 119);
        const q = polar(Math.PI * (1 - stops[i + 1] / 100), 119);
        return <path key={b} className="fng-stroke" style={css(FNG_COLORS[b])} d={`M ${p[0].toFixed(2)} ${p[1].toFixed(2)} A 119 119 0 0 1 ${q[0].toFixed(2)} ${q[1].toFixed(2)}`} fill="none" strokeWidth={15} strokeLinecap="butt" />;
      })}
      <line x1={160} y1={155} x2={needle[0]} y2={needle[1]} strokeWidth={3.5} strokeLinecap="round" style={{ stroke: "var(--color-zinc-100)" }} />
      <circle cx={160} cy={155} r={6.4} style={{ fill: "var(--color-zinc-100)" }} />
      <text x={160} y={198} fontSize={40} fontWeight={700} style={txt({ fill: "var(--color-zinc-50)" })}>{value}</text>
      <text x={160} y={216} fontSize={14} fontWeight={700} className="fng-fill" style={{ ...css(FNG_COLORS[band]), ...txt({}) }}>{label}</text>
      <text x={38} y={177} fontSize={10} style={txt({ fill: "var(--color-zinc-400)" })}>0</text>
      <text x={280} y={177} fontSize={10} style={txt({ fill: "var(--color-zinc-400)" })}>100</text>
      <text x={160} y={234} fontSize={11} style={txt({ fill: "var(--color-zinc-400)" })}>{updated}</text>
    </svg>
  );
}

/** The last (up to 31) daily values as bars, one per UTC day. In RTL the oldest bar is on the right, so it reads in order. */
function History({ data, rtl, caption, fmt }: { data: FngData; rtl: boolean; caption: string; fmt: (ms: number) => string }) {
  const pts = data.points;
  const W = 310, H = 90, step = W / pts.length, bw = Math.max(2, step - 2);
  return (
    <div>
      <svg data-testid="fng-history" role="img" aria-label={caption} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-24 w-full">
        <line x1={0} y1={H - 0.5} x2={W} y2={H - 0.5} strokeWidth={1} style={{ stroke: "var(--color-zinc-700)" }} />
        {pts.map((p, i) => {
          const h = Math.max(1.5, (p.value / 100) * (H - 2));
          const x = (rtl ? pts.length - 1 - i : i) * step + (step - bw) / 2;
          return (
            <rect key={p.t} data-day={isoDay(p.t)} x={x} y={H - 1 - h} width={bw} height={h} rx={1} className="fng-fill" style={css(FNG_COLORS[p.band])} opacity={i === pts.length - 1 ? 1 : 0.75}>
              <title>{`${fmt(p.t)}: ${p.value}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-0.5 flex justify-between text-[10px] text-zinc-500">
        <span>{fmt(pts[0].t)}</span>
        <span>{fmt(pts[pts.length - 1].t)}</span>
      </div>
      <p className="mt-1 text-[11px] text-zinc-400">{caption}</p>
    </div>
  );
}

/** Mounted only while the widget is open: mounting is "open", unmounting is "closed" (the effect cleanup aborts the request). */
export function FearGreedPanel({ port }: { port: FngPort }) {
  const rsl = useRsl();
  const { t } = rsl;
  const rtl = getLanguage(rsl.lang)?.dir === "rtl";
  const [data, setData] = useState<FngData | null>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef<FngData | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const ac = new AbortController(); // one per effect run: a strict-mode remount aborts the first run before it can fetch
    const check = async (initial: boolean) => {
      if (initial) {
        const cached = await loadFngCache(port, Date.now());
        if (ac.signal.aborted) return;
        if (cached) { latest.current = cached; setData(cached); }
      }
      const cur = latest.current;
      if (cur && isFngFresh(cur, Date.now())) return;
      try {
        const fresh = await fetchFng(ac.signal);
        if (ac.signal.aborted) return;
        try { await saveFngCache(port, fresh); } catch { /* the value still shows; the next open fetches again */ }
        if (ac.signal.aborted) return;
        latest.current = fresh;
        setData(fresh);
        setFailed(false);
      } catch {
        if (!ac.signal.aborted) setFailed(true);
      }
    };
    void check(true);
    const id = setInterval(() => { tick((n) => n + 1); void check(false); }, RECHECK_MS);
    return () => { ac.abort(); clearInterval(id); };
  }, [port]);

  const fmt = (ms: number) => rsl.i18n.formatDate(ms, { dateStyle: "medium", timeZone: "UTC" }); // an observation day at 00:00 UTC: never the previous day
  const newest = data ? data.points[data.points.length - 1] : null;
  const band = newest ? fngBand(newest.value) : null; // the UI label follows the value, never provider text
  const date = newest ? fmt(newest.t) : "";
  const bandLabel = band ? t(`fng.band.${band}`) : "";
  const stale = !!data && failed && !isFngFresh(data, Date.now());

  return (
    <section
      id="fng-panel"
      data-testid="fng-panel"
      role="region"
      aria-labelledby="fng-title"
      className="max-h-[55vh] overflow-y-auto border-t border-zinc-800/60 py-2 text-xs text-zinc-300"
    >
      <h2 id="fng-title" className="mb-1.5 text-sm font-semibold text-zinc-100">{t("fng.title")}</h2>
      {!data && !failed && <p role="status" className="text-zinc-400">{t("fng.loading")}</p>}
      {!data && failed && <p role="status" className="text-zinc-400">{t("fng.unavailable")}</p>}
      {data && newest && band && (
        <div className="grid items-start gap-x-6 gap-y-3 sm:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <div className="min-w-0">
            <Gauge value={newest.value} band={band} label={bandLabel} updated={t("fng.updated", { date })} ariaLabel={t("fng.gaugeLabel", { value: newest.value, label: bandLabel, date })} />
            <a
              data-testid="fng-attribution"
              href={FNG_PAGE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block text-[11px] text-cyan-300 underline-offset-2 hover:underline"
            >{t("fng.attribution")}</a>
          </div>
          <div className="min-w-0">
            <History data={data} rtl={rtl} caption={t("fng.history", { n: data.points.length })} fmt={fmt} />
            {stale && <p role="status" className="mt-1 text-amber-300">{t("fng.stale", { date })}</p>}
            <p className="mt-1 text-zinc-400">{t("fng.note")}</p>
          </div>
        </div>
      )}
    </section>
  );
}
