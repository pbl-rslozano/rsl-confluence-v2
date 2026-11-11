/**
 * rsl-signature-art.js — rsL Core Kit · v1.0 2026
 * "Convergent Lattice": the seeded generative signature drawn on every rsL app's splash,
 * About dialog and empty states. Dependency-free Canvas 2D (no p5), deterministic per seed:
 * the same app code always grows the same lattice, on every platform.
 *
 * One core, many ports: walkers leave a central core, route across a square lattice
 * (orthogonal moves, rare cyan 45° bridges), never share a cell, and end as pads (arrived)
 * or vias (stalled). Colour = distance travelled (blue → violet); weight falls per generation.
 *
 * Usage:
 *   import { drawSignature, seedFromAppCode } from './rsl-signature-art.js';
 *   const ctl = drawSignature(canvas, { appCode: 'PKOS' });   // animates unless reduced motion
 *   await ctl.done;  ctl.stop();
 */
import { fnv1a32 } from './rsl-crypto.js';

export const SIGNATURE_DEFAULTS = Object.freeze({
  cells: 100,            // lattice cells across the shorter side
  walkers: 56, ports: 4, branchRate: 0.06, diagonalRate: 0.12, pull: 0.9, noiseScale: 0.06,
  lineWeight: 0.29,      // fraction of a cell
  stepsPerFrame: 6, coverage: 0.5,
  palette: ['#090F1A', '#0755F5', '#7524F4', '#00D9F5'],   // ground, near, far, bridge
});

/** Same mapping as the p5 viewer: FNV-1a of the upper-cased code, 1…999999. */
export const seedFromAppCode = (code) => (fnv1a32(String(code).trim().toUpperCase()) % 999999) + 1;

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function makeNoise(rand) {
  const p = new Uint8Array(512); const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const v = new Float32Array(256).map(() => rand());
  const fade = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const h = (x, y, z) => v[p[p[p[x & 255] + (y & 255)] + (z & 255)]];
  return (x, y, z) => {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
    const a = lerp(lerp(h(xi, yi, zi), h(xi + 1, yi, zi), xf), lerp(h(xi, yi + 1, zi), h(xi + 1, yi + 1, zi), xf), yf);
    const b = lerp(lerp(h(xi, yi, zi + 1), h(xi + 1, yi, zi + 1), xf), lerp(h(xi, yi + 1, zi + 1), h(xi + 1, yi + 1, zi + 1), xf), yf);
    return lerp(a, b, zf);
  };
}
const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

