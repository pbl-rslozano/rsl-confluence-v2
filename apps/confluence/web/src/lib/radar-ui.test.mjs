// Radar UI store — v2.8 Step 4a (WP25, Task 6). Run: npm run test:radar-ui
import { parseRadarUi, setRadarOpen, setRadarSectionCollapsed, setRadarThresholds, radarUiSnapshot, resetRadarUiForTests, RADAR_UI_KEY } from "./radar/radar-ui-store.ts";
let passed = 0, failed = 0;
const ok = (n, c, x = "") => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${x}`); } };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };

ok("default is closed, nothing collapsed, starting thresholds", JSON.stringify(parseRadarUi(null)) === JSON.stringify({ open: false, collapsed: [], thresholds: { breakAwayPct: 1, breakAwayBars: 2, volumeZ: 3, supplyPctl: 99 } }));
ok("junk falls back", parseRadarUi("x").open === false && parseRadarUi([]).open === false && parseRadarUi({ open: "yes" }).open === false);
ok("unknown sections dropped, order fixed", JSON.stringify(parseRadarUi({ collapsed: ["alerts", "nope", "positioning", "alerts"] }).collapsed) === '["positioning","alerts"]');
ok("bad thresholds fall back per field", parseRadarUi({ thresholds: { breakAwayPct: 50, volumeZ: 4 } }).thresholds.breakAwayPct === 1 && parseRadarUi({ thresholds: { breakAwayPct: 50, volumeZ: 4 } }).thresholds.volumeZ === 4);
resetRadarUiForTests();
setRadarOpen(true);
ok("open is stored", JSON.parse(mem.get(RADAR_UI_KEY)).open === true);
setRadarSectionCollapsed("buyer", true); setRadarSectionCollapsed("bogus", true);
ok("collapse stored, unknown ignored", JSON.stringify(radarUiSnapshot().collapsed) === '["buyer"]');
setRadarThresholds({ breakAwayPct: 2, breakAwayBars: 3, volumeZ: 3, supplyPctl: 99 });
resetRadarUiForTests();
ok("reload keeps open, collapsed and thresholds", radarUiSnapshot().open === true && radarUiSnapshot().collapsed[0] === "buyer" && radarUiSnapshot().thresholds.breakAwayPct === 2);
globalThis.localStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
resetRadarUiForTests();
ok("blocked storage: default, and a write does not throw", radarUiSnapshot().open === false && (setRadarOpen(true), radarUiSnapshot().open === true));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
