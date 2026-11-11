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
  ok("micro-gap filtered by minGapPct", detectFVG(seq,{lastBarClosed:true}).all.length===0); }

console.log("\nFVG regression: " + passed + "/" + (passed+failed) + " passed");
process.exit(failed===0?0:1);
