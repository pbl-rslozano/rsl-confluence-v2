/**
 * macro-calendar.ts — v2.8
 * High-impact scheduled US/EU macro releases, hard-coded from primary publishers.
 * Used to warn that volatility is often higher around these times (how much it affects the signals is not yet measured) and (FOMC/CPI/NFP only)
 * to block new paper trades 2 h before to 1 h after the release (event blackout).
 *
 * Sources, all accessed 15 Nov 2026:
 *   FOMC  — https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *           Decision 14:00 ET on the meeting's last day. 2027 dates are tentative on the page until confirmed
 *           at the preceding meeting. The page now lists 2027 meetings on 26-27 Jan, 16-17 Mar, 27-28 Apr,
 *           8-9 Jun, 27-28 Jul, 14-15 Sep, 26-27 Oct (marked "Monetary Policy Strategy Meeting") and
 *           16-17 Nov, with no December 2027 meeting. The earlier file listed 8 Dec 2027 (from the Fed's
 *           Sep 2025 release, which listed 7-8 Dec); that date is no longer on the page and was removed.
 *           2026: 28 Oct and 8-9 Dec confirmed on the same page.
 *   CPI   — https://www.bls.gov/schedule/news_release/cpi.htm — 08:30 ET; 10 Nov and 10 Dec 2026 and all
 *           twelve 2027 releases (13 Jan to 10 Dec 2027) confirmed.
 *   NFP   — https://www.bls.gov/schedule/news_release/empsit.htm — Employment Situation, 08:30 ET; 4 Dec 2026
 *           and 8 Jan to 3 Dec 2027 confirmed. The December 2027 report (early Jan 2028) is not published yet.
 *           The 6 Nov 2026 release is already past and is no longer on the page.
 *   ECB   — https://www.ecb.europa.eu/press/pr/date/2026/html/ecb.pr260630~9f54a0a4fb.en.html (ECB press
 *           release of 30 Jun 2026, indicative 2027 operational calendars, which names the 2027 Governing
 *           Council monetary-policy meetings), 14:15 Frankfurt time. 17 Dec 2026 was not on that page.
 * A date that could not be confirmed from an official page this way has `verified: false`: it is shown but never
 * blocks and is not counted by coverageUntil. Never add a date that was not read from the publisher.
 * Refresh when the publishers update their schedules (the banner warns when any kind has < 30 days left).
 */
import { newYorkOffsetHours } from "./asset-classes";

export interface MacroEvent {
  id: string;
  label: string; // English short label; the UI translates the kind
  kind: "fomc" | "cpi" | "nfp" | "ecb";
  at: number; // UTC ms
  /** Read from the publisher's page (see the sources above). Unverified dates never block and do not count as coverage. */
  verified: boolean;
}

