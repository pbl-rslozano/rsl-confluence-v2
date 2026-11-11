/**
 * macro-calendar.ts — v2.2
 * High-impact scheduled US/EU macro releases, hard-coded from primary
 * publishers (checked 31 Oct 2026). Used to warn that signals around these
 * times are less reliable. Refresh when the publishers update their schedules.
 *   FOMC  — federalreserve.gov/monetarypolicy/fomccalendars.htm (decision 14:00 ET on day 2; 2027 tentative)
 *   BLS   — Employment Situation and CPI, 08:30 ET (schedule published through Dec 2026)
 *   ECB   — monetary-policy decisions, 14:15 Frankfurt time
 */
import { newYorkOffsetHours } from "./asset-classes";

export interface MacroEvent {
  id: string;
  label: string; // English short label; the UI translates the kind
  kind: "fomc" | "cpi" | "nfp" | "ecb";
  at: number; // UTC ms
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

const FOMC_DECISION_DAYS = [
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-09", "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];
const NFP = ["2026-11-06", "2026-12-04"];
const CPI = ["2026-11-10", "2026-12-10"];
const ECB = ["2026-12-17", "2027-02-04", "2027-03-18", "2027-04-29", "2027-06-10", "2027-07-22", "2027-09-09", "2027-10-28", "2027-12-16"];

export const MACRO_EVENTS: MacroEvent[] = [
  ...FOMC_DECISION_DAYS.map((d) => ({ id: `fomc-${d}`, label: "FOMC decision", kind: "fomc" as const, at: nyTime(d, 14, 0) })),
  ...NFP.map((d) => ({ id: `nfp-${d}`, label: "US jobs report", kind: "nfp" as const, at: nyTime(d, 8, 30) })),
  ...CPI.map((d) => ({ id: `cpi-${d}`, label: "US CPI", kind: "cpi" as const, at: nyTime(d, 8, 30) })),
  ...ECB.map((d) => ({ id: `ecb-${d}`, label: "ECB decision", kind: "ecb" as const, at: frankfurtTime(d, 14, 15) })),
].sort((a, b) => a.at - b.at);

/** Events from `before` ms ago up to `ahead` ms from `now`. */
export function eventsNear(now: number, ahead = 24 * 3_600_000, before = 2 * 3_600_000): MacroEvent[] {
  return MACRO_EVENTS.filter((e) => e.at >= now - before && e.at <= now + ahead);
}
/** Last date the calendar covers (warn after it). */
export const MACRO_CALENDAR_UNTIL = MACRO_EVENTS[MACRO_EVENTS.length - 1].at;
