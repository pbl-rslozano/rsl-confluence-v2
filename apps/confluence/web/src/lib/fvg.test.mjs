// Regression for the FVG module. Run: node --experimental-strip-types src/lib/fvg.test.mjs
import { detectFVG, fvgModifier, FVG_DEFAULTS } from "./fvg.ts";

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ok  - " + n); } else { failed++; console.log("  FAIL- " + n); } };
const approx = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const c = (t, o, h, l, cl) => ({ time: t, open: o, high: h, low: l, close: cl, volume: 1 });

const bullSeq = () => [c(1,10,12,10,11), c(2,12,16,12,15.5), c(3,15,17,15,16)];
const bearSeq = () => [c(1,20,21,18,19), c(2,18,18,14,14.5), c(3,15,15,13,13.5)];

{ const d = detectFVG(bullSeq(), { lastBarClosed: true });
  ok("bull FVG detected", d.all.length === 1 && d.all[0].type === "bull");
  ok("bull FVG bounds [12,15]", approx(d.all[0].bottom,12) && approx(d.all[0].top,15)); }

{ const d = detectFVG(bearSeq(), { lastBarClosed: true });
  ok("bear FVG detected", d.all.length === 1 && d.all[0].type === "bear");
  ok("bear FVG bounds [15,18]", approx(d.all[0].bottom,15) && approx(d.all[0].top,18)); }

{ const seq=[c(1,10,14,10,13),c(2,12,15,11,14),c(3,13,16,12,15)];
  ok("no FVG on overlapping bars", detectFVG(seq,{lastBarClosed:true}).all.length===0); }

{ const base=bullSeq(); const live=detectFVG(base.concat([c(4,16,30,4,5)]));
  const closed=detectFVG(base,{lastBarClosed:true});
  ok("live bar excluded (count stable)", closed.all.length===live.all.length);
  ok("live bar excluded (gap unchanged)", approx(closed.all[0].top,live.all[0].top)&&approx(closed.all[0].bottom,live.all[0].bottom));
  ok("live bar not mitigating gap", live.all[0].mitigation===0); }

{ const seq=bullSeq().concat([c(4,16,18,15.2,17)]);
  const d=detectFVG(seq,{lastBarClosed:true});
  ok("untouched gap mitigation 0", d.all[0].mitigation===0 && d.active.length===1); }

{ const partial=detectFVG(bullSeq().concat([c(4,15,15.5,13.5,14)]),{lastBarClosed:true});
  ok("partial mitigation ~0.5", approx(partial.all[0].mitigation,0.5,1e-6));
  const full=detectFVG(bullSeq().concat([c(4,15,15.5,13.5,14)]).concat([c(5,14,14,11.5,12)]),{lastBarClosed:true});
  ok("full fill -> filled true", full.all[0].filled===true);
  ok("filled gap removed from active", full.active.every(z=>!(z.type==="bull"&&approx(z.bottom,12)&&approx(z.top,15)))); }

{ const seq=bullSeq().concat([c(4,15,16,14.9,15)]);
  const m1=fvgModifier(seq,"buy",14.95,{lastBarClosed:true});
  const m2=fvgModifier(seq,"sell",14.95,{lastBarClosed:true});
  ok("modifier bounded (buy)", m1.modifier>=FVG_DEFAULTS.minModifier && m1.modifier<=FVG_DEFAULTS.maxModifier);
  ok("modifier bounded (sell)", m2.modifier>=FVG_DEFAULTS.minModifier && m2.modifier<=FVG_DEFAULTS.maxModifier); }

{ const seq=bullSeq().concat([c(4,40,41,39,40)]);
  ok("modifier neutral far from zones", fvgModifier(seq,"buy",100,{lastBarClosed:true}).modifier===1); }

{ const seq=bullSeq();
  ok("buy inside aligned bull gap boosts (>1)", fvgModifier(seq,"buy",13.5,{lastBarClosed:true}).modifier>1);
  ok("sell inside bull gap damps (<1)", fvgModifier(seq,"sell",13.5,{lastBarClosed:true}).modifier<1); }

{ const m=fvgModifier(bullSeq(),"buy",13.5,{lastBarClosed:true});
  ok("modifier is a finite number", typeof m.modifier==="number" && isFinite(m.modifier));
  ok("no direction emitted by modifier", m.direction===undefined); }

{ const seq=bullSeq().concat([c(4,15,15.5,13.7,14)]);
  ok("detection deterministic", JSON.stringify(detectFVG(seq,{lastBarClosed:true}))===JSON.stringify(detectFVG(seq,{lastBarClosed:true}))); }