const DIRS = [[1, 0], [1, -1], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas  sized by the caller (CSS px × devicePixelRatio ≤ 2)
 * @param {object} opts  appCode | seed, animate (default: !prefers-reduced-motion), plus SIGNATURE_DEFAULTS overrides
 * @returns {{ seed:number, stop():void, done:Promise<{walkers:number, arrivals:number[]}> }}
 */
export function drawSignature(canvas, opts = {}) {
  const o = { ...SIGNATURE_DEFAULTS, ...opts };
  const seed = o.seed ?? seedFromAppCode(o.appCode || 'RSL');
  const reduce = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animate = o.animate ?? !reduce;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const rand = mulberry32(seed);
  const noise = makeNoise(rand);
  const R = (a = 1, b) => (b === undefined ? rand() * a : a + rand() * (b - a));

  const cell = Math.min(W, H) / o.cells;
  const cols = Math.floor(W / cell), rows = Math.floor(H / cell);
  const occ = new Uint8Array(cols * rows);
  const idx = (c, r) => r * cols + c;
  const inB = (c, r) => c >= 1 && r >= 1 && c < cols - 1 && r < rows - 1;
  const cx = (c) => c * cell + cell / 2;
  const [bg, nearHex, farHex, bridge] = o.palette;
  const near = hexRgb(nearHex), far = hexRgb(farHex);
  const lw = cell * o.lineWeight;
  let budget = cols * rows * o.coverage;

  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = `rgba(${far.join(',')},0.055)`;
  for (let r = 2; r < rows - 1; r += 2) for (let c = 2; c < cols - 1; c += 2) ctx.fillRect(cx(c) - cell * 0.06, cx(r) - cell * 0.06, cell * 0.12, cell * 0.12);

  // core
  const cw = Math.max(4, Math.floor(cols * R(0.13, 0.18))), ch = Math.max(3, Math.floor(rows * R(0.08, 0.12)));
  const c0 = Math.floor(cols / 2 + R(-cols * 0.06, cols * 0.06) - cw / 2), r0 = Math.floor(rows / 2 + R(-rows * 0.06, rows * 0.06) - ch / 2);
  const core = { c0, r0, c1: c0 + cw, r1: r0 + ch };
  for (let r = r0 - 1; r <= core.r1 + 1; r++) for (let c = c0 - 1; c <= core.c1 + 1; c++) if (inB(c, r)) occ[idx(c, r)] = 2;

  const ports = [];
  const rot = R(Math.PI * 2);
  for (let i = 0; i < o.ports; i++) {
    const a = rot + (i * Math.PI * 2) / o.ports + R(-0.25, 0.25);
    const dx = Math.cos(a), dy = Math.sin(a);
    const t = Math.min(dx ? (cols / 2 - 3) / Math.abs(dx) : Infinity, dy ? (rows / 2 - 3) / Math.abs(dy) : Infinity);
    ports.push({ c: Math.round(cols / 2 + dx * t), r: Math.round(rows / 2 + dy * t), hits: 0 });
  }

  const walkers = [];
  const spawn = (c, r, dir, gen, port) => { occ[idx(c, r)] = 1; walkers.push({ c, r, dir, gen, port, len: 0, alive: true, straight: 0 }); };
  const perim = [];
  for (let c = c0; c <= core.c1; c++) { perim.push([c, r0 - 2, 2], [c, core.r1 + 2, 6]); }
  for (let r = r0; r <= core.r1; r++) { perim.push([c0 - 2, r, 4], [core.c1 + 2, r, 0]); }
  for (let i = perim.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [perim[i], perim[j]] = [perim[j], perim[i]]; }
  const nearestPort = (c, r) => {
    if (rand() < 0.22) return Math.floor(rand() * ports.length);
    let best = 0, bd = Infinity;
    ports.forEach((p, i) => { const d = (p.c - c) ** 2 + (p.r - r) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  for (let i = 0; i < Math.min(o.walkers, perim.length); i++) {
    const [c, r, d] = perim[i];
    if (inB(c, r) && !occ[idx(c, r)]) spawn(c, r, d, 0, nearestPort(c, r));
  }

  // draw core
  const x = c0 * cell, y = r0 * cell, w = (cw + 1) * cell, h = (ch + 1) * cell;
  ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, cell * 0.6) : ctx.rect(x, y, w, h);
  ctx.fillStyle = `rgba(${near.join(',')},0.10)`; ctx.fill();
  ctx.strokeStyle = mix(near, far, 0.5); ctx.lineWidth = lw * 0.7; ctx.stroke();
  const s = Math.min(w, h) * 0.32;
  ctx.strokeStyle = bridge; ctx.lineWidth = lw * 1.2; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(x + w / 2 - s / 2, y + h / 2 - s / 2); ctx.lineTo(x + w / 2 + s / 2, y + h / 2 + s / 2); ctx.stroke();

  const segColor = (wk, diag) => {
    if (diag) return bridge;
    let t = Math.min(1, wk.len / (Math.min(cols, rows) * 0.55)); t = t * t * (3 - 2 * t);
    return mix(near, far, t);
  };
  const weight = (gen, f = 1) => Math.max(cell * 0.06, lw * Math.pow(0.72, gen) * f);
  const seg = (x1, y1, x2, y2, col, wt) => { ctx.strokeStyle = col; ctx.lineWidth = wt; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

  function arrive(wk, p) {
    wk.alive = false; p.hits++;
    const sz = Math.max(cell * 0.3, weight(wk.gen) * 2.2);
    ctx.fillStyle = segColor(wk, false); ctx.fillRect(cx(wk.c) - sz / 2, cx(wk.r) - sz / 2, sz, sz);
  }
  function stall(wk) {
    wk.alive = false;
    ctx.strokeStyle = segColor(wk, false); ctx.lineWidth = weight(wk.gen, 0.6);
    ctx.beginPath(); ctx.arc(cx(wk.c), cx(wk.r), Math.max(cell * 0.3, weight(wk.gen) * 1.7) / 2, 0, Math.PI * 2); ctx.stroke();
  }
  function step(wk) {
    const p = ports[wk.port];
    const tx = p.c - wk.c, ty = p.r - wk.r, dist = Math.hypot(tx, ty);
    if (dist < 1.6) return arrive(wk, p);
    const nx = tx / dist, ny = ty / dist;
    const field = noise(wk.c * o.noiseScale, wk.r * o.noiseScale, wk.gen * 3.1);
    const cand = [wk.dir, (wk.dir + 2) % 8, (wk.dir + 6) % 8, (wk.dir + 1) % 8, (wk.dir + 7) % 8];
    let best = -1, bestScore = -Infinity;
    for (let k = 0; k < cand.length; k++) {
      const d = cand[k], diag = d % 2 === 1;
      if (diag && rand() > o.diagonalRate) continue;
      const [dx, dy] = DIRS[d]; const c2 = wk.c + dx, r2 = wk.r + dy;
      if (!inB(c2, r2) || occ[idx(c2, r2)]) continue;
      if (diag && occ[idx(wk.c + dx, wk.r)] && occ[idx(wk.c, wk.r + dy)]) continue;
      let sc = (o.pull * (dx * nx + dy * ny)) / (diag ? Math.SQRT2 : 1);
      sc += k === 0 ? 0.55 - wk.straight * 0.004 : 0;
      sc += (field - 0.5) * (k === 1 ? 1.6 : k === 2 ? -1.6 : 0);
      sc += R(-0.18, 0.18);
      if (sc > bestScore) { bestScore = sc; best = d; }
    }
    if (best < 0) return stall(wk);
    const [dx, dy] = DIRS[best]; const diag = best % 2 === 1;
    const x1 = cx(wk.c), y1 = cx(wk.r); const turned = best !== wk.dir;
    wk.c += dx; wk.r += dy; wk.len++; wk.straight = turned ? 0 : wk.straight + 1;
    occ[idx(wk.c, wk.r)] = 1;
    seg(x1, y1, cx(wk.c), cx(wk.r), segColor(wk, diag), weight(wk.gen, diag ? 0.85 : 1));
    wk.dir = diag ? (rand() < 0.5 ? (best + 1) % 8 : (best + 7) % 8) : best;
    budget--;
    const chance = o.branchRate * Math.pow(0.55, wk.gen) * (turned || wk.straight > 14 ? 1 : 0.15);
    if (wk.gen < 5 && rand() < chance) {
      const bd = (wk.dir + (rand() < 0.5 ? 2 : 6)) % 8; const [bx, by] = DIRS[bd];
      const bc = wk.c + bx, br = wk.r + by;
      if (inB(bc, br) && !occ[idx(bc, br)]) {
        spawn(bc, br, bd, wk.gen + 1, rand() < 0.6 ? wk.port : Math.floor(rand() * ports.length));
        seg(cx(wk.c), cx(wk.r), cx(bc), cx(br), segColor(walkers[walkers.length - 1], false), weight(wk.gen + 1));
      }
    }
  }
  function drawPorts() {
    ctx.strokeStyle = bridge; ctx.lineWidth = Math.max(1, lw * 0.5);
    for (const p of ports) { ctx.beginPath(); ctx.arc(cx(p.c), cx(p.r), (cell * (1.6 + Math.min(p.hits, 12) * 0.12)) / 2, 0, Math.PI * 2); ctx.stroke(); }
  }
  function tick(n) {
    for (let s2 = 0; s2 < n; s2++) {
      let any = false;
      for (let i = 0; i < walkers.length; i++) {
        const wk = walkers[i]; if (!wk.alive) continue; any = true;
        if (budget <= 0) stall(wk); else step(wk);
      }
      if (!any) { drawPorts(); return true; }
    }
    return false;
  }

  let stopped = false, raf = 0, resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = () => resolveDone({ walkers: walkers.length, arrivals: ports.map((p) => p.hits) });
  if (!animate || !globalThis.requestAnimationFrame) { while (!tick(10_000)); finish(); }
  else {
    const frame = () => {
      if (stopped) return;
      if (globalThis.document?.hidden) { raf = requestAnimationFrame(frame); return; }  // pause while hidden
      if (tick(o.stepsPerFrame)) finish(); else raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }
  return { seed, done, stop() { stopped = true; if (raf) cancelAnimationFrame(raf); } };
}
