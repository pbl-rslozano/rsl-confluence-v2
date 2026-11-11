// Null-distribution probe: |score| of runConfluence on driftless random walks.
// Run: node scripts/run-engine-tests.mjs null-calibration.mjs
import { runConfluence } from "./indicators.ts";
const H = 3600e3;
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const tdist = (nu) => { let s = 0; for (let i = 0; i < nu; i++) { const g = gauss(); s += g * g; } return gauss() / Math.sqrt(s / nu); };
function walk(n, vol, kind) {
  const out = []; let px = 100; let t = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const r = (kind === "t3" ? tdist(3) / Math.sqrt(3) : gauss()) * vol;
    const o = px; px = px * Math.exp(r);
    const hi = Math.max(o, px) * (1 + Math.abs(gauss()) * vol * 0.4);
    const lo = Math.min(o, px) * (1 - Math.abs(gauss()) * vol * 0.4);
    out.push({ time: t, open: o, high: hi, low: lo, close: px, volume: 1000 * Math.exp(gauss() * 0.5) });
    t += H;
  }
  return out;
}
const window = Number(process.env.CT_WINDOW ?? 200);
const scores = [];
for (const kind of ["gauss", "t3"]) for (const vol of [0.003, 0.01, 0.03]) for (let rep = 0; rep < 6; rep++) {
  const k = walk(window + 800, vol, kind);
  for (let end = window; end <= k.length; end += 10) {
    const c = runConfluence(k.slice(end - window, end), { intervalMs: H });
    if (!c.suppressed) scores.push(Math.abs(c.score));
  }
}
scores.sort((a, b) => a - b);
const q = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))];
const share = (t) => (scores.filter((s) => s >= t).length / scores.length).toFixed(3);
console.log(JSON.stringify({ window, n: scores.length, p50: q(0.5), p80: q(0.8), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: scores.at(-1),
  ge25: share(25), ge50: share(50), ge40: share(40), ge45: share(45), ge55: share(55), ge60: share(60), ge65: share(65), ge70: share(70) }));