{ const seq=[c(1,100,100.00,99.9,100),c(2,100,100.2,100,100.1),c(3,100.0001,100.3,100.0001,100.2)];
  // v2.8: with the defaults this gap is now rejected by the ATR minimum (minGapPct defaults to 0).
  ok("micro-gap filtered by minGapPct", detectFVG(seq,{lastBarClosed:true}).all.length===0);
  ok("minGapPct still works as an explicit floor", detectFVG(seq,{lastBarClosed:true,minGapAtr:0,minGapPct:0.0005}).all.length===0 && detectFVG(seq,{lastBarClosed:true,minGapAtr:0}).all.length===1); }

// v2.8 (WP19): minimum gap 0.5 × ATR(14) at the middle candle. 15 flat bars
// (true range 2 each) then a middle bar with true range 2, so ATR(14) there = 2.
{ const flat = Array.from({ length: 15 }, (_, i) => c(i + 1, 100, 101, 99, 100));
  const withGap = (g) => flat.concat([c(16, 100, 102, 100, 101.5), c(17, 101 + g + 0.2, 101 + g + 1, 101 + g, 101 + g + 0.8)]);
  ok("minGapAtr defaults to 0.5", FVG_DEFAULTS.minGapAtr === 0.5);
  ok("minGapPct is only a floor (default 0)", FVG_DEFAULTS.minGapPct === 0);
  ok("gap of 0.4 × ATR(14) is rejected", detectFVG(withGap(0.8), { lastBarClosed: true }).all.length === 0);
  const acc = detectFVG(withGap(1.2), { lastBarClosed: true }).all;
  ok("gap of 0.6 × ATR(14) is accepted", acc.length === 1 && acc[0].type === "bull" && approx(acc[0].bottom, 101) && approx(acc[0].top, 102.2));
  ok("minGapAtr 0 turns the ATR minimum off", detectFVG(withGap(0.8), { lastBarClosed: true, minGapAtr: 0 }).all.length === 1);
  // mirror: bearish gap of 0.4 / 0.6 × ATR below the flat range
  const bearGap = (g) => flat.concat([c(16, 100, 100, 98, 98.5), c(17, 99 - g - 0.2, 99 - g, 99 - g - 1, 99 - g - 0.8)]);
  ok("bear gap of 0.4 × ATR rejected, 0.6 × ATR accepted",
    detectFVG(bearGap(0.8), { lastBarClosed: true }).all.length === 0 && detectFVG(bearGap(1.2), { lastBarClosed: true }).all.length === 1); }

// K-Dense v2 (18 Nov 2026) A-M6: FVG density on noise is recorded, not retuned (a new minGapAtr would move Classic's
// config id). Nine seeded 1,000-bar 4h random walks — Gaussian, Student-t(3) and GARCH(1,1), each at 0.5 %, 1 % and
// 2 % per bar, random wicks, one seed per cell — with the default options give 1 gap per 11.6 bars pooled (measured
// 18 Nov 2026; a single 1,000-bar series varies, 1 per 9.5-13.7; the audit's grid gave 1 per 11-14); this pins the
// pooled gaps per bar ≤ 1/10.
{ const lcg = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 16807) % 2147483647; return s / 2147483647; }; };
  const walk = (kind, vol, seed) => {
    const r = lcg(seed);
    const gauss = () => { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const t3 = () => { let q = 0; for (let i = 0; i < 3; i++) { const g = gauss(); q += g * g; } return gauss() / Math.sqrt(q / 3) / Math.sqrt(3); };
    const out = []; let px = 100, h = vol * vol, eps = 0;
    const omega = vol * vol * 0.05, a = 0.10, b = 0.85;
    for (let i = 0; i < 1000; i++) {
      let sig = vol;
      if (kind === "garch") { h = omega + a * eps * eps + b * h; sig = Math.sqrt(h); }
      eps = (kind === "t3" ? t3() : gauss()) * sig;
      const o = px; px = px * Math.exp(eps);
      out.push(c(Date.UTC(2025, 0, 1) + i * 4 * 3600e3, o, Math.max(o, px) * (1 + Math.abs(gauss()) * sig * 0.4), Math.min(o, px) * (1 - Math.abs(gauss()) * sig * 0.4), px));
    }
    return out;
  };
  let gaps = 0, bars = 0, idx = 0; const per = [];
  for (const kind of ["gauss", "t3", "garch"]) for (const vol of [0.005, 0.01, 0.02]) {
    const k = walk(kind, vol, 4242 + 1009 * idx++); // one seed per cell ("gauss" and "garch" have the same length)
    const g = detectFVG(k, { lastBarClosed: true }).all.length;
    per.push(`${kind} ${vol}: 1 per ${(k.length / g).toFixed(1)}`); gaps += g; bars += k.length;
  }
  console.log("  (FVG on noise: " + per.join(" · ") + ")");
  ok("A-M6: default FVG options on 9 seeded 4h random walks give ≤ 1 gap per 10 bars pooled (got 1 per " + (bars / gaps).toFixed(1) + ")", gaps > 0 && gaps / bars <= 1 / 10); }

console.log("\nFVG regression: " + passed + "/" + (passed+failed) + " passed");
process.exit(failed===0?0:1);