/** UTC ms for a New-York local time on a date (DST-aware). */
function nyTime(date: string, hh: number, mm: number): number {
  const naive = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  // Offset at noon UTC of that day is the offset for the whole local day (switches happen at 02:00 local).
  return naive - newYorkOffsetHours(Date.parse(`${date}T12:00:00Z`)) * 3_600_000;
}
/** Frankfurt is UTC+1 in winter, UTC+2 in summer (last Sunday of March → last Sunday of October). */
function frankfurtTime(date: string, hh: number, mm: number): number {
  const d = new Date(`${date}T12:00:00Z`);
  const y = d.getUTCFullYear();
  const lastSunday = (month: number) => { const end = new Date(Date.UTC(y, month + 1, 0)); return Date.UTC(y, month, end.getUTCDate() - end.getUTCDay()); };
  const summer = d.getTime() >= lastSunday(2) && d.getTime() < lastSunday(9);
  return Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`) - (summer ? 2 : 1) * 3_600_000;
}

/** [date, verified] */
type Day = readonly [string, boolean];
const FOMC_DECISION_DAYS: Day[] = [
  ["2026-01-28", true], ["2026-03-18", true], ["2026-04-29", true], ["2026-06-17", true], ["2026-07-29", true], ["2026-09-16", true],
  ["2026-10-28", true], ["2026-12-09", true],
  ["2027-01-27", true], ["2027-03-17", true], ["2027-04-28", true], ["2027-06-09", true], ["2027-07-28", true], ["2027-09-15", true],
  ["2027-10-27", true], ["2027-11-17", true],
];
const NFP: Day[] = [
  ["2026-11-06", false], ["2026-12-04", true],
  ["2027-01-08", true], ["2027-02-05", true], ["2027-03-05", true], ["2027-04-02", true], ["2027-05-07", true], ["2027-06-04", true],
  ["2027-07-02", true], ["2027-08-06", true], ["2027-09-03", true], ["2027-10-08", true], ["2027-11-05", true], ["2027-12-03", true],
];
const CPI: Day[] = [
  ["2026-11-10", true], ["2026-12-10", true],
  ["2027-01-13", true], ["2027-02-11", true], ["2027-03-10", true], ["2027-04-13", true], ["2027-05-12", true], ["2027-06-10", true],
  ["2027-07-14", true], ["2027-08-11", true], ["2027-09-14", true], ["2027-10-14", true], ["2027-11-10", true], ["2027-12-10", true],
];
const ECB: Day[] = [
  ["2026-12-17", false],
  ["2027-02-04", true], ["2027-03-18", true], ["2027-04-29", true], ["2027-06-10", true], ["2027-07-22", true], ["2027-09-09", true],
  ["2027-10-28", true], ["2027-12-16", true],
];

export const MACRO_EVENTS: MacroEvent[] = [
  ...FOMC_DECISION_DAYS.map(([d, verified]) => ({ id: `fomc-${d}`, label: "FOMC decision", kind: "fomc" as const, at: nyTime(d, 14, 0), verified })),
  ...NFP.map(([d, verified]) => ({ id: `nfp-${d}`, label: "US jobs report", kind: "nfp" as const, at: nyTime(d, 8, 30), verified })),
  ...CPI.map(([d, verified]) => ({ id: `cpi-${d}`, label: "US CPI", kind: "cpi" as const, at: nyTime(d, 8, 30), verified })),
  ...ECB.map(([d, verified]) => ({ id: `ecb-${d}`, label: "ECB decision", kind: "ecb" as const, at: frankfurtTime(d, 14, 15), verified })),
].sort((a, b) => a.at - b.at);

/** Events from `before` ms ago up to `ahead` ms from `now`. */
export function eventsNear(now: number, ahead = 24 * 3_600_000, before = 2 * 3_600_000): MacroEvent[] {
  return MACRO_EVENTS.filter((e) => e.at >= now - before && e.at <= now + ahead);
}
/** Last verified event of this kind (UTC ms); 0 when none is verified. Unverified dates do not count. */
export function coverageUntil(kind: MacroEvent["kind"]): number {
  let last = 0;
  for (const e of MACRO_EVENTS) if (e.kind === kind && e.verified && e.at > last) last = e.at;
  return last;
}

/** Event kinds with less than `minDays` of verified dates left after `now` (banner warning). */
export function coverageWarnings(now: number, minDays = 30): MacroEvent["kind"][] {
  const kinds: MacroEvent["kind"][] = ["fomc", "cpi", "nfp", "ecb"];
  return kinds.filter((k) => coverageUntil(k) - now < minDays * 86_400_000);
}

export const BLACKOUT_BEFORE_MS = 2 * 3_600_000;
export const BLACKOUT_AFTER_MS = 3_600_000;
/** The FOMC/CPI/NFP release whose blackout window (2 h before to 1 h after) contains `now`, else null. ECB is informational only. */
export function inBlackout(now: number): MacroEvent | null {
  for (const e of MACRO_EVENTS) {
    if (!e.verified || e.kind === "ecb") continue;
    if (now >= e.at - BLACKOUT_BEFORE_MS && now <= e.at + BLACKOUT_AFTER_MS) return e;
  }
  return null;
}
