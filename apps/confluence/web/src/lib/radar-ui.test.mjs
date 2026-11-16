// Radar UI store — v2.8 Step 4a (WP25, Task 6). Run: npm run test:radar-ui
import { THRESHOLD_FIELDS, parseRadarUi, setRadarOpen, setRadarSectionCollapsed, setRadarThresholds, radarUiSnapshot, resetRadarUiForTests, subscribeRadarUi, RADAR_UI_KEY } from "./radar/radar-ui-store.ts";
import { isEditableTarget, shouldToggleRadar } from "./radar/radar-keys.ts";
import { sanitizeThresholds, DEFAULT_THRESHOLDS } from "./radar/alerts.ts";
let passed = 0, failed = 0;
const ok = (n, c, x = "") => { if (c) { passed++; console.log(`  ok   ${n}`); } else { failed++; console.log(`  FAIL ${n} ${x}`); } };
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };

ok("default is closed, nothing collapsed, starting thresholds", JSON.stringify(parseRadarUi(null)) === JSON.stringify({ open: false, collapsed: [], thresholds: { breakAwayPct: 1, breakAwayBars: 2, volumeZ: 3, supplyPctl: 99, liqMult: 3, whaleMinUsd: 10_000_000 } }));
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

/* the UI bounds are the sanitiser's bounds */
for (const [k, f] of Object.entries(THRESHOLD_FIELDS)) {
  ok(`${k}: min and max are accepted`, sanitizeThresholds({ [k]: f.min })[k] === f.min && sanitizeThresholds({ [k]: f.max })[k] === f.max);
  ok(`${k}: just outside falls back to the default`, sanitizeThresholds({ [k]: f.min - 0.05 })[k] === DEFAULT_THRESHOLDS[k] && sanitizeThresholds({ [k]: f.max + 0.05 })[k] === DEFAULT_THRESHOLDS[k]);
}
ok("bars is whole only", sanitizeThresholds({ breakAwayBars: 2.5 }).breakAwayBars === 2 && THRESHOLD_FIELDS.breakAwayBars.int === true);

/* the storage event of another tab */
{
  mem.clear();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); } };
  let handler = null;
  globalThis.window = { addEventListener: (n, h) => { if (n === "storage") handler = h; }, removeEventListener: (n) => { if (n === "storage") handler = null; } };
  resetRadarUiForTests();
  ok("starts closed", radarUiSnapshot().open === false);
  let calls = 0;
  const off = subscribeRadarUi(() => { calls++; });
  mem.set(RADAR_UI_KEY, JSON.stringify({ open: true, collapsed: ["buyer"], thresholds: { breakAwayPct: 3 } }));
  handler({ key: RADAR_UI_KEY });
  ok("another tab's write is re-read and notified", radarUiSnapshot().open === true && radarUiSnapshot().thresholds.breakAwayPct === 3 && calls === 1);
  handler({ key: "something-else" });
  ok("another key is ignored", calls === 1);
  off();
  ok("unsubscribe removes the listener", handler === null);
}

/* the R key */
{
  const el = (tag, extra = {}) => ({ tagName: tag, closest: () => null, ...extra });
  const doc = (over = {}) => ({ activeElement: el("BODY"), querySelector: () => null, ...over });
  ok("isEditableTarget: input, textarea, select", ["INPUT", "TEXTAREA", "SELECT"].every((t) => isEditableTarget(el(t))));
  ok("isEditableTarget: contenteditable, and a child of a role=textbox", isEditableTarget(el("DIV", { isContentEditable: true })) && isEditableTarget(el("SPAN", { closest: () => ({}) })));
  ok("isEditableTarget: a button, body, null, a non-element", !isEditableTarget(el("BUTTON")) && !isEditableTarget(el("BODY")) && !isEditableTarget(null) && !isEditableTarget("x") && !isEditableTarget({}));
  ok("R on the page toggles; r and R", shouldToggleRadar({ key: "r", target: el("BODY") }, doc()) && shouldToggleRadar({ key: "R", target: el("DIV") }, doc()));
  ok("other keys do not", !shouldToggleRadar({ key: "q", target: el("BODY") }, doc()) && !shouldToggleRadar({ key: "Escape" }, doc()));
  ok("ignored in an input, or when the focus is in one", !shouldToggleRadar({ key: "r", target: el("INPUT") }, doc()) && !shouldToggleRadar({ key: "r", target: el("BODY") }, doc({ activeElement: el("TEXTAREA") })));
  ok("ignored with a modifier, a repeat or a handled event", ["ctrlKey", "metaKey", "altKey", "repeat", "defaultPrevented"].every((m) => !shouldToggleRadar({ key: "r", [m]: true, target: el("BODY") }, doc())));
  ok("ignored while another dialog, alert dialog or menu is open", !shouldToggleRadar({ key: "r", target: el("BODY") }, doc({ querySelector: () => ({}) })));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
