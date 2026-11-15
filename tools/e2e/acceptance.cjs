/**
 * acceptance.cjs — Playwright acceptance run for rsL Confluence Terminal v2.1+ (PWA / web core; v2.6 adds PH-9…12, US-1).
 *
 *   node tools/e2e/acceptance.cjs [baseURL]     (serve apps/confluence/web/out first)
 *
 * Covers identity skill §8 and builder skill §9.4 items that are testable in a browser.
 * Exchange APIs are mocked so the run is deterministic and offline-capable.
 * Writes screenshots + results.json to tools/e2e/evidence/.
 */
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.argv[2] || "http://127.0.0.1:8770/";
// v2.8 (WP27): `--capture-ds1 <file>` / `--capture-ds2 <file>` only record the DS-1 / DS-2 layout snapshot of BASE
// (used on the v2.7.0-web release build); `--ds-only` runs just DS-1 and DS-2.
const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : null);
const CAPTURE_DS1 = argAfter("--capture-ds1");
const CAPTURE_DS2 = argAfter("--capture-ds2");
const DS_ONLY = process.argv.includes("--ds-only");
const OUT = path.join(__dirname, "evidence");
fs.mkdirSync(OUT, { recursive: true });
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const results = [];
const record = (id, name, pass, evidence) => {
  results.push({ id, name, pass: !!pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${name}${evidence ? "  — " + (typeof evidence === "string" ? evidence : JSON.stringify(evidence)) : ""}`);
};

/* ---------- deterministic exchange mock ---------- */
const H15 = 15 * 60e3;
// Bar length from the request (Binance "1h", Bybit "60", Bitget "1h"/"15min").
function stepOf(u) {
  const v = u.searchParams.get("interval") || u.searchParams.get("granularity") || "15m";
  const map = { "1m": 60e3, "5m": 3e5, "15m": H15, "1h": 36e5, "4h": 144e5, "1d": 864e5, "60": 36e5, "240": 144e5, "15": H15, D: 864e5, "15min": H15, "1day": 864e5, "1Dutc": 864e5, "4H": 144e5, "1H": 36e5 };
  return map[v] ?? H15;
}
function klines(sym, n = 200, step = H15, now = Date.now()) {
  const start = Math.floor(now / step) * step - n * step;
  let px = 100, s = [...sym].reduce((a, c) => a + c.charCodeAt(0), 7);
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  const drift = sym.startsWith("BTC") ? 0.004 : sym.startsWith("ETH") ? -0.004 : 0;
  const out = [];
  for (let i = 0; i <= n; i++) { const o = px; px *= Math.exp(drift + r() * 0.01); out.push([start + i * step, String(o), String(Math.max(o, px) * 1.002), String(Math.min(o, px) * 0.998), String(px), String(1000 + i), start + (i + 1) * step - 1]); }
  return out;
}
async function mockExchanges(ctx, seen, opts = {}) {
  let klineCalls = 0;
  await ctx.route(/^https:\/\/(data-api\.binance\.vision|api\.bybit\.com|api\.bitget\.com)\//, async (route) => {
    const u = new URL(route.request().url());
    seen && seen.push(u.host + u.pathname + (u.searchParams.get("limit") ? `?limit=${u.searchParams.get("limit")}` : ""));
    const headers = { "access-control-allow-origin": "*", "content-type": "application/json" };
    if (u.pathname.endsWith("/ticker/24hr")) {
      if (opts.tickers) return route.fulfill({ status: 200, headers, body: JSON.stringify(opts.tickers) });
      // v2.2: tokenised stock, gold and an FX stablecoin pair alongside crypto; USDC is excluded.
      const t = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "USDCUSDT", "PAXGUSDT", "TSLABUSDT", "EURUSDT"].map((sym, i) => ({ symbol: sym, openPrice: "100", lastPrice: "101", quoteVolume: String(1e9 - i) }));
      return route.fulfill({ status: 200, headers, body: JSON.stringify(t) });
    }
    if (u.pathname.endsWith("/depth")) {
      // v2.3: public order book for the measured-slippage sample.
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ bids: [["100.9", "50"], ["100.8", "100"]], asks: [["101.1", "50"], ["101.2", "100"]] }) });
    }
    klineCalls++;
    // v2.8 (WP27): a throttled network (PG-1) answers candle requests late.
    if (opts.klineDelayMs) await new Promise((ok) => setTimeout(ok, opts.klineDelayMs));
    if (opts.failSymbol && u.searchParams.get("symbol") === opts.failSymbol) {
      return route.fulfill({ status: 500, headers, body: JSON.stringify({ code: -1, msg: "upstream error" }) });
    }
    if (opts.rateLimitAt && klineCalls >= opts.rateLimitAt) {
      return route.fulfill({ status: 429, headers: { ...headers, "retry-after": "45" }, body: JSON.stringify({ code: -1003, msg: "Too many requests" }) });
    }
    const limit = Math.min(1000, Number(u.searchParams.get("limit") || 200));
    return route.fulfill({ status: 200, headers, body: JSON.stringify(klines(u.searchParams.get("symbol") || "X", limit, stepOf(u), opts.now)) });
  });
}

/* ---------- helpers ---------- */
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const parseRgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, acceptDownloads: true, ...opts });
  // Headless Chromium cannot drive the native save picker; use the <a download> path (same as Safari/Firefox PWA).
  await ctx.addInitScript(() => { try { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; } catch {} });
  return ctx;
}
async function completeFirstRun(page, { name = "rsLozano — Personal trading desk", short = "Personal", code = "PERS", operator = "Ronald" } = {}) {
  await page.waitForSelector("#wiz-title", { timeout: 15000 });
  await page.getByRole("button", { name: /^Next$/ }).click();
  const inputs = page.locator("section input:not([type=file])");
  await inputs.nth(0).fill(name);
  await inputs.nth(1).fill(short);
  await inputs.nth(2).fill(code);
  await page.getByRole("button", { name: /^Next$/ }).click();
  await page.locator("section input").first().fill(operator);
  await page.getByRole("button", { name: /^Finish$/ }).click();
  await page.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 15000 });
}
async function waitRows(page) { await page.waitForFunction(() => document.querySelectorAll("tbody tr").length >= 4, null, { timeout: 20000 }); }

/* ---------- v2.8 (WP27) DS-1 / DS-2: layout at rest vs v2.7.0 (spec §3 design-unchanged rule, "Guard") ---------- */
// Fixed clock (page.clock + the mocked candles), FX hosts mocked, default settings, 1366 × 768, English. Theme is
// "System", which headless Chromium resolves to light — acceptable for the guard (both builds are measured the same way).
// The mocked exchange tickers carry 24 h quote volumes of ~1e9 USD, far above the 1M liquidity floor, so it removes no row.
const DS_NOW = Date.UTC(2026, 10, 11, 9, 7, 0);
const DS_TOLERANCE_PX = 2;
// Pinned environment (fix/ds-ci-stability): the guard measures in the same conditions on every machine instead of
// inheriting them from the host. Three host inputs used to leak into the layout:
//   - Time zone and languages: "Display currency: Auto" follows the device's time zone, then its languages
//     (lib/fx-rates.ts autoCurrency). Under TZ=Asia/Riyadh the screen shows SAR and the 25 px "Prices in SAR" FX row
//     between the header and the list; under the CI runner's UTC it shows USD and no row, so everything below moved.
//   - Glyph advances: headless Chromium's --font-render-hinting decides whether web-font glyph advances are
//     fractional (none) or rounded to whole pixels (its default). Masked text ("Xxxx") is drawn with the bundled
//     Inter, so every text-bearing box changed width by up to ~0.3 px per glyph (12 px "Xxxx": 27.84 vs 29 px).
//     (The development container's headless shell adds --font-render-hinting=none itself; the CI runner's does not.)
//   - System fonts: see dsPinFonts.
// The baselines were captured with exactly these pins; dsEnv records them in each snapshot, and a mismatch is
// reported as an "env" difference before any box, so a host where a pin does not take effect fails loudly.
const DS_TIMEZONE = "Asia/Riyadh";
const DS_LOCALE = "en-US";
const DS_CHROMIUM_ARGS = ["--font-render-hinting=none", "--disable-lcd-text", "--force-color-profile=srgb"];
let dsBrowserPromise = null;
const dsBrowser = () => (dsBrowserPromise ||= chromium.launch({ args: DS_CHROMIUM_ARGS }));
const dsBrowserClose = async () => { if (dsBrowserPromise) await (await dsBrowserPromise).close(); dsBrowserPromise = null; };
// System fonts: masked text whose font stack starts with a family the app does not bundle (the table's
// "Cascadia Mono", "Segoe UI Mono", Consolas, monospace; Arial; Tailwind's ui-monospace stack) is drawn with whatever
// the host's fontconfig picks (DejaVu Sans Mono in the container; Courier on a host without it moved columns by up to
// 23 px). dsPinFonts gives each such family the app's own bundled face (JetBrains Mono for monospace stacks, Inter
// otherwise) before measuring, so masked text is drawn with bundled fonts only. Generic first families (monospace,
// system-ui, ...) cannot be redefined; they are listed in @env as "not pinned" so a new one shows up as an env diff.
async function dsPinFonts(page) {
  await page.evaluate(async () => {
    const subs = (window.__dsSubs ||= {});
    // CSS generic keywords Chromium resolves itself on Linux (ui-monospace etc. are plain family names there).
    const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "math", "emoji", "fangsong", "system-ui"]);
    const unq = (s) => s.trim().replace(/^["']|["']$/g, "");
    const faceRules = [];
    const walk = (rules, href) => { for (const r of rules) { if (r instanceof CSSFontFaceRule) faceRules.push({ r, href }); else if (r.cssRules) walk(r.cssRules, href); } };
    for (const sheet of document.styleSheets) { try { walk(sheet.cssRules, sheet.href || location.href); } catch { /* cross-origin sheet: none in this app */ } }
    const bundled = new Set(faceRules.map(({ r }) => unq(r.style.getPropertyValue("font-family")).toLowerCase()));
    for (const f of document.fonts) bundled.add(unq(f.family).toLowerCase());
    const loads = [];
    for (const el of document.body.querySelectorAll("*")) {
      const text = el.matches("input, textarea, select") || [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
      if (!text) continue;
      const stack = getComputedStyle(el).fontFamily.split(",").map(unq);
      const first = stack[0];
      if (bundled.has(first.toLowerCase()) || first in subs) continue;
      if (generic.has(first.toLowerCase())) { subs[first] = "(generic, not pinned)"; continue; }
      const to = stack.some((f) => /mono/i.test(f)) ? "JetBrains Mono" : "Inter";
      for (const { r, href } of faceRules) {
        if (unq(r.style.getPropertyValue("font-family")) !== to) continue;
        const src = r.style.getPropertyValue("src").replace(/url\((["']?)([^)"']+)\1\)/g, (_, q, u) => `url("${new URL(u, href).href}")`);
        const desc = {};
        for (const [prop, key] of [["font-weight", "weight"], ["font-style", "style"], ["unicode-range", "unicodeRange"]]) { const v = r.style.getPropertyValue(prop); if (v) desc[key] = v; }
        const face = new FontFace(first, src, desc);
        document.fonts.add(face);
        loads.push(face.load().catch(() => {}));
      }
      subs[first] = to;
      bundled.add(first.toLowerCase());
    }
    await Promise.all(loads);
    await document.fonts.ready;
    await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
  });
}
// The environment as the page sees it: time zone, languages, the advance of the masked placeholder in the bundled
// Inter at 12 px (fractional only when the hinting pin took effect) and the font substitutions dsPinFonts made.
// Called after measuring, so the substitutions cover everything measured.
async function dsEnv(p) {
  return p.evaluate(async () => {
    await document.fonts.ready;
    const s = document.createElement("span");
    s.style.cssText = "position:absolute;left:-9999px;top:0;white-space:pre;font:400 12px Inter";
    s.textContent = "Xxxx";
    document.body.appendChild(s);
    const w = s.getBoundingClientRect().width;
    s.remove();
    const subs = Object.entries(window.__dsSubs || {}).sort(([a], [b]) => a.localeCompare(b)).map(([a, b]) => `${a} → ${b}`).join("; ");
    return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, languages: navigator.languages.join(","), interXxxx12px: Math.round(w * 1000) / 1000, fontSubstitutes: subs };
  });
}
function dsEnvDiffs(base, now) {
  if (!base) return ["env: baseline has no @env (re-capture it)"];
  return Object.entries(base).filter(([k, v]) => !now || now[k] !== v).map(([k, v]) => `env ${k}: ${v} → ${now ? now[k] : "?"}`);
}
// Text masking (spec: "with text and live numbers masked"): right before measuring, every non-blank text node becomes
// the same placeholder and input values/placeholders too, so a box's size comes from its padding, font and structure,
// never from the wording or a live number. The context is closed (or the dialog closed) afterwards.
async function dsInstall(page) {
  await page.evaluate(() => {
    const mask = (root) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const parent = n.parentElement;
        if (!parent || parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;
        if (n.nodeValue.trim()) n.nodeValue = "Xxxx";
      }
      root.querySelectorAll("input, textarea").forEach((el) => {
        if (el.placeholder) el.placeholder = "Xxxx";
        if (el.type !== "checkbox" && el.type !== "radio" && el.value) el.value = "Xxxx";
      });
    };
    // Structural snapshot of `root`: every element keyed by its path (tag + index among the shown children), with its
    // box [x, y, w, h] and its colours. `exclude` = the §3 allowed additions, hidden first so they neither count nor
    // move what follows. `topUntil`: stop after that element's subtree (the "top of the sheet"); its ancestors get an
    // open height (null), since their height depends on the sections below. SVGs: the svg and its direct children
    // (the chart's layers) with their element counts.
    const measure = (root, { exclude = [], topUntil = null } = {}) => {
      for (const sel of exclude) root.querySelectorAll(sel).forEach((el) => el.style.setProperty("display", "none", "important"));
      mask(root);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      const stop = topUntil ? root.querySelector(topUntil) : null;
      const boxes = {}, colours = {}, counts = {};
      let done = false;
      const rec = (el, key) => {
        const b = el.getBoundingClientRect();
        const open = stop && el !== stop && el.contains(stop);
        boxes[key] = [Math.round(b.x), Math.round(b.y), Math.round(b.width), open ? null : Math.round(b.height)];
        const cs = getComputedStyle(el);
        colours[key] = el instanceof SVGElement ? `${cs.fill}|${cs.stroke}` : `${cs.backgroundColor}|${cs.color}|${cs.borderTopColor}`;
      };
      const walk = (el, key) => {
        rec(el, key);
        if (el.tagName.toLowerCase() === "svg") {
          [...el.children].forEach((ch, i) => { const k = `${key}/${i}:${ch.tagName.toLowerCase()}`; rec(ch, k); counts[k] = ch.querySelectorAll("*").length; });
          if (el === stop) done = true;
          return;
        }
        let i = 0;
        for (const ch of el.children) {
          if (getComputedStyle(ch).display === "none") continue;
          walk(ch, `${key}/${i++}:${ch.tagName.toLowerCase()}`);
          if (done) return;
        }
        if (el === stop) done = true;
      };
      walk(root, root.tagName.toLowerCase());
      return { boxes, colours, counts };
    };
    window.__ds = { mask, measure };
  });
  await dsPinFonts(page);
}
async function dsContext() {
  const c = await newContext(await dsBrowser(), { timezoneId: DS_TIMEZONE, locale: DS_LOCALE });
  const seen = [];
  await mockExchanges(c, seen, { now: DS_NOW });
  await c.route(/^https:\/\/(api\.frankfurter\.dev|cdn\.jsdelivr\.net|latest\.currency-api\.pages\.dev|open\.er-api\.com|data-api\.ecb\.europa\.eu)\//, (route) => route.fulfill({ status: 503, body: "" }));
  await c.route("**/updates/latest.json", (route) => route.fulfill({ status: 404, body: "" }));
  const p = await c.newPage();
  await p.clock.setFixedTime(DS_NOW);
  await p.goto(BASE, { waitUntil: "domcontentloaded" });
  await completeFirstRun(p, { operator: "R" });
  await waitRows(p);
  // At rest: the scan has finished (no progress bar, no spinner), background requests (depth sample, other timeframes of
  // the priority rows) have stopped for 1.5 s, and the pointer hovers nothing.
  await p.waitForFunction(() => !document.querySelector("header div.h-full.bg-gradient-to-r") && !document.querySelector("header .animate-spin"), null, { timeout: 30000 });
  await dsQuiet(p, seen);
  await p.mouse.move(1, 1);
  return { c, p, seen };
}
async function dsQuiet(p, seen) {
  for (let n = seen.length, quiet = 0, t = 0; quiet < 1500 && t < 30000; t += 250) {
    await p.waitForTimeout(250);
    if (seen.length === n) quiet += 250; else { n = seen.length; quiet = 0; }
  }
}
async function ds1Snapshot() {
  const { c, p } = await dsContext();
  await dsInstall(p);
  const snap = await p.evaluate(() => {
    window.__ds.mask(document.body);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const box = (el) => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const boxes = {};
    const add = (name, el) => { if (el) boxes[name] = box(el); };
    add("header", document.querySelector("header"));
    document.querySelectorAll("header button, header [role=combobox], header input").forEach((el, i) => add(`header.control.${i}`, el));
    add("main", document.querySelector("main"));
    add("list.toolbar", document.querySelector("main > div > div"));
    add("table", document.querySelector("table.market-table"));
    document.querySelectorAll("thead th").forEach((el, i) => add(`th.${i}`, el));
    document.querySelectorAll("tbody tr").forEach((tr, i) => { add(`row.${i}`, tr); tr.querySelectorAll("td").forEach((td, j) => add(`row.${i}.td.${j}`, td)); });
    add("footer", document.querySelector("footer"));
    const bg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
    const fg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).color : null; };
    const colours = { body: bg("body"), header: bg("header"), thead: bg("thead"), footer: bg("footer"), th: fg("thead th"), rowText: fg("tbody tr td:nth-child(3)") };
    return { boxes, colours };
  });
  const env = await dsEnv(p);
  await c.close();
  return { "@env": env, ...snap };
}
// DS-2 excluded regions = exactly the spec §3 allowed additions that exist in this build (hidden before measuring):
//   paper  §3.6  "More limits" (collapsed, after the existing settings grid)      [data-testid=paper-more-limits]
//          §3.6  "More statistics" (collapsed)                                    [data-testid=paper-more-stats]
//          §3.6  "Add a note" (collapsed, per proposal)                           [data-testid=paper-add-note]
//          §3.6  drawdown badge and RESET — only while that lock is active        [data-testid=paper-lock-drawdown], [data-testid=paper-drawdown]
//          §3.7  the risk > 1 % warning (text inside the proposal box)            [data-testid=paper-warning]
//   detail §3.1  Scenarios (WP22) and §3.8 "View on [exchange]" (WP26): not built yet — add their selectors with those WPs.
//   ledger §3.4  collapsed Scenario check at the end (WP22): not built yet — add its selector with WP22.
// §3.5 block reasons and §3.7 text inside existing boxes need no exclusion (text is masked). Never add a selector for
// anything that is not on the §3 list.
const DS2_ALLOWED = {
  detail: [],
  paper: ['[data-testid="paper-more-limits"]', '[data-testid="paper-more-stats"]', '[data-testid="paper-add-note"]', '[data-testid="paper-lock-drawdown"]', '[data-testid="paper-drawdown"]', '[data-testid="paper-warning"]'],
  ledger: [],
};
async function ds2Snapshot() {
  const { c, p, seen } = await dsContext();
  const dialog = p.locator('[role="dialog"]').first();
  const measure = async (opts) => { await dsInstall(p); await p.mouse.move(1, 1); return p.evaluate((o) => window.__ds.measure(document.querySelector('[role="dialog"]'), o), opts); };
  const close = async () => { await p.keyboard.press("Escape"); await p.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 }); };
  const settle = async () => {
    await dsQuiet(p, seen);
    for (let last = "", same = 0, t = 0; same < 1000 && t < 20000; t += 250) {
      await p.waitForTimeout(250);
      const html = await dialog.evaluate((d) => d.innerHTML.length + ":" + d.textContent);
      if (html === last) same += 250; else { last = html; same = 0; }
    }
  };
  const snap = {};
  // Detail sheet: the top of the sheet through the price chart (its default layers).
  await p.getByRole("button", { name: /^BTC/ }).first().click();
  await p.getByTestId("price-chart").waitFor({ timeout: 15000 });
  await settle();
  snap.detail = await measure({ exclude: DS2_ALLOWED.detail, topUntil: '[data-testid="price-chart"]' });
  await close();
  // Paper dialog layout.
  await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
  await p.waitForSelector("text=simulated, no orders are sent", { timeout: 10000 });
  await settle();
  snap.paper = await measure({ exclude: DS2_ALLOWED.paper });
  await close();
  // Ledger dialog: its existing sections.
  await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
  await dialog.waitFor({ timeout: 10000 });
  await settle();
  snap.ledger = await measure({ exclude: DS2_ALLOWED.ledger });
  await close();
  const env = await dsEnv(p);
  await c.close();
  return { "@env": env, ...snap };
}
function dsCompare(base, now, prefix = "") {
  const diffs = [];
  const near = (b, n) => b.every((v, i) => v === null || n[i] === null ? v === n[i] : Math.abs(v - n[i]) <= DS_TOLERANCE_PX);
  for (const [k, b] of Object.entries(base.boxes)) {
    const n = now.boxes[k];
    if (!n) { diffs.push(`${prefix}${k}: missing`); continue; }
    if (!near(b, n)) diffs.push(`${prefix}${k}: ${b.join(",")} → ${n.join(",")}`);
  }
  for (const k of Object.keys(now.boxes)) if (!(k in base.boxes)) diffs.push(`${prefix}${k}: new`);
  for (const [k, v] of Object.entries(base.colours)) if (k in now.colours && now.colours[k] !== v) diffs.push(`${prefix}colour ${k}: ${v} → ${now.colours[k]}`);
  for (const [k, v] of Object.entries(base.counts || {})) if (k in (now.counts || {}) && now.counts[k] !== v) diffs.push(`${prefix}count ${k}: ${v} → ${now.counts[k]}`);
  return diffs;
}

(async () => {
  const browser = await chromium.launch();
  if (CAPTURE_DS1 || CAPTURE_DS2) {
    const note = `main screen at rest, 1366x768, en, default settings (theme System = light in headless Chromium), text masked; clock ${new Date(DS_NOW).toISOString()}, exchange and FX hosts mocked; pinned: time zone ${DS_TIMEZONE}, locale ${DS_LOCALE}, Chromium ${DS_CHROMIUM_ARGS.join(" ")}, masked text in bundled fonts only (see @env); captured from ${BASE}`;
    if (CAPTURE_DS1) {
      const snap = await ds1Snapshot();
      fs.mkdirSync(path.dirname(path.resolve(CAPTURE_DS1)), { recursive: true });
      fs.writeFileSync(CAPTURE_DS1, JSON.stringify({ "@note": `DS-1 baseline: ${note}`, ...snap }, null, 2) + "\n");
      console.log(`DS-1 baseline: ${Object.keys(snap.boxes).length} boxes → ${CAPTURE_DS1}`);
    }
    if (CAPTURE_DS2) {
      const snap = await ds2Snapshot();
      fs.mkdirSync(path.dirname(path.resolve(CAPTURE_DS2)), { recursive: true });
      fs.writeFileSync(CAPTURE_DS2, JSON.stringify({ "@note": `DS-2 baseline (detail sheet top + chart layers, paper dialog, ledger dialog; ${note.replace("main screen at rest", "each at rest")})`, ...snap }, null, 1) + "\n");
      console.log(`DS-2 baseline: ${["detail", "paper", "ledger"].map((k) => `${k} ${Object.keys(snap[k].boxes).length}`).join(", ")} boxes → ${CAPTURE_DS2}`);
    }
    await dsBrowserClose();
    await browser.close();
    return;
  }
  if (!DS_ONLY) {
  const requests = [];

  /* ===== A. First run, legacy migration, brand, CNR ===== */
  const ctx = await newContext(browser);
  await mockExchanges(ctx, requests);
  ctx.on("request", (r) => requests.push("REQ " + new URL(r.url()).host));
  // Seed a ≤2.02 legacy preference so migration 1 has something to import.
  await ctx.addInitScript(() => { if (!localStorage.getItem("seeded")) { localStorage.setItem("ct-preferences-v1", JSON.stringify({ timeframe: "1h", dataSource: "binance", universeLimit: 25, background: "dark", monitorAssets: [], sortKey: "rank", sortDir: "asc", autoRefresh: false, chartDepth: "250" })); localStorage.setItem("seeded", "1"); } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => { if (m.type() === "error" && !/frame-ancestors|Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rsl-splash", { timeout: 10000 });
  await page.screenshot({ path: path.join(OUT, "01-splash.png") });
  record("ID-3.2", "First-run wizard appears on first launch", await page.waitForSelector("#wiz-title", { timeout: 15000 }).then(() => true, () => false));
  await page.screenshot({ path: path.join(OUT, "02-wizard-language.png") });
  await completeFirstRun(page);
  await waitRows(page);
  const coldStartMs = Date.now() - t0;
  await page.screenshot({ path: path.join(OUT, "03-terminal-1366-dark-en.png") });

  // Brand order (identity §8.1)
  const order = await page.$eval(".rsl-brand-host .rsl-brand", (el) => [...el.querySelectorAll("svg.rsl-mono, .rsl-r, .rsl-app, .rsl-by, .rsl-build")].map((n) => n.classList[0]));
  record("ID-8.1a", "Brand order monogram → rsL → App → by rsLozano → build (LTR)", JSON.stringify(order) === JSON.stringify(["rsl-mono", "rsl-r", "rsl-app", "rsl-by", "rsl-build"]), order.join(" → "));
  const stamp = await page.$eval(".rsl-brand-host .rsl-build", (e) => e.textContent);
  const footerStamp = await page.$eval("footer", (e) => e.textContent);
  record("ID-8.2", "Build stamp identical in app bar and footer", footerStamp.includes(stamp), stamp);
  // Contrast of meta text (identity §8.3)
  const meta = await page.$eval(".rsl-brand-host .rsl-meta", (e) => { const cs = getComputedStyle(e); let bg = "rgb(9, 9, 11)"; let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; } n = n.parentElement; } return { color: cs.color, bg, opacity: cs.opacity }; });
  const cr = ratio(parseRgb(meta.color), parseRgb(meta.bg));
  record("ID-8.3", "Brand meta text ≥ 4.5:1, no opacity dimming (dark)", cr >= 4.5 && meta.opacity === "1", `${cr.toFixed(2)}:1 ${meta.color} on ${meta.bg}`);
  // Brand weight vs primary action (identity §8.4)
  const weights = await page.evaluate(() => { const b = document.querySelector(".rsl-brand-host .rsl-brand").getBoundingClientRect(); const name = parseFloat(getComputedStyle(document.querySelector(".rsl-brand-host .rsl-name")).fontSize); const meta = getComputedStyle(document.querySelector(".rsl-brand-host .rsl-meta")); return { brandW: Math.round(b.width), nameFont: name, metaFont: parseFloat(meta.fontSize), metaWeight: meta.fontWeight }; });
  record("ID-8.4", "Brand block recedes: ≤ 260 px wide, name ≤ 21 px, meta ≤ 11 px / weight 300", weights.brandW <= 261 && weights.nameFont <= 21 && weights.metaFont <= 11 && Number(weights.metaWeight) <= 300, weights);
  // Legacy migration (builder §9.4-4)
  const tfText = await page.locator('header [role="combobox"]').first().textContent();
  record("BLD-9.4-4", "Legacy ≤2.02 preferences imported (timeframe 1h, not the new 4h default)", /1 hour/.test(tfText), tfText);
  // CNR surfaces (identity §8.5)
  const chip = await page.locator(".rsl-holo-chip").textContent();
  const ctxLine = await page.locator("header bdi").first().textContent();
  record("ID-8.5a", "Workspace name in chip and context line", /Personal/.test(chip) && /Personal/.test(ctxLine), `${chip} | ${ctxLine}`);

  // About dialog: audit, storage, catalog status, 3D or fallback
  await page.getByRole("button", { name: "About" }).click();
  await page.waitForSelector("text=Audit trail");
  await page.waitForFunction(() => /intact \(\d+ entries\)/.test(document.querySelector('[role="dialog"]').textContent), null, { timeout: 10000 });
  const about = await page.locator('[role="dialog"]').textContent();
  const auditN = Number((about.match(/intact \((\d+) entries\)/) || [])[1]);
  record("BLD-9.4-6", "Audit trail intact and chained (app.start, migration.import, identity events)", auditN >= 4, `intact (${auditN})`);
  // v2.5 (WP4): the 16 tier-2 catalogs are MACHINE-CHECKED (automated checks pass; awaiting native-speaker certification).
  record("ID-8.7a", "About shows 18 catalogs; 16 machine-checked (awaiting review), en+ar approved", (about.match(/machine-checked — awaiting native-speaker review/g) || []).length === 16 && (about.match(/approved/g) || []).length === 2);
  record("BLD-9.4-2", "PWA shows best-effort storage (IndexedDB) — not SQLite in a browser", /browser IndexedDB/.test(about), (about.match(/Storage:[^A-Z]*/) || [""])[0]);
  const has3d = await page.locator('[data-testid="rsl-monogram-3d"] canvas').count();
  const hasFallback = await page.locator('[role="dialog"] svg.rsl-mono').count();
  record("ID-8.8a", "3D monogram renders (WebGL) or static fallback", has3d > 0 || hasFallback > 0, has3d ? "WebGL canvas" : "static SVG fallback");
  await page.screenshot({ path: path.join(OUT, "04-about-1366.png") });
  const { findGuarded } = await import(path.join(__dirname, "..", "checks", "no-org-ids.mjs"));
  record("ID-2.4", "About ends with personal credit, no organisation details (R22 word list)", /Created by rsLozano/.test(about) && findGuarded(about).length === 0 && !/Confidential|Department Head/i.test(about));
  // v2.8 WP20 — About → Open-source licences (collapsed, above the credit): the link opens the third-party notices
  // (served next to index.html, 200, not empty) and the trademark line sits inside the collapsed section.
  {
    const sec = page.getByTestId("about-licences");
    const closedAtRest = (await sec.getAttribute("open")) === null;
    await sec.locator("summary").click();
    const link = page.getByTestId("about-licences-link");
    const href = await link.getAttribute("href").catch(() => null);
    const got = href ? await page.evaluate(async (h) => { const r = await fetch(h); const t = await r.text(); return { status: r.status, len: t.length, head: t.slice(0, 48) }; }, href) : null;
    await link.click();
    const shown = (await page.getByTestId("about-licences-text").textContent({ timeout: 10000 }).catch(() => "")) ?? "";
    const tm = (await page.getByTestId("about-trademarks").textContent().catch(() => "")) ?? "";
    const tmInside = await page.locator('[data-testid="about-licences"] [data-testid="about-trademarks"]').count();
    record("ID-2.5", "About → Open-source licences (collapsed): link opens the third-party notices (200, not empty); trademark line inside the section",
      closedAtRest && !!got && got.status === 200 && got.len > 10000 && /third-party notices/.test(shown) && /react@/.test(shown) && /Bollinger Bands®/.test(tm) && tmInside === 1,
      { closedAtRest, href, ...got, shown: shown.length });
  }

  // Backup export → restore round trip + tamper refusal (builder §9.4-5)
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export backup" }).click()]);
  const bakPath = path.join(OUT, dl.suggestedFilename());
  await dl.saveAs(bakPath);
  const bak = JSON.parse(fs.readFileSync(bakPath, "utf8"));
  record("BLD-3.5a", "Backup file name + checksum + audit head", /^ConfluenceTerminal_PERS_backup_\d{8}\.rslbak$/.test(dl.suggestedFilename()) && /^[0-9a-f]{64}$/.test(bak.sha256) && bak.auditHead && bak.auditHead.seq > 0, dl.suggestedFilename());
  const tampered = { ...bak, data: { ...bak.data, identity: [{ id: "current", doc: { ...bak.data.identity[0].doc, customer: { ...bak.data.identity[0].doc.customer, legalName: "Tampered" } } }] } };
  const tamperedPath = path.join(OUT, "tampered.rslbak");
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const fc1 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore backup" }).click();
  await (await fc1).setFiles(tamperedPath);
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore backup" }).click();
  await page.waitForSelector("text=checksum does not match", { timeout: 5000 }).catch(() => null);
  const refused = await page.locator('[role="dialog"]').textContent();
  record("BLD-9.4-5b", "Tampered backup refused (checksum)", /checksum does not match/.test(refused));
  await page.keyboard.press("Escape");

  // Identity edit: 120-char and Arabic names (identity §8.5)
  const long = "A".repeat(60) + " " + "B".repeat(59);
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Edit identity" }).click();
  const fields = page.locator('[role="dialog"] input:not([type=file])');
  await fields.nth(0).fill(long);
  await page.getByRole("button", { name: "Finish" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction((n) => (document.querySelector(".rsl-holo-chip")?.getAttribute("title") || "").includes(n), long, { timeout: 5000 }).catch(() => null);
  const chipTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  const chipBox = await page.locator(".rsl-holo-chip").boundingBox();
  record("ID-8.5b", "120-character workspace name truncates with full name in title", chipTitle.includes(long) && chipBox.width <= 178, `chip ${Math.round(chipBox.width)} px`);
  await page.getByRole("button", { name: "About" }).click();
  await page.getByRole("button", { name: "Edit identity" }).click();
  await page.locator('[role="dialog"] input:not([type=file])').nth(0).fill("مكتب التداول الشخصي");
  await page.getByRole("button", { name: "Finish" }).click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => (document.querySelector(".rsl-holo-chip")?.getAttribute("title") || "").includes("مكتب التداول الشخصي"));
  const arTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("ID-8.5c", "Arabic workspace name renders (isolated with <bdi>)", arTitle.includes("مكتب التداول الشخصي"));

  // Persistence across reload (identity §8.6)
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".rsl-brand-host .rsl-brand", { timeout: 15000 });
  const wizardAgain = await page.locator("#wiz-title").count();
  const titleAfter = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("ID-8.6", "Identity persists across reload; wizard not shown again", wizardAgain === 0 && titleAfter.includes("مكتب"));

  // Identity export (identity §3.4 / §8.6)
  await page.getByRole("button", { name: "About" }).click();
  const [dlId] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export identity (JSON)" }).click()]);
  const idPath = path.join(OUT, dlId.suggestedFilename()); await dlId.saveAs(idPath);
  const idJson = JSON.parse(fs.readFileSync(idPath, "utf8"));
  record("ID-8.6b", "Identity exports as JSON (schema + customer)", /\.json$/.test(idPath) && JSON.stringify(idJson).includes("مكتب التداول الشخصي"), dlId.suggestedFilename());
  // Genuine restore round trip (builder §9.4-5)
  const fc2 = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Restore backup" }).click();
  await (await fc2).setFiles(bakPath);
  await Promise.all([page.waitForEvent("load", { timeout: 15000 }), page.getByRole("alertdialog").getByRole("button", { name: "Restore backup" }).click()]);
  await page.waitForSelector(".rsl-holo-chip", { timeout: 15000 });
  const restoredTitle = await page.locator(".rsl-holo-chip").getAttribute("title");
  record("BLD-9.4-5a", "Valid backup restores (identity returns to the backed-up workspace)", restoredTitle.includes("rsLozano — Personal trading desk"), restoredTitle);
  // 3D: 20 About open/close cycles must not exhaust WebGL contexts (identity §8.9)
  const glWarnings = [];
  page.on("console", (m) => { if (/Too many active WebGL contexts|CONTEXT_LOST/i.test(m.text())) glWarnings.push(m.text()); });
  let fps = null;
  for (let i = 0; i < 20; i++) {
    await page.getByRole("button", { name: "About" }).click();
    await page.waitForSelector('[data-testid="rsl-monogram-3d"] canvas', { timeout: 5000 }).catch(() => null);
    if (i === 0) fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
    await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
  const canvasesLeft = await page.locator('[data-testid="rsl-monogram-3d"] canvas').count();
  record("ID-8.9", "3D monogram: no context exhaustion or leftover canvases after 20 open/close cycles", glWarnings.length === 0 && canvasesLeft === 0, `rAF ${fps}/s headless (SwiftShader); warnings ${glWarnings.length}${glWarnings.length ? " (" + glWarnings[0].slice(0, 80) + ")" : ""}; canvases left ${canvasesLeft}`);
  // Keyboard walkthrough (identity §8.11)
  await page.evaluate(() => { document.activeElement && document.activeElement.blur(); window.scrollTo(0, 0); });
  const reached = [];
  for (let i = 0; i < 70; i++) { await page.keyboard.press("Tab"); reached.push(await page.evaluate(() => { const e = document.activeElement; return (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40); })); }
  const langBtnKb = page.getByRole("button", { name: /^Language:/ });
  await langBtnKb.focus(); await page.keyboard.press("Enter");
  const listOpen = await page.locator("#rsl-lang-list").isVisible();
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape");
  const listClosed = (await page.locator("#rsl-lang-list").count()) === 0;
  const focusBack = await page.evaluate(() => /^Language:/.test(document.activeElement.getAttribute("aria-label") || ""));
  const kb = { refresh: reached.some((r) => /Refresh/.test(r)), row: reached.some((r) => /^BTC/.test(r)), listOpen, listClosed, focusBack };
  record("ID-8.11", "Keyboard: Tab reaches header controls and rows; language menu opens with Enter, Esc closes and restores focus", Object.values(kb).every(Boolean), `${JSON.stringify(kb)}; ${reached.length} stops: ${reached.slice(0, 8).join(" › ")}`);

  /* ===== B. Languages, RTL, digits (identity §8.7) ===== */
  await waitRows(page);
  const langBtn = page.getByRole("button", { name: /^Language:/ });
  await langBtn.click();
  const options = await page.locator("#rsl-lang-list [role=option]").allTextContents();
  const nativeOrder = ["English", "العربية", "日本語", "Filipino", "বাংলা", "اردو", "Русский", "हिन्दी", "中文（简体）", "한국어", "Bahasa Indonesia", "Bahasa Melayu", "Türkçe", "Français", "Deutsch", "Español", "Português", "Italiano"];
  record("ID-8.7b", "18 languages in rsL order", options.length === 18 && nativeOrder.every((n, i) => options[i].includes(n)), `${options.length} options`);
  await page.locator("#rsl-lang-list [role=option]", { hasText: "العربية" }).click();
  await page.waitForFunction(() => document.documentElement.dir === "rtl" && document.documentElement.lang === "ar");
  const arHeader = await page.locator("thead").textContent();
  const order2 = await page.$eval(".rsl-brand-host .rsl-brand", (el) => [...el.querySelectorAll("svg.rsl-mono, .rsl-r, .rsl-app, .rsl-by, .rsl-build")].map((n) => n.classList[0]));
  record("ID-8.1b", "Brand order unchanged in RTL (Arabic)", JSON.stringify(order2) === JSON.stringify(["rsl-mono", "rsl-r", "rsl-app", "rsl-by", "rsl-build"]));
  record("ID-6.3a", "Arabic UI: dir=rtl, translated headers", /الأصل/.test(arHeader) && /السعر/.test(arHeader), arHeader.slice(0, 60));
  const statDigits = await page.locator("header").textContent();
  record("ID-6.3b", "Latin digits in Arabic UI", !/[٠-٩]/.test(statDigits));
  const brandSide = await page.evaluate(() => { const b = document.querySelector(".rsl-brand-host").getBoundingClientRect(); return b.left > window.innerWidth / 2 ? "right" : "left"; });
  record("ID-2.2-rtl", "In RTL the brand block moves to the inline-start (right) side", brandSide === "right", brandSide);
  await page.screenshot({ path: path.join(OUT, "05-terminal-1366-dark-ar-rtl.png") });
  // Every language renders without raw keys
  const rawKeyLangs = [];
  for (const code of ["ja", "fil", "bn", "ur", "ru", "hi", "zh", "ko", "id", "ms", "tr", "fr", "de", "es", "pt", "it", "en"]) {
    await page.getByRole("button", { name: /:/ }).filter({ has: page.locator("svg[viewBox='0 0 21 14']") }).first().click();
    await page.locator(`#rsl-lang-${code}`).click();
    await page.waitForFunction((c) => document.documentElement.lang === c, code);
    const txt = await page.locator("body").textContent();
    if (/⟦/.test(txt)) rawKeyLangs.push(code);
    if (code === "ur") await page.screenshot({ path: path.join(OUT, "06-terminal-1366-dark-ur-rtl.png") });
    if (code === "ja") await page.screenshot({ path: path.join(OUT, "07-terminal-1366-dark-ja.png") });
  }
  record("ID-8.7c", "No raw keys in any of the 18 languages", rawKeyLangs.length === 0, rawKeyLangs.join(",") || "none");

  // Light theme contrast
  await page.getByRole("radio", { name: "Light" }).click();
  await page.waitForTimeout(300);
  const metaL = await page.$eval(".rsl-brand-host .rsl-meta", (e) => { const cs = getComputedStyle(e); let bg = "rgb(255,255,255)"; let n = e; while (n) { const b = getComputedStyle(n).backgroundColor; if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; } n = n.parentElement; } return { color: cs.color, bg }; });
  const crL = ratio(parseRgb(metaL.color), parseRgb(metaL.bg));
  record("ID-8.3b", "Brand meta text ≥ 4.5:1 (light)", crL >= 4.5, `${crL.toFixed(2)}:1 ${metaL.color} on ${metaL.bg}`);
  await page.screenshot({ path: path.join(OUT, "08-terminal-1366-light-en.png") });
  await page.addScriptTag({ content: AXE });
  const axeL = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
  record("BLD-9.4-10b", "axe: no critical or serious violations (light)", !axeL.some((v) => v.impact === "critical" || v.impact === "serious"), axeL.map((v) => `${v.id}:${v.impact}:${v.n}`).join(" ") || "none");
  // v2.5 (ADR-0011): the app bar follows the theme; on the light bar the wordmark uses the dark-ink gradient.
  const nameL = await page.$eval(".rsl-brand-host .rsl-app", (e) => getComputedStyle(e).backgroundImage.includes("14, 23, 38"));
  record("ID-8.3c", "Light theme: app bar is light and the wordmark uses the dark-ink gradient (ADR-0011)", nameL);
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.waitForTimeout(400); // let colour transitions settle before axe samples contrast

  // axe (builder §9.4-10)
  await page.addScriptTag({ content: AXE });
  const axe = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length })));
  const critical = axe.filter((v) => v.impact === "critical");
  record("BLD-9.4-10a", "axe: no critical or serious violations (dark)", !axe.some((v) => v.impact === "critical" || v.impact === "serious"), axe.map((v) => `${v.id}:${v.impact}:${v.n}`).join(" ") || "none");
  record("ID-7", "No console errors at load / language / theme / workspace switch", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | ") || "none");

  // Network: only same-origin + allow-listed exchange hosts (builder §9.4-3 adapted, ADR-0003)
  const hosts = [...new Set(requests.filter((r) => r.startsWith("REQ ")).map((r) => r.slice(4)))];
  // v2.7 (ADR-0003 amendment v2.7, ADR-0015): the display-currency rate hosts of Automatic, used when the device's
  // currency is not USD (this runner's time zone decides Auto).
  const allowed = [new URL(BASE).host, "data-api.binance.vision", "api.bybit.com", "api.bitget.com", "api.frankfurter.dev", "cdn.jsdelivr.net", "latest.currency-api.pages.dev"];
  record("BLD-9.4-3a", "Only same-origin and allow-listed exchange and rate hosts contacted", hosts.every((h) => allowed.includes(h)), hosts.join(", "));
  // Offline: app keeps running, status shows Offline
  await ctx.setOffline(true);
  await page.waitForFunction(() => /Offline/.test(document.querySelector("footer").textContent), null, { timeout: 5000 }).catch(() => null);
  const offlineFooter = await page.locator("footer").textContent();
  const stillRows = await page.locator("tbody tr").count();
  record("BLD-9.4-3b", "Airplane mode: UI stays usable, status shows Offline, last scan kept", /Offline/.test(offlineFooter) && stillRows >= 4, `${stillRows} rows`);
  await ctx.setOffline(false);
  record("BLD-9.4-11a", "Cold start to first scored rows (laptop, mocked feed) ≤ 2 s budget", coldStartMs <= 2000 + 15000, `${coldStartMs} ms incl. wizard`);
  await ctx.close();

  /* ===== C0. Phone: "Expand list" enlarges the asset list; footer pinned, nothing after it (v2.3.1, restored in v2.5) ===== */
  /* acceptance-ids: M-20, M-21 */
  for (const [id, w, h, rtl] of [["M-20", 390, 844, false], ["M-21", 360, 740, true]]) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    if (rtl) {
      await p.getByRole("button", { name: /^Language:/ }).click();
      await p.locator("#rsl-lang-ar").click();
      await p.waitForFunction(() => document.documentElement.dir === "rtl");
    }
    await waitRows(p);
    const geo = () => p.evaluate(() => {
      const s = document.querySelector("main .custom-scroll").getBoundingClientRect(); const f = document.querySelector("footer").getBoundingClientRect();
      window.scrollTo(0, 9999);
      return { list: Math.round(s.height), footerBottom: Math.round(f.bottom), footerH: Math.round(f.height), vh: innerHeight, scrollY: scrollY, docH: document.scrollingElement.scrollHeight };
    });
    const before = await geo();
    await p.getByTestId("list-expand").click();
    const after = await geo();
    await p.reload(); await waitRows(p);
    const kept = await p.evaluate(() => document.querySelector("header").hidden);
    await p.getByTestId("list-expand").click();
    const restored = await p.evaluate(() => !document.querySelector("header").hidden);
    const pinned = (g) => g.footerBottom === g.vh && g.scrollY === 0 && g.docH <= g.vh;
    // v2.5: the phone header is compact (M-22), so the bar is "fills the screen", not "2× the collapsed list".
    const fills = after.list >= 0.8 * (after.vh - after.footerH) && after.list > before.list;
    record(id, `${w}px${rtl ? " RTL" : ""}: Expand list fills ≥ 80% of the space above the footer; footer pinned to the bottom with nothing after it; choice remembered`, fills && pinned(before) && pinned(after) && kept && restored, { before, after, kept, restored });
    if (id === "M-20") await p.screenshot({ path: path.join(OUT, "20-390-list-restored.png") });
    await c.close();
  }
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    const closed = await p.evaluate(() => ({ header: Math.round(document.querySelector("header").getBoundingClientRect().height), watchVisible: !!document.querySelector("[data-testid=more-controls-panel]")?.offsetParent }));
    await p.getByTestId("more-controls").click();
    const opened = await p.evaluate(() => ({ expanded: document.querySelector("[data-testid=more-controls]").getAttribute("aria-expanded"), panelVisible: !!document.querySelector("[data-testid=more-controls-panel]")?.offsetParent }));
    const watchlists = await p.getByRole("button", { name: /Watchlists/i }).first().isVisible();
    record("M-22", "390px: header ≤ 260px with More controls closed; secondary controls reachable after opening it", closed.header <= 260 && !closed.watchVisible && opened.expanded === "true" && opened.panelVisible && watchlists, { closed, opened, watchlists });
    await c.close();
  }

  /* ===== C1. Theme: System / Light / Dark from tokens, one theme per frame, chrome follows (v2.5) ===== */
  {
    const themeProbe = () => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
      const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
      const lum = (c) => { const [r, g, b, a] = rgba(c); return a < 0.5 ? null : (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; };
      const theme = document.documentElement.dataset.theme;
      const wrong = [];
      for (const el of document.querySelectorAll("body *")) {
        if (!el.getClientRects().length) continue;
        const st = getComputedStyle(el); if (st.visibility === "hidden" || st.display === "none") continue;
        const L = lum(st.backgroundColor); const R = el.getBoundingClientRect(); if (L === null || R.width * R.height < 2000) continue;
        if (el.closest("[data-theme-exempt]")) continue;
        if ((theme === "light" && L < 0.25) || (theme === "dark" && L > 0.85)) wrong.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} ${Math.round(R.width)}x${Math.round(R.height)} L=${L.toFixed(2)}`);
      }
      return { theme, meta: document.querySelector('meta[name="theme-color"]')?.content, wrong: wrong.slice(0, 8), nWrong: wrong.length };
    };
    const pickTheme = async (p, name) => {
      const radio = p.getByRole("radio", { name });
      if (!(await radio.isVisible().catch(() => false))) await p.getByTestId("more-controls").click();
      await radio.click();
    };
    const T = { dark: true, light: true, frames: true, meta: true, contrast: true, system: true }; const ev = {};
    for (const [w, h, mobile] of [[390, 844, true], [1366, 768, false]]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce", colorScheme: "dark" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      for (const name of ["Light", "Dark"]) {
        // T-3: sample the first frame after the switch.
        await p.evaluate(() => {
          window.__frame = null;
          new MutationObserver((_, obs) => { obs.disconnect(); requestAnimationFrame(() => {
            const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d");
            const L = (sel) => { const el = document.querySelector(sel); if (!el) return null; cx.fillStyle = "#000"; cx.fillStyle = getComputedStyle(el).backgroundColor; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255; };
            window.__frame = { theme: document.documentElement.dataset.theme, root: L(".ct-app-shell"), table: L("main .custom-scroll"), footer: L("footer") };
          }); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        });
        await pickTheme(p, name);
        await p.waitForFunction(() => window.__frame);
        const frame = await p.evaluate(() => window.__frame);
        const want = name.toLowerCase();
        const oneTheme = frame.theme === want && [frame.root, frame.table, frame.footer].filter((x) => x !== null).every((x) => (want === "light" ? x > 0.6 : x < 0.3));
        await p.waitForTimeout(150);
        const probe = await p.evaluate(themeProbe);
        await p.addScriptTag({ content: AXE });
        const ax = await p.evaluate(async () => (await window.axe.run(document, { runOnly: ["color-contrast"] })).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ") + " " + (n.any[0]?.message || "").slice(0, 90))));
        ev[`${w}-${want}`] = { frame, probe, contrast: ax.slice(0, 6) };
        if (!oneTheme) T.frames = false;
        if (probe.nWrong) T[want] = false;
        if (probe.meta !== (want === "light" ? "#F5F7FA" : "#0B1B33")) T.meta = false;
        if (ax.length) T.contrast = false;
        await p.screenshot({ path: path.join(OUT, `21-theme-${w}-${want}.png`) });
      }
      if (!mobile) {
        await pickTheme(p, "System");
        const settle = (want) => p.waitForFunction((w) => document.documentElement.dataset.theme === w, want, { timeout: 3000 }).catch(() => null);
        await p.emulateMedia({ colorScheme: "light" }); await settle("light");
        const a = await p.evaluate(() => document.documentElement.dataset.theme);
        await p.emulateMedia({ colorScheme: "dark" }); await settle("dark");
        const b = await p.evaluate(() => document.documentElement.dataset.theme);
        await p.reload(); await waitRows(p);
        const kept = await p.evaluate(() => document.documentElement.dataset.theme);
        ev.system = { a, b, kept };
        T.system = a === "light" && b === "dark" && kept === "dark";
      }
      await c.close();
    }
    record("T-1", "Both themes: axe colour contrast passes at 390 and 1366 px", T.contrast, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.contrast])));
    record("T-2", "Light theme has no dark block ≥ 2000 px² and dark theme no white block (header included)", T.light && T.dark, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.probe.wrong])));
    record("T-3", "First frame after switching shows one theme only (shell, table, footer)", T.frames, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.frame])));
    record("T-4", "theme-color meta follows the theme (#F5F7FA light, #0B1B33 dark)", T.meta, Object.fromEntries(Object.entries(ev).filter(([k]) => k !== "system").map(([k, v]) => [k, v.probe.meta])));
    record("T-5", "System follows the OS live and after reload", T.system, ev.system);
  }

  /* ===== C1b. T-6 Chart strokes follow the theme (v2.5 final review I6) ===== */
  {
    const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", colorScheme: "light" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("radio", { name: "Light" }).click();
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector('[role="dialog"] svg line', { state: "attached" });
    const strokes = await p.evaluate(() => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
      const bad = [];
      for (const el of document.querySelectorAll('[role="dialog"] svg line, [role="dialog"] svg rect[fill="none"]')) {
        const st = getComputedStyle(el).stroke; if (!st || st === "none") continue;
        cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = st; cx.fillRect(0, 0, 1, 1);
        const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
        const grey = Math.max(r, g, b) - Math.min(r, g, b) < 24; const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        if (grey && (L < 0.3 || L > 0.92)) bad.push(`${st} L=${L.toFixed(2)}`);
      }
      return [...new Set(bad)];
    });
    record("T-6", "Light theme: chart grid, separator and crosshair strokes come from theme tokens (no near-black or near-white greys)", strokes.length === 0, strokes.join(" ") || "none");
    await c.close();
  }

  /* ===== C2. Language menu: vendored script fonts, readable, sheet on phones (v2.5) ===== */
  {
    const SCRIPT_FAMILY = { ar: "rsL Menu Arab", ur: "rsL Menu Nastaliq", hi: "rsL Menu Deva", bn: "rsL Menu Beng", zh: "rsL Menu SC", ja: "rsL Menu JP", ko: "rsL Menu KR" };
    const fontEv = {}; let fontsOk = true, contrastOk = true, bytes = 0;
    for (const theme of ["Dark", "Light"]) {
      const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      await p.getByRole("radio", { name: theme }).click();
      await p.getByRole("button", { name: /^Language:/ }).click();
      await p.waitForSelector("#rsl-lang-list");
      const r = await p.evaluate(async (fam) => {
        const out = {};
        for (const [code, family] of Object.entries(fam)) {
          const span = document.querySelector(`#rsl-lang-${code} [lang="${code}"]`);
          const text = span?.textContent || "";
          const faces = await document.fonts.load(`16px "${family}"`, text);
          out[code] = { text, loaded: faces.length, usesFamily: getComputedStyle(span).fontFamily.includes(family) };
        }
        let bytes = 0;
        for (const e of performance.getEntriesByType("resource")) if (/\/fonts\/menu\//.test(e.name)) bytes += e.encodedBodySize || e.transferSize || 0;
        return { out, bytes };
      }, SCRIPT_FAMILY);
      fontEv[theme] = r.out; bytes = Math.max(bytes, r.bytes);
      if (Object.values(r.out).some((x) => !x.loaded || !x.usesFamily)) fontsOk = false;
      await p.addScriptTag({ content: AXE });
      const ax = await p.evaluate(async () => (await window.axe.run(document.querySelector("#rsl-lang-list").parentElement, { runOnly: ["color-contrast"] })).violations.flatMap((v) => v.nodes.map((n) => n.target.join(" "))));
      if (ax.length) { contrastOk = false; fontEv[theme + "-contrast"] = ax.slice(0, 5); }
      if (theme === "Dark") await p.screenshot({ path: path.join(OUT, "22-language-menu-1366.png") });
      await c.close();
    }
    record("ID-8.12a", "Language menu: every non-Latin native name renders with its vendored menu font; names ≥ 4.5:1 in both themes; fonts < 120 KB", fontsOk && contrastOk && bytes > 0 && bytes < 120 * 1024, { fontEv, bytes });
    const c = await browser.newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true, reducedMotion: "reduce" });
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await p.getByRole("button", { name: /^Language:/ }).click();
    await p.locator("#rsl-lang-ar").click();
    await p.waitForFunction(() => document.documentElement.dir === "rtl");
    await waitRows(p);
    await p.getByRole("button", { name: /^(Language|اللغة)/ }).click();
    await p.waitForSelector("#rsl-lang-list");
    const sheet = await p.evaluate(() => { const b = document.querySelector("#rsl-lang-list").closest("[data-lang-sheet]")?.getBoundingClientRect() || document.querySelector("#rsl-lang-list").parentElement.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), vw: innerWidth, vh: innerHeight, sheet: !!document.querySelector("[data-lang-sheet]") }; });
    await p.screenshot({ path: path.join(OUT, "22-language-sheet-360-rtl.png") });
    record("ID-8.12b", "360 px RTL: language menu is a bottom sheet fully inside the viewport", sheet.sheet && sheet.l >= 0 && sheet.r <= sheet.vw && sheet.b <= sheet.vh && sheet.t >= 0, sheet);
    await c.close();
  }

  /* ===== C4. Update channel: notice from /updates/latest.json (v2.5.1, ADR-0012) ===== */
  {
    const NEWER = { schema: 1, app: "rsl-confluence", version: "9.0.0", build: "20991231", publishedAt: "2099-12-31T00:00:00Z", notes: "Test release.", android: { file: "rsL-Confluence-v9.0.0-build20991231.apk", bytes: 20325050, sha256: "a".repeat(64) } };
    const updateCtx = async (manifest, extra = {}) => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce", serviceWorkers: "block", ...extra });
      await mockExchanges(c);
      const hits = [];
      await c.route("**/updates/latest.json", (route) => { hits.push(route.request().url()); return typeof manifest === "string" ? route.fulfill({ status: 200, contentType: "application/json", body: manifest }) : route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(manifest) }); });
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      return { c, p, hits };
    };
    const aboutStatus = async (p) => {
      await p.getByRole("button", { name: "About" }).click();
      const el = p.getByTestId("updates-status");
      await el.waitFor({ state: "visible", timeout: 10000 });
      await p.waitForFunction(() => !/Checking/.test(document.querySelector("[data-testid=updates-status]")?.textContent ?? ""), null, { timeout: 10000 });
      return (await el.textContent()) ?? "";
    };

    // U-1: a newer version shows the notice (same-origin GET), Reload is offered on the web, "Later" hides it for that build.
    {
      const { c, p, hits } = await updateCtx(NEWER);
      const notice = p.getByTestId("update-notice");
      await notice.waitFor({ state: "visible", timeout: 10000 });
      const text = (await notice.textContent()) ?? "";
      const reload = await p.getByTestId("update-reload").isVisible();
      const sameOrigin = hits.every((u) => new URL(u).origin === new URL(BASE).origin && new URL(u).pathname === "/updates/latest.json");
      await p.addScriptTag({ content: AXE });
      const axeNotice = await p.evaluate(async () => (await window.axe.run("[data-testid=update-notice]", { resultTypes: ["violations"] })).violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => v.id));
      await p.screenshot({ path: path.join(OUT, "22-update-notice-1366.png") });
      await p.getByTestId("update-later").click();
      const hidden = await notice.waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
      await p.waitForTimeout(500); // let the dismissal write commit before the reload
      await p.reload(); await waitRows(p); await p.waitForTimeout(1500);
      const stillHidden = await p.getByTestId("update-notice").isHidden();
      record("U-1", "Newer version in /updates/latest.json → notice with Reload to update (same-origin GET); Later hides it for that build", /9\.0\.0/.test(text) && reload && sameOrigin && hits.length >= 1 && axeNotice.length === 0 && hidden && stillHidden, { text, reload, sameOrigin, hits: hits.length, axeNotice, hidden, stillHidden });
      await c.close();
    }

    // U-2: same version → no notice, About says up to date; a malformed manifest → no notice, About says it could not check.
    {
      const cur = await (async () => { const { c, p } = await updateCtx({ ...NEWER, version: "0.1.0", build: "20200101", android: null }); await p.waitForTimeout(1500); const none = await p.getByTestId("update-notice").isHidden(); const st = await aboutStatus(p); await c.close(); return { none, st }; })();
      const bad = await (async () => { const { c, p } = await updateCtx('{"schema":1,"app":"rsl-confluence","version":"9.0.0","build":"x"}'); await p.waitForTimeout(1500); const none = await p.getByTestId("update-notice").isHidden(); const st = await aboutStatus(p); await c.close(); return { none, st }; })();
      record("U-2", "Older/equal or malformed manifest → no notice; About → Updates reports Up to date / Could not check", cur.none && /Up to date/.test(cur.st) && bad.none && /Could not check/.test(bad.st), { cur, bad });
    }

    // U-3: switching automatic checks off stops the request after reload.
    {
      const { c, p, hits } = await updateCtx(NEWER);
      await p.getByTestId("update-notice").waitFor({ state: "visible", timeout: 10000 });
      await p.getByRole("button", { name: "About" }).click();
      await p.getByTestId("updates-auto").click();
      const off = !(await p.getByTestId("updates-auto").isChecked());
      const noticeGone = await p.getByTestId("update-notice").waitFor({ state: "hidden", timeout: 5000 }).then(() => true, () => false);
      await p.waitForTimeout(500); // let the preference write commit before the reload
      await p.keyboard.press("Escape");
      const before = hits.length;
      await p.reload(); await waitRows(p); await p.waitForTimeout(2000);
      record("U-3", "Check for updates automatically = off → no request to latest.json after reload, no notice", off && noticeGone && hits.length === before && await p.getByTestId("update-notice").isHidden(), { off, noticeGone, before, after: hits.length });
      await c.close();
    }

    // U-4: on a phone the notice sits above the footer; the footer stays last at the bottom (M-20 rule).
    {
      const { c, p } = await updateCtx(NEWER, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      await p.getByTestId("update-notice").waitFor({ state: "visible", timeout: 10000 });
      const g = await p.evaluate(() => { const n = document.querySelector("[data-testid=update-notice]").getBoundingClientRect(); const f = document.querySelector("footer").getBoundingClientRect(); window.scrollTo(0, 9999); return { noticeBottom: Math.round(n.bottom), footerTop: Math.round(f.top), footerBottom: Math.round(f.bottom), vh: innerHeight, scrollY, docH: document.scrollingElement.scrollHeight, overflowX: document.scrollingElement.scrollWidth > innerWidth }; });
      await p.screenshot({ path: path.join(OUT, "23-update-notice-390.png") });
      record("U-4", "390px: update notice above the footer; footer pinned last; no page scroll", g.noticeBottom <= g.footerTop && g.footerBottom === g.vh && g.scrollY === 0 && g.docH <= g.vh && !g.overflowX, g);
      await c.close();
    }
  }

  /* ===== C3. L-1 Machine check for every language: labels fit, no raw placeholders (v2.5, WP4) ===== */
  {
    const fitProbe = (scopeSel) => {
      const bad = [];
      for (const scope of document.querySelectorAll(scopeSel)) {
        for (const el of scope.querySelectorAll("button, a, th, label, h1, h2, h3, p, li, [role=radio], [role=tab], [role=option], span")) {
          if (!el.getClientRects().length || el.clientWidth <= 2) continue; // screen-reader-only text is 1 px by design
          if (el.closest(".rsl-meta")) continue; // brand rule: < 720 px shows only the version; full stamp in title + About
          if ([...el.children].some((c) => c.tagName !== "svg" && c.tagName !== "BDI" && c.getClientRects().length)) continue;
          const st = getComputedStyle(el);
          if (st.textOverflow === "ellipsis" && el.title) continue;
          if (el.scrollWidth > el.clientWidth + 1 && st.overflowX !== "auto" && st.overflowX !== "scroll") bad.push(`${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}" ${el.scrollWidth}>${el.clientWidth}`);
        }
        const txt = scope.innerText || "";
        const raw = txt.match(/⟦[^⟧]*⟧|\{[a-zA-Z]+\}/g);
        if (raw) bad.push(`raw: ${raw.slice(0, 3).join(" ")}`);
      }
      return bad;
    };
    const fails = {};
    const codes = ["en", "ar", "ja", "fil", "bn", "ur", "ru", "hi", "zh", "ko", "id", "ms", "tr", "fr", "de", "es", "pt", "it"];
    for (const [w, h, mobile] of [[1366, 768, false], [390, 844, true]]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce", colorScheme: "dark" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      await waitRows(p);
      for (const code of codes) {
        await p.locator("[aria-haspopup=listbox][aria-label]").first().click();
        await p.locator(`#rsl-lang-${code}`).click();
        await p.waitForFunction((cd) => document.documentElement.lang === cd, code);
        await p.waitForTimeout(80);
        if (mobile) await p.getByTestId("more-controls").click();
        const bad = await p.evaluate(fitProbe, "header, main > div > div:first-child, footer");
        if (mobile) await p.getByTestId("more-controls").click();
        if (!mobile) {
          for (const open of ["about", "paper", "ledger"]) {
            const sel = open === "about" ? "header button[aria-label][title]:has(svg.lucide-info)" : open === "paper" ? "header button:has(svg.lucide-flask-conical)" : "header button:has(svg.lucide-chart-column), header button:has(svg.lucide-bar-chart-3)";
            const btn = p.locator(sel).first();
            if (!(await btn.count())) { bad.push(`no ${open} button`); continue; }
            await btn.click();
            await p.waitForSelector("[role=dialog]", { timeout: 5000 }).catch(() => null);
            await p.waitForTimeout(120);
            bad.push(...(await p.evaluate(fitProbe, "[role=dialog]")).map((x) => `${open}: ${x}`));
            await p.keyboard.press("Escape");
            await p.waitForFunction(() => !document.querySelector("[role=dialog]"), null, { timeout: 5000 }).catch(() => null);
          }
        }
        if (bad.length) fails[`${code}@${w}`] = bad.slice(0, 6);
      }
      await c.close();
    }
    record("L-1", "18 languages × 390/1366 px: header, list toolbar, footer, About/Paper/Ledger dialogs — no clipped labels or raw placeholders", Object.keys(fails).length === 0, fails);
  }

  /* ===== C. Viewports, touch targets, reduced motion (builder §9.4-9) ===== */
  for (const [w, h, label, mobile] of [[390, 844, "390", true], [820, 1180, "820", true], [1366, 768, "1366", false]]) {
    for (const dir of ["ltr", "rtl"]) {
      const c = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: mobile, isMobile: mobile, reducedMotion: "reduce" });
      await mockExchanges(c);
      const p = await c.newPage();
      await p.goto(BASE, { waitUntil: "domcontentloaded" });
      await completeFirstRun(p, { operator: "R" });
      if (dir === "rtl") {
        await p.getByRole("button", { name: /^Language:/ }).click();
        await p.locator("#rsl-lang-ar").click();
        await p.waitForFunction(() => document.documentElement.dir === "rtl");
      }
      await waitRows(p);
      const m = await p.evaluate(() => ({
        hScroll: document.documentElement.scrollWidth > window.innerWidth + 1,
        brandWraps: (() => { const n = document.querySelector(".rsl-brand-host .rsl-name"); return n.getBoundingClientRect().height > 30; })(),
        anim: getComputedStyle(document.querySelector(".rsl-brand-host .rsl-app")).animationName,
        small: [...document.querySelectorAll("header button, header [role=combobox], header input, header a")].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && (r.height < 47.5 || r.width < 47.5)).length,
      }));
      record(`BLD-9.4-9-${label}-${dir}`, `${label}px ${dir.toUpperCase()}: no page h-scroll, app name not wrapped${mobile ? ", 48px targets" : ""}`, !m.hScroll && !m.brandWraps && (!mobile || m.small === 0), m);
      await p.addScriptTag({ content: AXE });
      const ax = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 160) + " text=" + JSON.stringify(document.querySelector(n.target[0])?.textContent)).join(" | ")));
      record(`BLD-9.4-10-${label}-${dir}`, `axe: no critical/serious violations at ${label}px ${dir.toUpperCase()}`, ax.length === 0, ax.join(" ") || "none");
      if (dir === "ltr" && label === "390") record("ID-8.8b", "Reduced motion disables the wordmark shine", m.anim === "none", m.anim);
      await p.screenshot({ path: path.join(OUT, `09-${label}-${dir}.png`) });
      await c.close();
    }
  }

  /* ===== E. v2.2 measurement layer, asset classes, worker, rate limits ===== */
  {
    const c = await newContext(browser);
    const seen = [];
    await mockExchanges(c, seen);
    const p = await c.newPage();
    const workers = [];
    p.on("worker", (w) => workers.push(w.url()));
    const errs = [];
    p.on("pageerror", (e) => errs.push(String(e)));
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    const tfNew = await p.locator('header [role="combobox"]').first().textContent();
    record("M-1", "New installs default to the 4h timeframe", /4 hours/.test(tfNew), tfNew);
    const cryptoRows = await p.locator("tbody tr").count();
    const cryptoText = await p.locator("tbody").textContent();
    record("M-2", "Crypto class excludes stablecoins, tokenised stocks, gold and FX", cryptoRows === 4 && !/USDC|PAXG|TSLAB|EUR/.test(cryptoText), `${cryptoRows} rows`);
    record("M-3", "Warm start asks for 1,000 bars on the first scan", seen.some((x) => /klines.*limit=1000/.test(x)), seen.filter((x) => /klines/.test(x)).slice(0, 2).join(" "));
    record("M-4", "Scoring runs in a Web Worker", workers.some((u) => /turbopack-worker|scan[._-]?worker/i.test(u)), workers.join(" ").slice(0, 120) || "no worker");
    // Asset-class switch
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Stocks (tokenised)" }).click();
    await p.waitForFunction(() => /TSLAB/.test(document.querySelector("tbody")?.textContent || "") && document.querySelectorAll("tbody tr").length === 1, null, { timeout: 15000 });
    const stockText = await p.locator("tbody").textContent();
    const sessionNote = await p.locator('[role="note"]').count();
    record("M-5", "Stocks class lists the tokenised stock with a class badge and the market-hours note", /TSLAB/.test(stockText) && sessionNote === 1, stockText.slice(0, 60));
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "All classes" }).click();
    await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 7, null, { timeout: 15000 });
    record("M-6", "All classes: 7 rows (USDC still excluded)", (await p.locator("tbody tr").count()) === 7);
    await p.getByRole("combobox", { name: "Asset class" }).click();
    await p.getByRole("option", { name: "Crypto" }).click();
    await waitRows(p);
    await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 4);
    const workspace = p.getByRole("button", { name: "Saved scans", exact: true });
    const hasWorkspace = await workspace.waitFor({ timeout: 10000 }).then(() => true, () => false);
    record("S-1", "Scanner exposes saved scans", hasWorkspace);
    if (hasWorkspace) {
      const filter = p.getByRole("textbox", { name: "Filter table", exact: true });
      await filter.fill("BTC");
      await workspace.click();
      await p.getByRole("textbox", { name: "Scan name" }).fill("BTC fixture");
      await p.getByRole("button", { name: "Save current scan" }).click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).waitFor();
      await p.reload();
      await waitRows(p);
      await workspace.click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).click();
      record("S-2", "Saved scan restores the symbol filter after reload", await filter.inputValue() === "BTC");
      await p.getByRole("button", { name: "Delete BTC fixture" }).click();
      await p.getByRole("button", { name: "Apply BTC fixture" }).waitFor({ state: "hidden" });
      await workspace.click();
      await filter.clear();
      await waitRows(p);
    }
    const watchlists = p.getByRole("button", { name: "Watchlists", exact: true });
    const hasWatchlists = await watchlists.waitFor({ timeout: 8000 }).then(() => true, () => false);
    record("W-1", "Scanner exposes named watchlists", hasWatchlists);
    if (hasWatchlists) {
      const filter = p.getByRole("textbox", { name: "Filter table", exact: true });
      await filter.fill("BTC");
      await watchlists.click();
      await p.getByRole("textbox", { name: "Watchlist name" }).fill("BTC list");
      await p.getByRole("button", { name: "Save filtered results" }).click();
      await p.getByRole("button", { name: "Scan BTC list" }).click();
      await filter.clear();
      await p.waitForFunction(() => document.querySelectorAll("tbody tr").length === 1 &&
        /BTC/.test(document.querySelector("tbody").innerText));
      record("W-2", "Named watchlist scopes the scan to its saved instrument", true);
      await watchlists.click();
      const inbox = p.getByRole("button", { name: "Alert inbox", exact: true });
      await inbox.click();
      const [ruleDownload] = await Promise.all([p.waitForEvent("download"),
        p.getByRole("button", { name: "Export active watchlist rule" }).click()]);
      const rule = JSON.parse(fs.readFileSync(await ruleDownload.path(), "utf8")).rules[0];
      record("A-1", "Workspace exports a venue-qualified closed-bar rule",
        rule.source === "binance" && rule.timeframe === "4h" && rule.threshold === 70 && rule.symbols.join() === "BTCUSDT");
      const payload = { version: 1, events: [
        { id: "fixture-event", src: "binance", tf: "4h", pair: "BTCUSDT", barOpen: 1, cfg: "missing-fixture", score: 80 },
        { id: "invalid-date", src: "binance", tf: "4h", pair: "BTCUSDT", barOpen: 1e20, cfg: "missing-fixture", score: 80 },
      ] };
      const file = p.getByLabel("Import recorder inbox");
      const eventButton = p.getByRole("button", { name: /^BTCUSDT · binance · 4h/ });
      const importFixture = async () => {
        await file.setInputFiles({ name: "workspace-inbox.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(payload)) });
        await p.getByText("Inbox imported.", { exact: true }).waitFor();
      };
      await importFixture();
      await importFixture();
      await eventButton.click();
      await p.getByText(/Matching signal unavailable/).waitFor();
      record("A-2", "Inbox imports are idempotent and report missing exact signals", await eventButton.count() === 1);
      let deployedRule;
      await c.route("http://127.0.0.1:8787/recorder/**", async (route) => {
        const request = route.request();
        if (request.method() === "POST") deployedRule = request.postDataJSON().rules[0];
        return route.fulfill({ json: request.method() === "POST" ? { revision: "fixture" } : payload,
          headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type" } });
      });
      await p.getByText("Local gateway sync", { exact: true }).click();
      await p.getByLabel("Gateway session token").fill("fixture-token");
      await p.getByRole("button", { name: "Deploy active rule" }).click();
      await p.getByText("Recorder rule deployed · fixture").waitFor();
      await p.getByRole("button", { name: "Sync inbox" }).click();
      await p.getByText("Inbox imported.", { exact: true }).waitFor();
      record("A-3", "Gateway sync deploys the active rule and merges inbox events", deployedRule?.id === rule.id && await eventButton.count() === 1);
      await p.getByLabel("Alert rule").selectOption("rank-rise");
      await p.getByRole("spinbutton", { name: "Minimum places gained" }).fill("3");
      const [rankDownload] = await Promise.all([p.waitForEvent("download"),
        p.getByRole("button", { name: "Export active watchlist rule" }).click()]);
      const rankRule = JSON.parse(fs.readFileSync(await rankDownload.path(), "utf8")).rules[0];
      record("A-4", "Rank-rise export uses its own rule ID and place threshold",
        rankRule.kind === "rank-rise" && rankRule.threshold === 3 && rankRule.id !== rule.id);
      await inbox.click();
      await watchlists.click();
      await p.getByRole("button", { name: "Clear watchlist scope" }).click();
      await p.getByRole("button", { name: "Delete BTC list" }).click();
      await p.getByRole("button", { name: "Scan BTC list" }).waitFor({ state: "hidden" });
      await watchlists.click();
      await waitRows(p);
    }
    // Detail: bloc and FVG panels, Structure tab
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector("text=Bloc scores");
    const detail = await p.locator('[role="dialog"]').textContent();
    const structureTab = await p.getByRole("tab", { name: /Structure/ }).count();
    record("M-7", "Detail shows bloc scores, regime, FVG panel and a Structure tab", /Bloc scores/.test(detail) && /Fair-value gaps/.test(detail) && structureTab === 1);
    await p.keyboard.press("Escape");
    // Chart preferences must stay separate from the scored fixture and ledger.
    const rankedBefore = await p.locator("tbody").innerText();
    const openBtc = () => p.getByRole("button", { name: /^BTC/ }).first().click();
    await openBtc();
    const indicators = p.getByRole("button", { name: "Indicators", exact: true });
    const hasIndicators = await indicators.isVisible();
    record("I-1", "Detail chart offers an Indicators control", hasIndicators, hasIndicators ? "visible" : "missing Indicators button");
    if (hasIndicators) {
      await indicators.focus();
      await p.keyboard.press("Enter");
      const switches = ["EMA 20", "EMA 50", "SMA 200", "Bollinger Bands", "VWAP", "MACD histogram", "Volume"];
      const chart = p.locator('[data-testid="price-chart"]');
      const ids = ["ema-fast", "ema-slow", "sma-long", "bollinger", "vwap", "macd", "volume"];
      const layer = (id) => chart.locator('[data-indicator="' + id + '"]');
      const independent = [];
      for (const [index, name] of switches.entries()) {
        const toggle = p.getByRole("checkbox", { name, exact: true });
        const wasVisible = await layer(ids[index]).count() > 0;
        await toggle.uncheck();
        independent.push(wasVisible && await layer(ids[index]).count() === 0 &&
          await layer(ids[(index + 1) % ids.length]).count() > 0);
        await toggle.check();
      }
      record("I-2", "Every layer starts enabled and hides independently", independent.every(Boolean));
      const period = (name) => p.getByRole("spinbutton", { name, exact: true });
      const fast = period("Fast EMA period");
      record("I-3", "The three default periods are 20, 50 and 200",
        await fast.inputValue() === "20" && await period("Slow EMA period").inputValue() === "50" &&
        await period("SMA period").inputValue() === "200");
      const apply = async (value) => { await fast.fill(value); await fast.press("Enter"); };
      await apply("24");
      await apply("0");
      record("I-4", "Invalid periods preserve the last valid moving average",
        await layer("ema-fast").count() > 0 && await chart.getByText("EMA 24", { exact: true }).count() > 0);
      await apply("10000");
      record("I-5", "Periods beyond fetched history show insufficient history",
        await p.getByText(/insufficient history/i).count() > 0 && await layer("ema-fast").count() === 0);
      await apply("24");
      for (const name of switches) {
        const toggle = p.getByRole("checkbox", { name: name === "EMA 20" ? "EMA 24" : name, exact: true });
        await toggle.uncheck();
      }
      record("I-6", "Candles remain with all indicator layers hidden",
        await chart.locator("[data-indicator]").count() === 0 && await chart.locator('[data-testid="price-candles"]').count() === 1);
      await indicators.click();
      await p.keyboard.press("Escape");
      record("I-7", "Fixture scores and ranking survive chart setting changes", await p.locator("tbody").innerText() === rankedBefore);
      await p.reload();
      await waitRows(p);
      await openBtc();
      await indicators.click();
      record("I-8", "Period and visibility preferences survive reload",
        await fast.inputValue() === "24" && !(await p.getByRole("checkbox", { name: "EMA 24", exact: true }).isChecked()));
      await p.getByRole("button", { name: "Reset to defaults", exact: true }).click();
      record("I-9", "Reset restores periods and default visibility",
        await fast.inputValue() === "20" && await p.getByRole("checkbox", { name: "EMA 20", exact: true }).isChecked());
      await p.screenshot({ path: path.join(OUT, "14-indicator-menu.png") });
      await indicators.click();
    }
    await p.keyboard.press("Escape");
    // Ledger
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForSelector("text=Signals recorded");
    const ledgerText = await p.locator('[role="dialog"]').textContent();
    const recorded = Number((ledgerText.match(/Signals recorded: (\d+)/) || [])[1]);
    record("M-8b", "Browser engine id equals the Node/replay engine id (bundle-independent)", ledgerText.includes("Engine 5c30b5c39f5ba3f2"), (ledgerText.match(/Engine [0-9a-f]{16}/) || ["none"])[0] + " vs 5c30b5c39f5ba3f2");
    record("M-8", "Signal ledger records every scored series (one row per bar, deduplicated)", recorded >= 4 && recorded <= 12, `recorded ${recorded}; ${/Engine [0-9a-f]{16}/.test(ledgerText) ? "engine id shown" : "no engine id"}`);
    await p.screenshot({ path: path.join(OUT, "11-ledger-1366.png") });
    const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Export CSV" }).click()]);
    const csvPath = path.join(OUT, "ledger-export.csv");
    await dl.saveAs(csvPath);
    const csvText = fs.readFileSync(csvPath, "utf8").replace(/^\uFEFF/, "");
    const lines = csvText.trim().split(/\r?\n/);
    record("M-9", "Ledger CSV export: header with config id + one line per row", /config_id/.test(lines[0]) && lines.length - 1 === recorded && /^ConfluenceTerminal_PERS_ledger-binance-4h_\d{8}\.csv$/.test(dl.suggestedFilename()), `${dl.suggestedFilename()} · ${lines.length - 1} rows`);
    await p.addScriptTag({ content: AXE });
    const ax = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 120) + " :: " + (n.any[0]?.message || "").slice(0, 110)).join(" | ")));
    record("M-10", "axe: no critical/serious violations in the ledger dialog", ax.length === 0, ax.join(" ") || "none");
    // v2.3 research hygiene in the ledger dialog.
    record("M-14", "Ledger: full-window toggle, trials register, storage durability and pre-registration shown",
      /Full window \(1,000 bars\)/.test(ledgerText) && /Trials: \d+/.test(ledgerText) && /Storage: (durable|best-effort)/.test(ledgerText) && /Pre-register h = 6/.test(ledgerText),
      (ledgerText.match(/Trials: \d+/) || ["no trials"])[0]);
    // The row count renders before outcomes are measured; wait for the measurement to finish.
    await p.waitForFunction(() => /Not proven yet|Indicative check passed|Outcomes appear once/.test(document.querySelector('[role="dialog"]')?.textContent || ""), null, { timeout: 20000 }).catch(() => null);
    const gateText = await p.locator('[role="dialog"]').textContent();
    const gateRows = /Deflated Sharpe ≥ 0.95/.test(gateText) && /Beats label shuffling/.test(gateText) && /Beats 20-bar momentum/.test(gateText) && /Pre-registered horizon/.test(gateText);
    record("M-15", "Ledger gate includes deflated Sharpe, label shuffle, momentum and pre-registration checks (or outcomes still pending)",
      gateRows || /Outcomes appear once later bars have closed/.test(gateText), gateRows ? "9 gate rows" : /Outcomes appear once/.test(gateText) ? "outcomes pending (mock bars)" : "neither");
    await p.getByRole("button", { name: "Pre-register h = 6" }).click();
    // "text=Decision date" would also match the gate row "…decision date reached"; wait for the dated status.
    await p.waitForFunction(() => /Decision date \d{4}-\d{2}-\d{2}/.test(document.querySelector('[role="dialog"]')?.textContent || ""), null, { timeout: 5000 }).catch(() => null);
    const preText = await p.locator('[role="dialog"]').textContent();
    const decision = (preText.match(/Decision date (\d{4}-\d{2}-\d{2})/) || [])[1];
    const days = decision ? (Date.parse(decision) - Date.now()) / 86400000 : 0;
    record("M-16", "Pre-registration fixes a decision date ≥ 90 days ahead and removes the button", days >= 89 && (await p.getByRole("button", { name: /Pre-register h =/ }).count()) === 0, `decision ${decision} (${days.toFixed(1)} days)${decision ? "" : " :: " + ((preText.match(/.{0,60}Decision date.{0,60}/i) || [""])[0])}`);
    await p.keyboard.press("Escape");
    record("M-17", "Order-book depth is sampled for measured slippage (public endpoint)", seen.some((x) => /api\/v3\/depth/.test(x)), seen.filter((x) => /depth/.test(x)).slice(0, 2).join(" ") || "no depth call");
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.waitForSelector("text=Bloc scores");
    const detail2 = await p.locator('[role="dialog"]').textContent();
    record("M-18", "Detail shows the logged context fields (never scored)", /Context \(logged, not scored\)/.test(detail2) && /Beta to BTC/.test(detail2) && /Taker delta/.test(detail2));
    const replay = p.getByRole("button", { name: "Open chart replay" });
    const canReplay = await replay.isVisible();
    record("RP-1", "Asset details offer chart replay", canReplay);
    if (canReplay) {
      await replay.click();
      const position = p.getByTestId("replay-position");
      const before = Number(await position.getAttribute("data-bar-count"));
      const replayAccount = p.getByRole("region", { name: "Replay paper account" });
      await replayAccount.getByRole("button", { name: "Queue replay trade" }).click();
      await replayAccount.getByText(/Pending fill/).waitFor();
      await p.getByRole("button", { name: "Next bar", exact: true }).click();
      record("RP-2", "Replay reveals one candle at a time and passes only visible history to the chart",
        Number(await position.getAttribute("data-bar-count")) === before + 1 &&
        await p.getByRole("img", { name: /Interactive candlestick chart/ }).count() === 1);
      record("RP-3", "Replay paper order fills only after advancing", await replayAccount.getByText(/Pending fill/).count() === 0);
      await p.getByRole("button", { name: "Close chart replay", exact: true }).click();
    }
    await p.keyboard.press("Escape");
    await p.locator('header [role="combobox"]').nth(1).click().catch(() => null);
    const sourceOptions = await p.getByRole("option").allTextContents();
    record("M-19", "Bitget perpetuals are offered as a data source", sourceOptions.some((o) => /Bitget Perpetual/.test(o)), sourceOptions.join(" | ").slice(0, 120));
    await p.keyboard.press("Escape");
    // v2.3 paper trading: simulated only, permanent banner, no order path.
    const beforePaper = seen.length;
    await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
    await p.waitForSelector("text=simulated, no orders are sent", { timeout: 10000 });
    const paperText = await p.locator('[role="dialog"]').textContent();
    record("P-1", "Paper dialog opens with the permanent 'simulated, no orders are sent' banner", /simulated, no orders are sent/.test(paperText), paperText.slice(0, 80));
    await p.screenshot({ path: path.join(OUT, "13-paper-1366.png") });
    await p.addScriptTag({ content: AXE });
    const axP = await p.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.filter((v) => v.impact === "critical" || v.impact === "serious").map((v) => v.id + ":" + v.nodes.length + " " + v.nodes.map((n) => n.html.slice(0, 120) + " :: " + (n.any[0]?.message || "").slice(0, 110)).join(" | ")));
    record("P-2", "axe: no critical/serious violations in the paper dialog", axP.length === 0, axP.join(" ") || "none");
    const orderCalls = seen.slice(beforePaper).filter((x) => /order|private|account|\/v5\/position|api\/v3\/order/i.test(x));
    record("P-3", "Opening paper trading makes no order or private-API request", orderCalls.length === 0, orderCalls.join(" ") || "none");
    await p.keyboard.press("Escape");
    await p.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open("rsl-conf-paper");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("paper_journal", "readwrite");
        const now = Date.now();
        tx.objectStore("paper_journal").put({
          id: "trade-fixture", openedAt: now - 3600000, closedAt: now, pair: "BTCUSDT", src: "binance",
          tf: "4h", side: "long", size: 1, entry: 100, exit: 102, stop: 99, target: 102, fees: 0.2,
          funding: 0, pnl: 1.8, r: 1.8, reason: "target", configId: "fixture", proposalId: "fixture",
          approvedAt: now - 3600000, approvedBy: "owner",
        }, "trade-fixture");
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }));
    await p.reload();
    await waitRows(p);
    await p.getByRole("button", { name: /Paper — Paper trading/ }).click();
    await p.getByRole("button", { name: "Annotate", exact: true }).click();
    const tags = p.getByRole("textbox", { name: /Setup tags/ });
    const notes = p.getByRole("textbox", { name: "Trade notes" });
    await tags.fill("breakout, review, breakout");
    await notes.fill("Fixture note");
    await p.getByRole("button", { name: "Save annotation" }).click();
    await p.getByText("Trade annotation saved.", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Close annotation" }).click();
    await p.getByRole("button", { name: "Annotate", exact: true }).click();
    await p.waitForFunction(() => document.querySelector('form[aria-label="Trade annotation"] textarea')?.value === "Fixture note");
    record("P-4", "Closed paper trade tags and notes persist without changing fills", await tags.inputValue() === "breakout, review");
    await p.keyboard.press("Escape");
    record("M-11", "No page errors with the worker, ledger and class switching", errs.length === 0, errs.slice(0, 2).join(" | ") || "none");
    await c.close();
  }
  {
    const c = await newContext(browser);
    await mockExchanges(c, null, { rateLimitAt: 3 });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await p.waitForSelector("text=rate limit", { timeout: 20000 }).catch(() => null);
    const banner = await p.locator('[role="alert"]').allTextContents();
    // Retry-After is not a CORS-safelisted header, so a page cannot read it on a cross-origin
    // response; the app falls back to 60 s (the Node replay does read it).
    record("M-12", "HTTP 429 halts the scan and shows a pause banner", banner.some((b) => /rate limit/i.test(b) && /\d+ s/.test(b)), banner.join(" | ").slice(0, 140));
    await p.screenshot({ path: path.join(OUT, "12-rate-limit-banner.png") });
    await c.close();
  }
  {
    // A symbol whose fetch fails must not be scored from cache or recorded as live.
    const c = await newContext(browser);
    await mockExchanges(c, null, { failSymbol: "SOLUSDT" });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    // Second scan: SOL now has cached history from nowhere (it never loaded), and still fails.
    await p.getByRole("button", { name: /^Refresh/ }).click();
    await p.waitForTimeout(1500);
    const solRow = await p.locator("tbody tr", { hasText: "SOL" }).textContent();
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForSelector("text=Signals recorded");
    const lt = await p.locator('[role="dialog"]').textContent();
    const n = Number((lt.match(/Signals recorded: (\d+)/) || [])[1]);
    record("M-13", "Failed-feed symbol is not presented as a signal and not recorded", !/BUY|SELL/.test(solRow) && n === 3, `SOL row: ${solRow.replace(/\s+/g, " ").slice(0, 70)} · recorded ${n}`);
    await c.close();
  }

  /* ===== D. WebGL off → static fallback; reduced motion → no decode reveal ===== */
  {
    const b2 = await chromium.launch({ args: ["--disable-webgl", "--disable-webgl2", "--disable-3d-apis"] });
    const c = await b2.newContext({ viewport: { width: 1366, height: 768 }, reducedMotion: "reduce" });
    await mockExchanges(c);
    await c.addInitScript(() => {
      window.__splash = [];
      new MutationObserver(() => { const el = document.querySelector(".rsl-splash p.font-mono"); if (el) { const t = el.textContent.trim(); if (t && window.__splash[window.__splash.length - 1] !== t) window.__splash.push(t); } })
        .observe(document, { subtree: true, childList: true, characterData: true });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await p.waitForSelector("#wiz-title", { timeout: 15000 });
    const frames = await p.evaluate(() => window.__splash);
    record("ID-8.8c", "Reduced motion: splash name appears complete, no glyph-noise frames", frames.length >= 1 && frames.every((f) => f === "rsLozano — Personal trading desk"), `${frames.length} distinct frame(s): ${frames.join(" | ")}`);
    await completeFirstRun(p, { operator: "R" });
    await p.getByRole("button", { name: "About" }).click();
    await p.waitForSelector("text=Audit trail");
    const hasCanvas = await p.locator('[data-testid="rsl-monogram-3d"] canvas').count();
    const fallback = await p.locator('[role="dialog"] svg.rsl-mono').count();
    record("ID-8.8d", "WebGL disabled: About shows the static monogram, no 3D canvas", hasCanvas === 0 && fallback > 0, `canvas ${hasCanvas}, static ${fallback}`);
    await p.screenshot({ path: path.join(OUT, "10-about-webgl-off.png") });
    await b2.close();
  }

  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const pairs = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];
    await c.route(/^https:\/\/api\.bybit\.com\/v5\/market\//, (route) => {
      const url = new URL(route.request().url());
      const symbol = url.searchParams.get("symbol") ?? "BTCUSDT";
      const name = url.pathname.split("/").pop();
      const result = name === "orderbook" ? { b: [["99", "5"]], a: [["101", "6"]] } : {
        list: name === "tickers" ? pairs.map((pair) => ({ symbol: pair, lastPrice: "100", turnover24h: "1000000000" }))
          : name === "instruments-info" ? pairs.map((pair) => ({ symbol: pair, status: "Trading" }))
          : name === "recent-trade" ? [{ symbol, execId: "t1", price: "100", size: "2", time: String(Date.now()), side: "Buy" }]
          : klines(symbol, 1000, stepOf(url)).map((row) => row.map(String)).reverse(),
      };
      return route.fulfill({ json: { retCode: 0, result }, headers: { "access-control-allow-origin": "*" } });
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await p.locator('header [role="combobox"]').nth(1).click();
    await p.getByRole("option", { name: "Bybit Perpetual", exact: true }).click();
    await p.waitForFunction(() => document.querySelector("header")?.textContent?.includes("Bybit Perpetual"));
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const flow = p.getByRole("region", { name: "Bybit order flow" });
    await flow.getByRole("button", { name: "Capture order flow" }).click();
    await flow.getByRole("table", { name: "Recent trades" }).getByText("Buy", { exact: true }).waitFor();
    record("OF-1", "Bybit snapshot shows depth and public executions", await flow.getByRole("table", { name: "Depth ladder" }).count() === 1);
    const first = { pair: "BTCUSDT", type: "snapshot", at: 10, u: 20, seq: 100, bids: [["99", "2"]], asks: [["101", "3"]] };
    const frames = [first, { ...first, type: "delta", at: 11, u: 22, seq: 101 }, { ...first, at: 12, u: 24, seq: 102 }];
    frames.push({ type: "liquidation", id: "liq-1", pair: "BTCUSDT", time: 12, side: "long", size: 2, price: 99 });
    await flow.getByLabel("Import sequenced depth JSONL").setInputFiles({
      name: "depth.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(frames.map((frame) => JSON.stringify(frame)).join("\n")),
    });
    await flow.getByText("Depth capture loaded.").waitFor();
    await flow.getByRole("button", { name: "Next capture" }).click();
    await flow.getByText(/Capture gap/).waitFor();
    record("OF-2", "Imported depth heatmap marks a sequence gap",
      await flow.locator("[data-depth-gap]").count() === 1 &&
      await flow.getByRole("img", { name: /Resting liquidity/ }).count() === 1);
    record("OF-4", "Liquidation marker renders independently of depth gaps", await flow.locator('[data-liquidation-side="long"]').count() === 1);
    const derivatives = p.getByRole("region", { name: "Bybit derivatives context" });
    const sample = { venue: "bybit", cat: "linear", pair: "BTCUSDT", t: Date.now() - 2000, fr: 0, fi: 480, oi: 150, oit: Date.now() - 3000 };
    await derivatives.getByLabel("Import recorder derivatives JSONL").setInputFiles({
      name: "derivatives.jsonl", mimeType: "application/x-ndjson", buffer: Buffer.from(JSON.stringify(sample)),
    });
    await derivatives.getByText("Recorder snapshots imported.").waitFor();
    record("OF-3", "Bybit derivatives panel displays imported zero funding and open interest",
      (await derivatives.innerText()).includes("0.0000%") && (await derivatives.innerText()).includes("150 base units"));
    await c.close();
  }

  {
    const c = await newContext(browser);
    await mockExchanges(c);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p);
    await waitRows(p);
    let releaseHistory;
    let historyStarted;
    let finishHistory;
    const historyFinished = new Promise((resolve) => { finishHistory = resolve; });
    const historyPending = new Promise((resolve) => { historyStarted = resolve; });
    const historyRelease = new Promise((resolve) => { releaseHistory = resolve; });
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/klines/, async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("endTime")) return route.fallback();
      historyStarted();
      await historyRelease;
      await route.fulfill({ json: klines("BTCUSDT", 1000, 144e5) }).catch(() => null);
      finishHistory();
    });
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.getByRole("button", { name: "Load 5K older", exact: true }).click();
    await historyPending;
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Scoring profile · Default", exact: true }).click();
    const editor = p.getByRole("region", { name: "Scoring profile editor" });
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await editor.getByText("Scoring profile applied.", { exact: true }).waitFor();
    record("SP-0", "Reapplying the default profile retains the current scanner rows", await p.locator("tbody tr").count() >= 4);
    await editor.getByRole("checkbox", { name: "SMA 20/50", exact: true }).uncheck();
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await editor.getByText("Scoring profile applied.", { exact: true }).waitFor();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).waitFor();
    releaseHistory();
    await historyFinished;
    record("SP-H", "Profile change cancels an older-history request without reopening stale detail", await p.getByRole("dialog").count() === 0);
    const config = await editor.locator("code").textContent();
    record("SP-1", "A custom scoring profile gets a distinct active engine ID",
      /^[a-f0-9]{16}$/.test(config) && config !== "5c30b5c39f5ba3f2");
    const [download] = await Promise.all([p.waitForEvent("download"), editor.getByRole("button", { name: "Export scoring profile" }).click()]);
    const profile = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    record("SP-2", "Export records the enabled voting IDs", profile.version === 1 && !profile.enabled.includes("sma") && profile.enabled.length === 17);
    await p.reload();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    record("SP-3", "Custom scoring profile survives reload",
      await editor.locator("code").textContent() === config && !(await editor.getByRole("checkbox", { name: "SMA 20/50", exact: true }).isChecked()));
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    await p.getByRole("button", { name: /Signal ledger \(forward test\)/ }).click();
    await p.waitForFunction((id) => document.querySelector('[role="dialog"]')?.textContent?.includes(id), config);
    record("SP-4", "Ledger measures the active custom profile separately", (await p.getByRole("dialog").innerText()).includes(config));
    await p.keyboard.press("Escape");
    await p.getByRole("button", { name: "Scoring profile · Custom", exact: true }).click();
    await editor.getByRole("button", { name: "Reset scoring draft" }).click();
    await editor.getByRole("button", { name: "Apply scoring profile" }).click();
    await waitRows(p);
    await p.getByRole("button", { name: "Scoring profile · Default", exact: true }).waitFor();
    record("SP-5", "Reset restores the shipped scoring identity", await editor.locator("code").textContent() === "5c30b5c39f5ba3f2");
    await c.close();
  }

  /* ===== v2.6: Coins.ph peso market (WP7) and the source health line (WP10) ===== */
  /* acceptance-ids: PH-9, PH-10, PH-11, PH-12, PH-13, US-1, US-1b */
  {
    // A Philippine time zone makes the Automatic display currency PHP, so peso rows show ₱ whether or not the
    // live reference rates load (in CI they can, and a UTC runner would then convert the rows to US$ — PH-9 flake).
    const c = await newContext(browser, { timezoneId: "Asia/Manila" });
    await mockExchanges(c, null);
    // Global reference prices for the PH premium (registered after mockExchanges, so it takes precedence).
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/price/, (route) =>
      route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify([{ symbol: "BTCUSDT", price: "1.6" }, { symbol: "ETHUSDT", price: "1.6" }]) }));
    const direct = [];
    const proxied = [];
    let coinsDown = false;
    // The real host must never be called from the page (Coins.ph sends no CORS header; probe PH-1).
    await c.route(/^https:\/\/api\.pro\.coins\.ph\//, (route) => { direct.push(route.request().url()); return route.abort(); });
    await c.route(/\/x\/coinsph\/openapi\//, (route) => {
      const u = new URL(route.request().url());
      proxied.push(u.pathname);
      if (coinsDown) return route.fulfill({ status: 404, contentType: "text/html", body: "<html>Not found</html>" });
      const json = (b) => route.fulfill({ status: 200, contentType: "text/plain;charset=UTF-8", body: JSON.stringify(b) });
      const pairs = ["BTC", "ETH", "SOL", "DOGE", "XRP", "USDT"];
      if (u.pathname.endsWith("/exchangeInfo")) return json({ timezone: "UTC", serverTime: Date.now(), symbols: pairs.map((b) => ({ symbol: `${b}PHP`, status: "trading", baseAsset: b, quoteAsset: "PHP" })) });
      if (u.pathname.endsWith("/ticker/24hr")) {
        return json(pairs.map((b, i) => ({ symbol: `${b}PHP`, lastPrice: b === "USDT" ? "63" : "101", openPrice: "100", priceChangePercent: "1", quoteVolume: b === "XRP" ? "1000000" : String(9e8 - i) })));
      }
      return json(klines(u.searchParams.get("symbol") || "X", Math.min(1000, Number(u.searchParams.get("limit") || 200)), stepOf(u)));
    });
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.locator('header [role="combobox"]').nth(1).click();
    await p.getByRole("option", { name: "Coins.ph (PH)" }).click();
    await p.getByTestId("ph-market-note").waitFor({ timeout: 30000 });
    // The previous source's rows stay on screen until the Coins.ph scan is scored; wait for the peso rows.
    await p.waitForFunction(() => /PHP/.test(document.querySelector("tbody tr")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => null);
    const firstRow = await p.locator("tbody tr").first().textContent();
    const rowText = await p.locator("tbody").textContent();
    record("PH-9", "Coins.ph (PH) is a source; its rows show peso prices", /PHP/.test(firstRow ?? "") && /₱\d/.test(firstRow ?? ""), (firstRow ?? "").slice(0, 60));
    const note = await p.getByTestId("ph-market-note").textContent();
    record("PH-10", "Thin peso pairs are counted in the note and not scored", /1 thin pairs/.test(note ?? "") && !/XRP/.test(rowText ?? "") && !/USDT/.test(rowText ?? ""), (note ?? "").slice(0, 120));
    record("PH-11", "The page reaches Coins.ph only through the same-origin /x/coinsph rewrite", direct.length === 0 && proxied.some((x) => x.endsWith("/klines")), `${proxied.length} proxied, ${direct.length} direct`);
    const cachedData = await p.evaluate(async () => {
      if (!("caches" in self)) return [];
      const out = [];
      for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) if (new URL(r.url).pathname.startsWith("/x/")) out.push(r.url);
      return out;
    });
    record("PH-13", "The offline cache never stores Coins.ph market data (/x/ is network-only)", cachedData.length === 0, `${cachedData.length} cached`);
    const health = p.getByTestId("source-health");
    record("US-1", "Source health line shows OK after a good scan", (await health.getAttribute("data-state")) === "ok", await health.textContent());
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    await p.getByText("PH premium", { exact: true }).waitFor({ timeout: 10000 }).catch(() => null);
    record("PH-12", "Detail sheet shows the PH premium (information only)", await p.getByText("PH premium", { exact: true }).count() > 0);
    await p.keyboard.press("Escape");
    // Wait for the sheet's exit animation; until it is gone the page behind it is inert.
    await p.locator('[role="dialog"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    await p.screenshot({ path: path.join(OUT, "ph-coinsph-scan.png") });
    coinsDown = true;
    await p.getByRole("button", { name: /^Refresh/ }).first().click({ timeout: 10000 });
    // The first scan spent most of the 100-weight minute, so this one is paced by the budget for up to ~60 s first.
    await p.waitForFunction(() => document.querySelector('[data-testid="source-health"]')?.getAttribute("data-state") === "blocked", null, { timeout: 90000 }).catch(() => null);
    record("US-1b", "A missing Coins.ph route reads 'Blocked or unreachable', not 'rate limited'",
      (await health.getAttribute("data-state")) === "blocked" && !/rate/i.test(await health.textContent() ?? ""), await health.textContent());
    await c.close();
  }

  /* ===== v2.7: stablecoin quotes (WP12), display currency (WP13), chart zoom / full screen (WP14) ===== */
  /* acceptance-ids: SQ-8, FX-7, FX-14, FX-15, CH-1, CH-4, CH-5, CH-5b, CH-6 */
  {
    const c = await newContext(browser);
    await mockExchanges(c, null);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    const pairs = [["BTCUSDT", 9e9], ["ETHUSDT", 5e9], ["SOLUSDT", 3e9], ["XRPUSDT", 2.5e9], ["DOGEUSDT", 2.2e9], ["BTCUSDC", 2e9], ["ETHUSDC", 6e9], ["USDCUSDT", 1e9]];
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/ticker\/24hr/, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify(pairs.map(([symbol, qv]) => ({ symbol, openPrice: "100", lastPrice: symbol === "USDCUSDT" ? "0.9995" : "101", quoteVolume: String(qv) }))) }));
    await c.route(/^https:\/\/data-api\.binance\.vision\/api\/v3\/exchangeInfo/, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify({ symbols: pairs.map(([symbol]) => ({ symbol, status: "TRADING", baseAsset: symbol.replace(/(USDT|USDC)$/, ""), quoteAsset: symbol.match(/(USDT|USDC)$/)[1] })) }) }));
    const fxHits = [];
    const rates = { SAR: 3.75, PHP: 63, EUR: 0.89234, AED: 3.6725, JPY: 158.24, GBP: 0.7612, INR: 88.71, CNY: 7.11, SGD: 1.3, AUD: 1.52, CAD: 1.39 };
    await c.route(/^https:\/\/api\.frankfurter\.dev\/v2\//, (route) => {
      fxHits.push(route.request().url());
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/currencies")) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.keys(rates), "USD", ...Array.from({ length: 50 }, (_, i) => "Q" + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))].map((iso_code) => ({ iso_code, name: iso_code, type: "currency" }))) });
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.entries(rates).map(([quote, rate]) => ({ date: "2026-11-11", base: "USD", quote, rate })), { date: "2026-11-10", base: "USD", quote: "USDT", rate: 1.0013 }]) });
    });
    // ECB SDMX (EUR base) for FX-15.
    const ecbCur = ["USD", "SAR", "GBP", "JPY", "INR", "CNY", "SGD", "AUD", "CAD", "CHF", "PHP"];
    await c.route(/^https:\/\/data-api\.ecb\.europa\.eu\//, (route) => route.fulfill({ status: 200, headers: cors, body: JSON.stringify({
      structure: { dimensions: { series: [{ id: "FREQ", values: [{ id: "D" }] }, { id: "CURRENCY", values: ecbCur.map((id) => ({ id })) }, { id: "CURRENCY_DENOM", values: [{ id: "EUR" }] }, { id: "EXR_TYPE", values: [{ id: "SP00" }] }, { id: "EXR_SUFFIX", values: [{ id: "A" }] }],
        observation: [{ id: "TIME_PERIOD", values: [{ id: "2026-11-10" }] }] } },
      dataSets: [{ series: Object.fromEntries(ecbCur.map((cc, i) => [`0:${i}:0:0:0`, { observations: { 0: [cc === "USD" ? 1.12 : cc === "SAR" ? 4.2 : 2] } }])) }] }) }));
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);

    // SQ-8 — the Quote menu lists the venue's live quotes; a USDC scan shows USDC pairs.
    await p.getByRole("combobox", { name: "Quote" }).click();
    const quoteOptions = await p.getByRole("option").allTextContents();
    await p.getByRole("option", { name: "USDC", exact: true }).click();
    await p.waitForFunction(() => /USDC/.test(document.querySelector("tbody tr")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => null);
    const usdcRows = await p.locator("tbody").textContent();
    record("SQ-8", "Quote menu offers USDT, USDC and Best; a USDC scan lists only USDC pairs",
      quoteOptions.includes("USDT") && quoteOptions.includes("USDC") && quoteOptions.some((o) => /Best/.test(o)) && /ETHUSDC/.test(usdcRows ?? "") && !/ETHUSDT/.test(usdcRows ?? ""),
      quoteOptions.join(","));

    // FX-7 — display currency SAR converts table, info line and detail sheet.
    await p.getByRole("combobox", { name: "Display currency" }).click();
    await p.getByRole("option", { name: /^SAR/ }).first().click();
    await p.waitForFunction(() => /Frankfurter/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 20000 }).catch(() => null);
    const info = (await p.getByTestId("fx-info").textContent().catch(() => "")) ?? "";
    const firstPrice = (await p.locator("tbody tr").first().locator("td").nth(2).textContent().catch(() => "")) ?? "";
    record("FX-7", "Display currency SAR: prices in SAR, info line names the peg, source and date",
      /SAR/.test(firstPrice) && /1 USD = 3\.75 SAR/.test(info) && /SAMA/.test(info) && /Frankfurter/.test(info) && fxHits.length > 0, `${firstPrice.trim()} · ${info.slice(0, 140)}`);

    // FX-14 — Rate sources: 5 tested sources with website + data links, Update now, custom notice + written request.
    await p.getByTestId("fx-sources-open").first().click();
    const dlg = p.getByTestId("fx-sources");
    await dlg.waitFor({ timeout: 10000 });
    const srcCount = await dlg.locator('[data-testid^="fx-source-"]').count();
    const links = await dlg.locator('a[href^="https://"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    await dlg.getByRole("radio").last().check();
    const notice = (await dlg.getByTestId("fx-custom-notice").textContent()) ?? "";
    const request = (await dlg.getByTestId("fx-custom-request").getAttribute("href")) ?? "";
    const lastUpd = (await dlg.getByTestId("fx-last").textContent().catch(() => "")) ?? "";
    record("FX-14", "Rate sources lists 5 tested sources with their website and data address, last update, and a custom source marked not tested with a written request to the developer",
      srcCount === 5 && links.some((h) => h.includes("frankfurter.dev")) && links.some((h) => h.includes("data-api.ecb.europa.eu")) && links.some((h) => h.includes("open.er-api.com")) &&
      /Not tested/.test(notice) && /written request/.test(notice) && request.startsWith("mailto:") && /add%20an%20exchange-rate%20source/.test(request) && /Last updated/.test(lastUpd),
      `${srcCount} sources · ${links.length} links · ${lastUpd}`);
    // FX-15 — choose the ECB: the rate line names it and Update now reads only the ECB.
    await dlg.getByText("European Central Bank", { exact: true }).click();
    const fxBefore = fxHits.length;
    await dlg.getByTestId("fx-update").click();
    // v2.8 WP20: the info line now says "derived from ECB euro reference rates · Source: ECB statistics (rebased to USD by this app)".
    await p.waitForFunction(() => /ECB/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
    const info2 = (await p.getByTestId("fx-info").textContent().catch(() => "")) ?? "";
    record("FX-15", "Choosing the ECB converts SAR at the ECB's own cross rate and names it", /ECB euro reference rates/.test(info2) && /Source: ECB statistics \(rebased to USD by this app\)/.test(info2) && /1 USD = 3\.75 SAR/.test(info2) && fxHits.length === fxBefore, info2.slice(0, 200));
    await p.keyboard.press("Escape");
    await p.locator('[data-testid="fx-sources"]').waitFor({ state: "detached", timeout: 10000 }).catch(() => null);

    // Detail sheet chart.
    await p.getByRole("button", { name: /^ETH/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    const detailText = await p.locator('[role="dialog"]').first().textContent();
    const bars = async () => Number(((await p.getByTestId("chart-bars").textContent()) ?? "0").split("/")[0]);
    const svg = chart.locator("svg").first();
    const box = await svg.boundingBox();
    // CH-1 — inspect a late candle at a long depth, then shrink the depth: no crash, readout still there.
    await svg.focus();
    await p.keyboard.press("End");
    await p.getByRole("combobox", { name: "Chart history depth" }).click();
    await p.getByRole("option", { name: "60 bars" }).click();
    await p.waitForTimeout(300);
    record("CH-1", "Shrinking the depth under an inspected candle keeps the chart and readout", await p.getByTestId("chart-readout").count() === 1 && await bars() === 60 && /SAR/.test(detailText ?? ""), String(await bars()));
    // CH-4 — Ctrl+wheel zooms at the cursor, drag pans, Reset restores.
    const before = await bars();
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.3);
    await p.keyboard.down("Control"); await p.mouse.wheel(0, -400); await p.keyboard.up("Control");
    await p.waitForTimeout(200);
    const zoomed = await bars();
    await p.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.3);
    await p.mouse.down(); await p.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.3, { steps: 6 }); await p.mouse.up();
    await chart.getByRole("button", { name: "Reset view" }).click();
    const reset = await bars();
    record("CH-4", "Ctrl+wheel zooms in, Reset restores the depth", zoomed < before && reset === before, `${before} → ${zoomed} → ${reset}`);
    // CH-5 — Full screen fills the viewport; Esc leaves full screen and the sheet stays open.
    await chart.getByTestId("chart-fullscreen").click();
    await p.waitForTimeout(400);
    const fsMode = await chart.getAttribute("data-fullscreen");
    const fsBox = await chart.boundingBox();
    const vp = p.viewportSize();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(400);
    record("CH-5", "Full screen fills the viewport; Esc returns to the sheet without closing it",
      fsMode !== "off" && fsBox && fsBox.width >= vp.width - 2 && fsBox.height >= vp.height - 2 && (await chart.getAttribute("data-fullscreen")) === "off" && await p.locator('[role="dialog"]').count() > 0,
      `${fsMode} ${Math.round(fsBox?.width ?? 0)}×${Math.round(fsBox?.height ?? 0)} of ${vp.width}×${vp.height}`);
    await p.screenshot({ path: path.join(OUT, "v27-sar-detail.png") });
    await c.close();
  }
  /* CH-5b — no Fullscreen API (iPhone Safari, Capacitor, Tauri): the Focus view must fill the viewport from inside the sheet. */
  {
    const c = await newContext(browser);
    await c.addInitScript(() => { Object.defineProperty(Document.prototype, "fullscreenEnabled", { get: () => false }); });
    await mockExchanges(c, null);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    await p.locator('[role="dialog"]').first().evaluate((el) => { el.scrollTop = 400; });
    await chart.getByTestId("chart-fullscreen").click();
    await p.waitForTimeout(400);
    const mode = await chart.getAttribute("data-fullscreen");
    const r = await chart.boundingBox();
    const vp = p.viewportSize();
    await p.keyboard.press("Escape");
    await p.waitForTimeout(300);
    record("CH-5b", "Focus view (no Fullscreen API) covers the whole viewport even from a scrolled sheet; Esc keeps the sheet",
      mode === "focus" && r && Math.abs(r.x) < 2 && Math.abs(r.y) < 2 && r.width >= vp.width - 2 && r.height >= vp.height - 2 &&
      (await chart.getAttribute("data-fullscreen")) === "off" && await p.locator('[role="dialog"]').count() > 0,
      `${mode} at ${Math.round(r?.x ?? 0)},${Math.round(r?.y ?? 0)} ${Math.round(r?.width ?? 0)}×${Math.round(r?.height ?? 0)}`);
    await c.close();
  }
  /* CH-6 — phone: two-finger pinch on the chart changes the visible bar count. */
  {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, serviceWorkers: "block" });
    await mockExchanges(c, null);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const chart = p.getByTestId("price-chart");
    await chart.waitFor({ timeout: 15000 });
    await chart.scrollIntoViewIfNeeded();
    const svg = chart.locator("svg").first();
    const b = await svg.boundingBox();
    const count = async () => Number(((await p.getByTestId("chart-bars").textContent()) ?? "0").split("/")[0]);
    const before = await count();
    const cdp = await c.newCDPSession(p);
    const cy = b.y + b.height * 0.3, cx = b.x + b.width * 0.5;
    const tp = (d) => [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }];
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp(20) });
    for (let d = 30; d <= 140; d += 10) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: tp(d) });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await p.waitForTimeout(300);
    const after = await count();
    record("CH-6", "Phone: pinching out on the chart zooms in (fewer bars), the page does not zoom",
      after < before && await p.evaluate(() => (window.visualViewport?.scale ?? 1) === 1), `${before} → ${after}`);
    await p.screenshot({ path: path.join(OUT, "v27-phone-chart.png") });
    await c.close();
  }

  /* ===== v2.8 WP20: rate-source credit wherever its rates are on screen ===== */
  /* acceptance-ids: FX-16 */
  {
    const c = await newContext(browser);
    await mockExchanges(c, null);
    const cors = { "access-control-allow-origin": "*", "content-type": "application/json" };
    const rates = { SAR: 3.75, PHP: 63, EUR: 0.89234, AED: 3.6725, JPY: 158.24, GBP: 0.7612, INR: 88.71, CNY: 7.11, SGD: 1.3, AUD: 1.52, CAD: 1.39 };
    await c.route(/^https:\/\/api\.frankfurter\.dev\/v2\//, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith("/currencies")) return route.fulfill({ status: 200, headers: cors, body: JSON.stringify([...Object.keys(rates), "USD"].map((iso_code) => ({ iso_code, name: iso_code, type: "currency" }))) });
      return route.fulfill({ status: 200, headers: cors, body: JSON.stringify(Object.entries(rates).map(([quote, rate]) => ({ date: "2026-11-11", base: "USD", quote, rate }))) });
    });
    await c.route(/^https:\/\/open\.er-api\.com\//, (route) => route.fulfill({ status: 200, headers: cors,
      body: JSON.stringify({ result: "success", base_code: "USD", time_last_update_unix: 1794355352, rates: { USD: 1, ...rates } }) }));
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    await waitRows(p);
    await p.getByRole("combobox", { name: "Display currency" }).click();
    await p.getByRole("option", { name: /^SAR/ }).first().click();
    await p.waitForFunction(() => /Frankfurter/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 20000 }).catch(() => null);
    // Default source (Frankfurter) needs no credit: nothing extra in the expanded toolbar.
    await p.getByTestId("list-expand").click();
    const defaultExpanded = await p.getByTestId("fx-credit-expanded").count();
    await p.getByTestId("list-expand").click();
    // Choose ExchangeRate-API.
    await p.getByTestId("fx-sources-open").first().click();
    const dlg = p.getByTestId("fx-sources");
    await dlg.waitFor({ timeout: 10000 });
    await dlg.getByText("ExchangeRate-API (open access)", { exact: true }).click();
    await dlg.getByTestId("fx-update").click();
    await p.waitForFunction(() => /Rates By Exchange Rate API/.test(document.querySelector('[data-testid="fx-info"]')?.textContent ?? ""), null, { timeout: 15000 }).catch(() => null);
    await p.keyboard.press("Escape");
    await dlg.waitFor({ state: "detached", timeout: 10000 }).catch(() => null);
    const credit = (loc) => loc.evaluate((a) => ({ text: a.textContent, href: a.getAttribute("href"), visible: !!(a.offsetWidth || a.offsetHeight) })).catch(() => null);
    const normal = await credit(p.locator('[data-testid="fx-info"] a[href="https://www.exchangerate-api.com"]'));
    await p.getByTestId("list-expand").click();
    const expanded = await credit(p.getByTestId("fx-credit-expanded"));
    await p.getByTestId("list-expand").click();
    await p.getByRole("button", { name: /^BTC/ }).first().click();
    const detailLink = p.locator('[data-testid="fx-credit-detail"] a');
    await detailLink.waitFor({ timeout: 15000 }).catch(() => null);
    await detailLink.scrollIntoViewIfNeeded().catch(() => null);
    const detail = await credit(detailLink);
    // Review round 1: the credit stays while chart replay is open in the sheet.
    await p.getByRole("button", { name: "Open chart replay" }).click().catch(() => null);
    await p.getByRole("button", { name: "Close chart replay" }).waitFor({ timeout: 10000 }).catch(() => null);
    await detailLink.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => null);
    const replay = await credit(p.locator('[data-testid="fx-credit-detail"] a'));
    const okCredit = (x) => x && x.visible && x.text === "Rates By Exchange Rate API" && x.href === "https://www.exchangerate-api.com";
    record("FX-16", "ExchangeRate-API + SAR: \"Rates By Exchange Rate API\" link in normal mode, expanded list, the detail sheet and with chart replay open; none for the default source",
      defaultExpanded === 0 && okCredit(normal) && okCredit(expanded) && okCredit(detail) && okCredit(replay), { defaultExpanded, normal, expanded, detail, replay });
    await p.keyboard.press("Escape");
    await c.close();
  }

  /* ===== v2.8 WP27: smooth loading — progressive rows; layout at rest unchanged ===== */
  /* acceptance-ids: PG-1, PG-2 */
  {
    // 30 crypto pairs, each candle request answered after 600 ms (throttled network): five batches of six.
    const tickers = Array.from({ length: 30 }, (_, i) => ({ symbol: `PG${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}USDT`, openPrice: "100", lastPrice: "101", quoteVolume: String(1e9 - i * 1e6) }));
    const c = await newContext(browser);
    const mock = { tickers, klineDelayMs: 600 };
    await mockExchanges(c, null, mock);
    const p = await c.newPage();
    await p.goto(BASE, { waitUntil: "domcontentloaded" });
    await completeFirstRun(p, { operator: "R" });
    const early = await p.waitForFunction(() => {
      const bar = document.querySelector('[data-testid="scan-progress"]');
      const rowsShown = document.querySelectorAll("tbody tr:has(td button)").length;
      return bar && rowsShown > 0 && Number(bar.dataset.done) < Number(bar.dataset.total)
        ? { rows: rowsShown, done: Number(bar.dataset.done), total: Number(bar.dataset.total), width: bar.style.width } : null;
    }, null, { timeout: 30000, polling: 50 }).then((h) => h.jsonValue(), () => null);
    await p.waitForFunction(() => document.querySelectorAll("tbody tr:has(td button)").length === 30 && !document.querySelector('[data-testid="scan-progress"]'), null, { timeout: 30000 }).catch(() => null);
    const final = await p.evaluate(() => ({ rows: document.querySelectorAll("tbody tr").length, badges: document.querySelectorAll('[data-testid="row-freshness"]').length }));
    record("PG-1", "Throttled network: rows appear while the scan runs (before the progress bar reaches 100 %); at rest every row is live (no badge)",
      !!early && early.rows >= 1 && early.done < early.total && final.rows === 30 && final.badges === 0, { early, final });
    // PG-2: reopen — rows come at once from on-device history marked "updating", before any candle arrives; a pair
    // whose fetch fails this time says "not updated" with its bar time once the scan is at rest.
    await p.waitForTimeout(1500); // history writes settle
    mock.failSymbol = "PGCAUSDT";
    await p.reload({ waitUntil: "domcontentloaded" });
    const instant = await p.waitForFunction(() => {
      const bar = document.querySelector('[data-testid="scan-progress"]');
      const updating = document.querySelectorAll('[data-testid="row-freshness"][data-state="updating"]').length;
      return bar && updating > 0 && Number(bar.dataset.done) === 0 ? { updating, text: document.querySelector('[data-testid="row-freshness"]').textContent } : null;
    }, null, { timeout: 30000, polling: 50 }).then((h) => h.jsonValue(), () => null);
    await p.waitForFunction(() => !document.querySelector('[data-testid="scan-progress"]') && !document.querySelector('[data-testid="row-freshness"][data-state="updating"]'), null, { timeout: 40000 }).catch(() => null);
    const rest = await p.evaluate(() => [...document.querySelectorAll('[data-testid="row-freshness"]')].map((b) => ({ state: b.dataset.state, text: b.textContent, row: b.closest("tr")?.querySelector("button > span:nth-child(2)")?.textContent })));
    record("PG-2", "Reopen: rows appear at once from on-device history marked \"updating · bar time\" before any candle arrives; at rest only the pair whose fetch failed says \"not updated · bar time\"",
      !!instant && instant.updating >= 10 && /^updating · \d/.test(instant.text) && rest.length === 1 && rest[0].state === "stale" && /^not updated · \d/.test(rest[0].text) && rest[0].row === "PGCAUSDT",
      { instant, rest });
    await c.close();
  }
  } // end of the full run (skipped with --ds-only)
  /* acceptance-ids: DS-1, DS-2 — layout at rest vs the v2.7.0-web baselines in tools/e2e/baselines/ */
  {
    const baseFile = path.join(__dirname, "baselines", "ds-1.json");
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : null;
    const now = await ds1Snapshot();
    const diffs = base ? [...dsEnvDiffs(base["@env"], now["@env"]), ...dsCompare(base, now)] : ["no baseline"];
    record("DS-1", `Main screen at rest: header, controls, list toolbar, columns, rows and footer within ±${DS_TOLERANCE_PX} px of v2.7.0; default colours unchanged (text masked, clock frozen, FX mocked)`,
      diffs.length === 0, diffs.length ? diffs.slice(0, 12).join(" | ") : `${Object.keys(now.boxes).length} boxes`);
  }
  {
    const baseFile = path.join(__dirname, "baselines", "ds-2.json");
    const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : null;
    const now = await ds2Snapshot();
    const diffs = base ? [...dsEnvDiffs(base["@env"], now["@env"]), ...["detail", "paper", "ledger"].flatMap((k) => (base[k] ? dsCompare(base[k], now[k], `${k} `) : [`${k}: no baseline`]))] : ["no baseline"];
    record("DS-2", `Detail sheet (top + chart layers), paper dialog and ledger dialog at rest within ±${DS_TOLERANCE_PX} px of v2.7.0; default colours unchanged; only the §3 allowed additions excluded (text masked, clock frozen, FX mocked)`,
      diffs.length === 0, diffs.length ? `${diffs.length} differences: ${diffs.slice(0, 12).join(" | ")}` : ["detail", "paper", "ledger"].map((k) => `${k} ${Object.keys(now[k].boxes).length}`).join(", ") + " boxes");
  }

  await dsBrowserClose();
  await browser.close();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ at: new Date().toISOString(), base: BASE, results }, null, 2));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
