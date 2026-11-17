// WP28 Task 2: backup payload, restore plan and store methods.
// Run: npm run test:backup-payload   (node scripts/run-engine-tests.mjs backup-payload.test.mjs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { sealBackup, openBackup, readBackupHeader, BackupError } from "./backup-crypto.ts";
import { buildPayload, parsePayload, PAYLOAD_FORMAT, PAYLOAD_SCHEMA, PAYLOAD_LIMITS } from "./backup-payload.ts";
import { createBackupFile, openBackupFile, applyRestore } from "./backup-service.ts";
import { createLedgerStore, sanitizePreregistration, sanitizeTrial, PREREG_MIN_DAYS } from "./signal-ledger.ts";
import { createPaperStore, memoryPaperPort, sanitizeJournalEntry } from "./paper-store.ts";
import { newBook } from "./paper-broker.ts";
import { sanitizeLedgerRow } from "./ledger-metrics.ts";
import { normalizePreferences } from "./preferences-store.ts";

const PASS = "correct horse battery staple";
const H = 3600e3;
const DAY = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const NOW = Date.now();
const BAR0 = Math.floor(NOW / (4 * H)) * (4 * H); // newest 4 h bar open at or before now

/* ---- fixtures ---- */
const baseRow = {
  cfg: "c1", ev: "1", app: "t", src: "binance", tf: "4h", ac: "crypto", rec: 0, sc: 0, m: 0, st: 0, sup: 0, lv: 0, v: 18, bu: 0, be: 0,
  er: null, bl: [0, 0, 0, 0], rk: 1, qv: 1, rd: 0, rc: 0, wb: 1000, live: 1,
};
/** A fully populated live row (rad, ft, vt, scb, scp) that the sanitiser accepts unchanged. */
function mkRow(pair, t, i = 0, over = {}) {
  const raw = {
    ...baseRow, id: `c1|binance|4h|${pair}|${t}`, pair, t, tc: t + 4 * H, rec: t + 4 * H, c: 100 + (i % 50), sc: (i % 101) - 50, m: 1, st: 1,
    ft: -37.3, vt: 12345, pd: 1, pc: 2, fr: 0.0001, oiChg: 1.5,
    rad: { t: t + 4 * H - 300_000, frp: 82.5, oi24: -3.25, ls: 1.8, tk: 0.54, usP: 0.12, krP: -1.4, phP: 0.9, al: ["BREAKAWAY_KR"] },
    scb: [-0.1, -0.05, 0.05, 0.1], scp: { s: 1, p: [0.5, 0.3, 0.2], b: [0.4, 0.4, 0.2], w: 1.2, f: 0 },
    ...over,
  };
  const row = sanitizeLedgerRow(raw);
  assert.ok(row, "fixture row must pass the sanitiser");
  return row;
}
/** pairs × bars rows, newest bar at BAR0 - startBar * 4h going back. */
function mkRows(pairs, bars, startBar = 0) {
  const out = [];
  let i = 0;
  for (let b = 0; b < bars; b++) for (let p = 0; p < pairs; p++) out.push(mkRow(`P${p}`, BAR0 - (startBar + b) * 4 * H, i++));
  return out;
}
function mkJournal(i, closedAt, over = {}) {
  return {
    id: `paper:${i}`, openedAt: closedAt - 5 * H, closedAt, pair: "SOLUSDT", src: "binance", tf: "4h", side: "long", size: 12.5, entry: 100, exit: 104,
    stop: 96, target: 108, fees: 1.2, funding: 0, pnl: 48.8, r: 0.976, reason: "target", configId: "c1", proposalId: `prop-${i}`,
    approvedAt: closedAt - 6 * H, approvedBy: "owner", mae: -0.2, mfe: 1.1, preReason: "breakout above range", tag: "breakout", notes: "ok", ...over,
  };
}
const mkPrereg = (over = {}) => {
  const startedAt = NOW - 10 * DAY;
  return { cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full", hypothesis: "momentum persists", horizon: 6, startedAt, decisionDate: startedAt + 90 * DAY, minDays: 90, ...over };
};
const mkTrial = (n) => ({ id: `app-${n.toString(16).padStart(8, "0")}`, cfg: "c1", variant: `variant-${n}`, at: NOW - n * 1000, note: n % 2 ? "n" : undefined });

function device(kind = "sqlite", clock = NOW) {
  const ledgerPort = { ...memoryPaperPort(), kind };
  const paperPort = { ...memoryPaperPort(), kind };
  const prefsPort = memoryPaperPort();
  const log = [];
  const dev = {
    ledgerPort, paperPort, prefsPort, log, clock,
    ledger: createLedgerStore(ledgerPort),
    paper: createPaperStore(paperPort),
  };
  dev.deps = {
    ledger: dev.ledger, paper: dev.paper,
    prefs: { get: (c, i) => prefsPort.get(c, i), put: (c, i, d) => prefsPort.put(c, i, d) },
    audit: {
      async append(e) { log.push({ ...e, at: new Date(dev.clock).toISOString() }); return e; },
      async entries(o) { return log.filter((e) => !o?.record || e.record === o.record); },
    },
    actorId: "owner-test", app: "2.8.0", now: () => dev.clock,
  };
  return dev;
}
async function snap(dev) {
  const out = {};
  for (const [name, port, cols] of [
    ["ledger", dev.ledgerPort, ["ledger", "ledger_meta"]],
    ["paper", dev.paperPort, ["paper_state", "paper_positions", "paper_journal"]],
    ["prefs", dev.prefsPort, ["preferences"]],
  ]) {
    for (const c of cols) out[`${name}/${c}`] = (await port.list(c)).sort((a, b) => a.id.localeCompare(b.id));
  }
  out.audit = dev.log;
  return JSON.stringify(out);
}
const byId = (a, b) => a.id.localeCompare(b.id);
const emptyParts = (createdAt) => ({
  createdAt, app: "2.8.0", settings: { preferences: null, scoringProfile: null }, ledger: { rows: [] },
  research: { preregistrations: [], trials: [] }, paper: { journal: [] },
});
async function fileOf(parts, createdAt = parts.createdAt) {
  return sealBackup(buildPayload(parts), PASS, { createdAt, app: "2.8.0" });
}
async function rejectsWith(p, code) {
  try { await p; } catch (e) {
    assert.ok(e instanceof BackupError, `expected BackupError, got ${e}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

/* ---- tests ---- */
test("round trip restores every record into an empty device", async () => {
  const A = device();
  await A.ledger.restoreRows(mkRows(4, 50));
  await A.paper.importJournal([mkJournal(1, NOW - 2 * DAY), mkJournal(2, NOW - DAY, { side: "short", tag: undefined, notes: undefined, mae: undefined })]);
  await A.ledger.preregister({ cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full", hypothesis: "h", horizon: 6 });
  await A.ledger.registerTrial("c1", "variant-a", "note");
  await A.ledger.registerTrial("c1", "variant-b");
  const prefs = normalizePreferences({ autoRefresh: false, timeframe: "1h" });
  const profile = { version: 1, enabled: ["macd", "rsi"] };
  await A.prefsPort.put("preferences", "current", prefs);
  await A.prefsPort.put("preferences", "scoring-profile-v1", profile);

  const made = await createBackupFile(A.deps, PASS);
  assert.match(made.name, /^confluence-backup-\d{8}T\d{6}Z\.json$/);
  assert.equal(made.counts.rows, 200);
  assert.equal(made.counts.journal, 2);

  const B = device();
  const plan = await openBackupFile(made.text, PASS, B.deps);
  assert.equal(plan.ledger.added, 200);
  const report = await applyRestore(plan, { settings: true }, B.deps);
  assert.equal(report.ledger.added, 200);
  assert.equal(report.settings, true);

  assert.deepEqual(await B.ledger.all(), await A.ledger.all());
  const noId = (list) => list.map(({ id: _id, ...rest }) => rest).sort((a, b) => a.closedAt - b.closedAt);
  assert.deepEqual(noId((await B.paper.load(1)).journal), noId((await A.paper.load(1)).journal));
  assert.deepEqual((await B.ledger.preregistrations()).sort((a, b) => a.startedAt - b.startedAt), (await A.ledger.preregistrations()).sort((a, b) => a.startedAt - b.startedAt));
  assert.deepEqual((await B.ledger.trials()).sort(byId), (await A.ledger.trials()).sort(byId));
  assert.deepEqual(await B.prefsPort.get("preferences", "current"), prefs);
  assert.deepEqual(await B.prefsPort.get("preferences", "scoring-profile-v1"), profile);
});

test("restored ledger rows pass the existing sanitiser", async () => {
  const A = device();
  await A.ledger.restoreRows(mkRows(3, 10));
  const made = await createBackupFile(A.deps, PASS);
  const plan = await openBackupFile(made.text, PASS, device().deps);
  assert.equal(plan.parsed.payload.ledger.rows.length, 30);
  for (const row of plan.parsed.payload.ledger.rows) assert.deepEqual(row, sanitizeLedgerRow(row));
});

test("no scored row is silently dropped", async () => {
  const rows = mkRows(4, 150); // 600 rows over 25 days
  const broken = { ...mkRow("BRK", BAR0 - 4 * H, 0), sc: "x" };
  const replay = mkRow("RPL", BAR0 - 8 * H, 0, { live: 0 });
  const file = await fileOf({ ...emptyParts(NOW), ledger: { rows: [...rows, broken, replay] } });

  const B = device("localstorage");
  const cutoff = dayOf(NOW - 14 * DAY);
  const isOld = (r) => dayOf(r.t) < cutoff;
  const fresh = rows.filter((r) => !isOld(r));
  const existing = fresh.slice(0, 50);
  assert.equal((await B.ledger.restoreRows(existing)).added, 50);

  const plan = await openBackupFile(file, PASS, B.deps);
  const tooOld = rows.filter(isOld).length;
  assert.ok(tooOld > 0 && tooOld < 600);
  assert.equal(plan.ledger.inFile, 602);
  assert.equal(plan.ledger.rejected, 2);
  assert.equal(plan.ledger.duplicates, 50);
  assert.equal(plan.ledger.tooOld, tooOld);
  assert.equal(plan.ledger.added, 600 - 50 - tooOld);
  assert.equal(plan.ledger.capDropped, 0);
  const sum = plan.ledger.added + plan.ledger.duplicates + plan.ledger.tooOld + plan.ledger.rejected;
  assert.equal(sum, 602);

  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.deepEqual(report.ledger, plan.ledger);
  const stored = (await B.ledger.all()).map((r) => r.id).sort();
  assert.deepEqual(stored, fresh.map((r) => r.id).sort());
  assert.ok(B.log.at(-1).reason.includes(`${plan.ledger.tooOld} too old`) && B.log.at(-1).reason.includes("2 unreadable"));
});

test("row cap removals are reported", async () => {
  const B = device("localstorage");
  // Oldest retained day holds exactly 90 rows; 4,900 more sit on newer days (70 pairs x 70 bars).
  const oldest = Date.parse(dayOf(NOW - 13 * DAY) + "T00:00:00Z");
  const first = Array.from({ length: 90 }, (_, i) => mkRow(`O${i}`, oldest, i));
  const rest = mkRows(70, 70, 1);
  const seed = await B.ledger.restoreRows([...first, ...rest]);
  assert.equal(seed.added, 4990);
  assert.equal((await B.ledger.stats()).rows, 4990);

  const incoming = Array.from({ length: 100 }, (_, i) => mkRow(`N${i}`, BAR0, i));
  const file = await fileOf({ ...emptyParts(NOW), ledger: { rows: incoming } });
  const plan = await openBackupFile(file, PASS, B.deps);
  assert.equal(plan.ledger.added, 100);
  assert.equal(plan.ledger.capDropped, 90);
  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.equal(report.ledger.capDropped, 90);
  assert.equal((await B.ledger.stats()).rows, 5000);
  assert.ok(B.log.at(-1).reason.includes("90 removed by the row cap"));
});

test("schema-invalid file is rejected without side effects", async () => {
  const good = emptyParts(NOW);
  const cases = {
    "schema 2": async () => sealBackup(JSON.stringify({ ...JSON.parse(buildPayload(good)), schema: 2 }), PASS, { createdAt: NOW, app: "2.8.0" }),
    "wrong format": async () => sealBackup(JSON.stringify({ ...JSON.parse(buildPayload(good)), format: "other" }), PASS, { createdAt: NOW, app: "2.8.0" }),
    "rows not an array": async () => sealBackup(JSON.stringify({ ...JSON.parse(buildPayload(good)), ledger: { rows: {} } }), PASS, { createdAt: NOW, app: "2.8.0" }),
    "paper is a string": async () => sealBackup(JSON.stringify({ ...JSON.parse(buildPayload(good)), paper: "x" }), PASS, { createdAt: NOW, app: "2.8.0" }),
    "createdAt differs from header": async () => sealBackup(buildPayload({ ...good, createdAt: NOW + 1 }), PASS, { createdAt: NOW, app: "2.8.0" }),
    "501 pre-registrations": async () => fileOf({ ...good, research: { preregistrations: Array.from({ length: 501 }, (_, i) => mkPrereg({ cfg: `c${i}` })), trials: [] } }),
    "invalid scoring profile": async () => fileOf({ ...good, settings: { preferences: null, scoringProfile: { version: 1, enabled: ["rsi", "nope"] } } }),
  };
  const B = device();
  await B.ledger.restoreRows(mkRows(2, 3));
  await B.paper.save(newBook(NOW));
  await B.prefsPort.put("preferences", "current", normalizePreferences({}));
  const before = await snap(B);
  for (const [name, make] of Object.entries(cases)) {
    await rejectsWith(openBackupFile(await make(), PASS, B.deps), "schema");
    assert.equal(await snap(B), before, `${name}: nothing changed`);
  }
  // rows above the limit (limit lowered in a direct parse call)
  const text = buildPayload({ ...good, ledger: { rows: mkRows(1, 2) } });
  const header = readBackupHeader(await fileOf(good));
  assert.throws(() => parsePayload(text, header, { ...PAYLOAD_LIMITS, rows: 1 }), (e) => e instanceof BackupError && e.code === "schema");
  assert.throws(() => parsePayload("not json", header), (e) => e instanceof BackupError && e.code === "format");
  assert.equal(PAYLOAD_FORMAT, "rsl-confluence-backup-payload");
  assert.equal(PAYLOAD_SCHEMA, 1);
  assert.deepEqual(PAYLOAD_LIMITS, { rows: 1_000_000, preregistrations: 500, trials: 20_000, journal: 100_000 });
});

test("wrong passphrase and tampered file change nothing", async () => {
  const A = device();
  await A.ledger.restoreRows(mkRows(2, 3));
  const { text } = await createBackupFile(A.deps, PASS);
  const B = device();
  await B.ledger.restoreRows(mkRows(1, 1, 5));
  const before = await snap(B);
  await rejectsWith(openBackupFile(text, "another long passphrase", B.deps), "decrypt");
  const o = JSON.parse(text);
  const mid = Math.floor(o.ct.length / 2);
  o.ct = o.ct.slice(0, mid) + (o.ct[mid] === "A" ? "B" : "A") + o.ct.slice(mid + 1);
  await rejectsWith(openBackupFile(JSON.stringify(o), PASS, B.deps), "decrypt");
  assert.equal(await snap(B), before);
});

test("a pre-registration's decision date never moves", async () => {
  const A = device();
  const theirs = mkPrereg();
  await A.ledger.restorePreregistrations([theirs]);
  const { text } = await createBackupFile(A.deps, PASS);
  const B = device();
  const mine = await B.ledger.preregister({ cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full", hypothesis: "mine", horizon: 6 });
  assert.ok(mine.startedAt > theirs.startedAt);
  const plan = await openBackupFile(text, PASS, B.deps);
  assert.deepEqual(plan.preregistrations, { added: 0, kept: 1, rejected: 0 });
  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.deepEqual(report.preregistrations, { added: 0, kept: 1 });
  assert.deepEqual(await B.ledger.preregistrations(), [mine]);
});

test("newer local settings are flagged and replaced only on request", async () => {
  const A = device("sqlite", NOW - 2 * DAY);
  const theirs = normalizePreferences({ autoRefresh: false });
  await A.prefsPort.put("preferences", "current", theirs);
  await A.prefsPort.put("preferences", "scoring-profile-v1", { version: 1, enabled: ["macd", "rsi"] });
  const { text, createdAt } = await createBackupFile(A.deps, PASS);
  assert.equal(createdAt, NOW - 2 * DAY);

  const B = device();
  const mine = normalizePreferences({ autoRefresh: true, timeframe: "1h" });
  await B.prefsPort.put("preferences", "current", mine);
  B.log.push({ at: new Date(NOW).toISOString(), event: "preferences.update", record: "preferences", reason: "changed: timeframe" });
  const plan = await openBackupFile(text, PASS, B.deps);
  assert.equal(plan.settings.present, true);
  assert.equal(plan.settings.localNewer, true);
  assert.equal(plan.settings.localChangedAt, NOW);
  assert.equal(plan.header.createdAt, createdAt);

  const noSettings = await applyRestore(plan, { settings: false }, B.deps);
  assert.equal(noSettings.settings, false);
  assert.deepEqual(await B.prefsPort.get("preferences", "current"), mine);
  assert.equal(await B.prefsPort.get("preferences", "scoring-profile-v1"), null);

  const withSettings = await applyRestore(plan, { settings: true }, B.deps);
  assert.equal(withSettings.settings, true);
  assert.deepEqual(await B.prefsPort.get("preferences", "current"), theirs);
  assert.deepEqual(await B.prefsPort.get("preferences", "scoring-profile-v1"), { version: 1, enabled: ["macd", "rsi"] });

  const C = device(); // an older local change is not "newer"
  C.log.push({ at: new Date(NOW - 5 * DAY).toISOString(), event: "preferences.update", record: "preferences", reason: "x" });
  const planC = await openBackupFile(text, PASS, C.deps);
  assert.equal(planC.settings.localNewer, false);
  const D = device();
  assert.deepEqual((await openBackupFile(text, PASS, D.deps)).settings.localChangedAt, null);
});

test("newer local records are flagged and kept", async () => {
  const A = device("sqlite", NOW - 2 * DAY);
  await A.ledger.restoreRows(mkRows(2, 3, 20));
  await A.paper.importJournal([mkJournal(1, NOW - 5 * DAY)]);
  const { text } = await createBackupFile(A.deps, PASS);

  const none = await openBackupFile(text, PASS, device().deps);
  assert.equal(none.localNewerRecords, false);

  const B = device();
  const localRow = mkRow("LOC", BAR0, 1);
  await B.ledger.restoreRows([localRow]);
  await B.paper.importJournal([mkJournal(9, NOW - H, { proposalId: "prop-9" })]);
  assert.ok(await B.ledger.newestBarTime() > NOW - 2 * DAY);
  const plan = await openBackupFile(text, PASS, B.deps);
  assert.equal(plan.localNewerRecords, true);
  await applyRestore(plan, { settings: false }, B.deps);
  assert.ok((await B.ledger.all()).some((r) => r.id === localRow.id));
  assert.ok((await B.paper.load(NOW)).journal.some((j) => j.proposalId === "prop-9"));

  // only a newer journal trade (no newer bar)
  const E = device();
  await E.paper.importJournal([mkJournal(9, NOW - H)]);
  assert.equal((await openBackupFile(text, PASS, E.deps)).localNewerRecords, true);
});

test("the paper account is never touched", async () => {
  const A = device();
  await A.paper.importJournal([mkJournal(1, NOW - DAY)]);
  await A.ledger.restoreRows(mkRows(1, 2));
  const { text } = await createBackupFile(A.deps, PASS);
  const B = device();
  const book = newBook(NOW);
  book.account.drawdownLocked = true;
  await B.paper.save(book);
  await B.paperPort.put("paper_positions", "pos1", { id: "pos1", size: 2, approvedAt: 1, pair: "SOLUSDT" });
  const state = await B.paperPort.list("paper_state");
  const positions = await B.paperPort.list("paper_positions");
  const plan = await openBackupFile(text, PASS, B.deps);
  await applyRestore(plan, { settings: true }, B.deps);
  assert.deepEqual(await B.paperPort.list("paper_state"), state);
  assert.deepEqual(await B.paperPort.list("paper_positions"), positions);
  assert.equal((await B.paperPort.list("paper_journal")).length, 1);
  const payload = JSON.parse((await openBackup(text, PASS)).plain);
  assert.deepEqual(Object.keys(payload).sort(), ["app", "createdAt", "format", "ledger", "paper", "research", "schema", "settings"]);
  assert.deepEqual(Object.keys(payload.paper), ["journal"]);
});

test("nothing secret reaches the file or the audit", async () => {
  const A = device();
  await A.ledger.restoreRows(mkRows(2, 3));
  await A.paper.importJournal([mkJournal(1, NOW - DAY)]);
  await A.prefsPort.put("preferences", "current", { ...normalizePreferences({}), token: "abc", apiKey: "k" });
  const { text } = await createBackupFile(A.deps, PASS);
  const { plain } = await openBackup(text, PASS);
  for (const bad of [PASS, "token", "apiKey"]) assert.ok(!plain.includes(bad), `payload contains ${bad}`);
  const B = device();
  await applyRestore(await openBackupFile(text, PASS, B.deps), { settings: true }, B.deps);
  const entry = B.log.at(-1);
  assert.equal(entry.event, "backup.cloud.restore");
  assert.equal(entry.record, "backup");
  assert.equal(entry.actorId, "owner-test");
  for (const bad of [PASS, "token", "apiKey"]) assert.ok(!JSON.stringify(entry).includes(bad));
  assert.match(entry.reason, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z · 6 rows added, 0 already present, 0 too old, 0 unreadable, 0 removed by the row cap · 1 trades · 0 pre-registrations · settings yes$/);
});

test("rejected journal, pre-registration and trial items are counted", async () => {
  const parts = {
    ...emptyParts(NOW),
    research: { preregistrations: [mkPrereg(), mkPrereg({ cfg: "c2", minDays: 30 })], trials: [mkTrial(1), { ...mkTrial(2), id: "x" }, mkTrial(3)] },
    paper: { journal: [mkJournal(1, NOW - DAY), mkJournal(2, NOW - DAY, { side: "up" })] },
  };
  const B = device();
  const plan = await openBackupFile(await fileOf(parts), PASS, B.deps);
  assert.deepEqual(plan.parsed.rejected, { rows: 0, preregistrations: 1, trials: 1, journal: 1 });
  assert.deepEqual(plan.journal, { inFile: 2, added: 1, duplicates: 0, rejected: 1 });
  assert.deepEqual(plan.trials, { added: 2, rejected: 1 });
  assert.deepEqual(plan.preregistrations, { added: 1, kept: 0, rejected: 1 });
  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.deepEqual(report.journal, { added: 1, duplicates: 0 });
  assert.equal(report.trials, 2);
  // a second restore of the same file adds nothing
  const again = await applyRestore(await openBackupFile(await fileOf(parts), PASS, B.deps), { settings: false }, B.deps);
  assert.deepEqual(again.journal, { added: 0, duplicates: 1 });
  assert.equal(again.trials, 0);
  assert.deepEqual(again.preregistrations, { added: 0, kept: 1 });
});

test("sanitisers", () => {
  const j = mkJournal(1, NOW);
  const clean = sanitizeJournalEntry({ ...j, evil: "<script>", paperHack: 1 });
  assert.ok(clean && !("evil" in clean) && !("paperHack" in clean));
  assert.deepEqual(clean, j);
  assert.equal(sanitizeJournalEntry({ ...j, side: "up" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, approvedBy: "bot" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, preReason: "x".repeat(281) }), null);
  assert.ok(sanitizeJournalEntry({ ...j, preReason: "x".repeat(280) }));
  assert.equal(sanitizeJournalEntry({ ...j, pnl: Infinity }), null);
  assert.equal(sanitizeJournalEntry({ ...j, reason: "nuked" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, id: "bad id!" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, pair: "sol" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, tf: "4hh" }), null);
  assert.equal(sanitizeJournalEntry({ ...j, notes: "n".repeat(2001) }), null);
  assert.equal(sanitizeJournalEntry({ ...j, tag: "weird" }).tag, undefined);
  assert.equal(sanitizeJournalEntry(null), null);

  const p = mkPrereg();
  assert.deepEqual(sanitizePreregistration({ ...p, extra: 1 }), p);
  assert.equal(sanitizePreregistration({ ...p, minDays: 30, decisionDate: p.startedAt + 30 * DAY }), null);
  assert.equal(sanitizePreregistration({ ...p, decisionDate: p.decisionDate + 1 }), null);
  assert.equal(sanitizePreregistration({ ...p, horizon: 5 }), null);
  assert.equal(sanitizePreregistration({ ...p, hypothesis: "h".repeat(501) }), null);
  assert.equal(sanitizePreregistration({ ...p, cfg: "BAD" }), null);
  assert.equal(PREREG_MIN_DAYS, 90);

  const t = mkTrial(3);
  assert.deepEqual(sanitizeTrial({ ...t, extra: 1 }), t);
  assert.equal(sanitizeTrial({ ...t, id: "x" }), null);
  assert.equal(sanitizeTrial({ ...t, variant: "v".repeat(201) }), null);
  assert.equal(sanitizeTrial({ ...t, note: "n".repeat(501) }), null);
  assert.equal(sanitizeTrial({ ...t, at: NaN }), null);
});

test("restoreRows never writes in a dry run and reports the same counts", async () => {
  const B = device("localstorage");
  const rows = mkRows(3, 5);
  const before = await snap(B);
  const dry = await B.ledger.restoreRows(rows, { dryRun: true });
  assert.equal(await snap(B), before);
  const real = await B.ledger.restoreRows(rows);
  assert.deepEqual(real, dry);
  assert.deepEqual(await B.ledger.restoreRows(rows), { added: 0, duplicates: 15, tooOld: 0, capDropped: 0, agePrunedDays: 0 });
  assert.equal(await B.ledger.newestBarTime(), BAR0);
  assert.equal(await device().ledger.newestBarTime(), 0);
});

test("size: 100,000 rows backup under 20 MB and in reasonable time", async () => {
  const A = device();
  const rows = mkRows(100, 1000);
  assert.equal(rows.length, 100_000);
  const seeded = await A.ledger.restoreRows(rows);
  assert.equal(seeded.added, 100_000);
  const sample = JSON.stringify(rows[0]).length;
  assert.ok(sample > 500 && sample < 800, `row is ${sample} bytes`);
  const t0 = Date.now();
  const made = await createBackupFile(A.deps, PASS);
  const took = Date.now() - t0;
  assert.ok(made.bytes < 20 * 1024 * 1024, `bytes ${made.bytes}`);
  assert.ok(took < 30_000, `took ${took} ms`);
  assert.equal(made.counts.rows, 100_000);
});

/* ---- fix round 1 ---- */
const tradeEntry = (n, over = {}) => mkJournal(n, NOW - (10 - n) * H, { id: `trade-${n}`, proposalId: `prop-${n}`, ...over });
const putRaw = (dev, e) => dev.paperPort.put("paper_journal", e.id, e);
const ids = async (dev) => (await dev.paper.load(NOW)).journal.map((j) => j.id);

test("F1a restoring onto an empty device never costs a later local trade", async () => {
  const A = device();
  await putRaw(A, tradeEntry(1, { pair: "BTCUSDT" }));
  await putRaw(A, tradeEntry(2, { pair: "ETHUSDT" }));
  const { text } = await createBackupFile(A.deps, PASS);
  const B = device();
  const plan = await openBackupFile(text, PASS, B.deps);
  assert.deepEqual(plan.journal, { inFile: 2, added: 2, duplicates: 0, rejected: 0 });
  await applyRestore(plan, { settings: false }, B.deps);
  // B's own account now closes trades with the same per-account sequence ids
  const book = await B.paper.load(NOW);
  book.journal.push(tradeEntry(1, { pair: "SOLUSDT", proposalId: "local-1" }), tradeEntry(2, { pair: "XRPUSDT", proposalId: "local-2" }));
  await B.paper.save(book);
  const journal = (await B.paper.load(NOW)).journal;
  assert.equal(journal.length, 4);
  assert.deepEqual(journal.map((j) => j.pair).sort(), ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]);
  for (const j of journal) assert.ok(sanitizeJournalEntry(j), `${j.id} passes the id rule`);
  assert.ok(journal.filter((j) => j.id.startsWith("bk:")).length === 2);
});

test("F1b a device with its own trade-N ids loses nothing when another backup's trade-N ids arrive", async () => {
  const A = device();
  for (const n of [0, 1, 2]) await putRaw(A, tradeEntry(n, { pair: "BTCUSDT" }));
  const { text } = await createBackupFile(A.deps, PASS);
  const C = device();
  await putRaw(C, tradeEntry(0, { pair: "BTCUSDT" })); // the very same trade as the backup's trade-0
  await putRaw(C, tradeEntry(1, { pair: "XRPUSDT" })); // different trade, same id
  await putRaw(C, tradeEntry(2, { pair: "XRPUSDT" }));
  const plan = await openBackupFile(text, PASS, C.deps);
  assert.deepEqual(plan.journal, { inFile: 3, added: 2, duplicates: 1, rejected: 0 });
  const report = await applyRestore(plan, { settings: false }, C.deps);
  assert.deepEqual(report.journal, { added: 2, duplicates: 1 });
  const journal = (await C.paper.load(NOW)).journal;
  assert.equal(journal.length, 5);
  assert.deepEqual(journal.filter((j) => j.pair === "XRPUSDT").map((j) => j.id).sort(), ["trade-1", "trade-2"]);
  assert.equal(journal.filter((j) => j.pair === "BTCUSDT").length, 3);
});

test("F1c restoring the same backup twice adds nothing the second time", async () => {
  const A = device();
  await putRaw(A, tradeEntry(1, { pair: "BTCUSDT" }));
  await putRaw(A, tradeEntry(2, { pair: "ETHUSDT" }));
  const { text } = await createBackupFile(A.deps, PASS);
  const B = device();
  await putRaw(B, tradeEntry(1, { pair: "SOLUSDT", proposalId: "local-1" }));
  await applyRestore(await openBackupFile(text, PASS, B.deps), { settings: false }, B.deps);
  const before = await snap(B);
  const again = await openBackupFile(text, PASS, B.deps);
  assert.deepEqual(again.journal, { inFile: 2, added: 0, duplicates: 2, rejected: 0 });
  assert.equal(await snap(B), before, "the second plan wrote nothing");
  const report = await applyRestore(again, { settings: false }, B.deps);
  assert.deepEqual(report.journal, { added: 0, duplicates: 2 });
  assert.equal((await ids(B)).length, 3);
  // and restoring onto the device the backup came from adds nothing
  assert.deepEqual((await openBackupFile(text, PASS, A.deps)).journal, { inFile: 2, added: 0, duplicates: 2, rejected: 0 });
});

test("F2 the plan flags settings that differ from this device, with or without an audit entry", async () => {
  const profile = { version: 1, enabled: ["macd", "rsi"] };
  const A = device("sqlite", NOW - 2 * DAY);
  const prefs = normalizePreferences({ autoRefresh: false });
  await A.prefsPort.put("preferences", "current", prefs);
  await A.prefsPort.put("preferences", "scoring-profile-v1", profile);
  const { text } = await createBackupFile(A.deps, PASS);

  const same = device();
  await same.prefsPort.put("preferences", "current", prefs);
  await same.prefsPort.put("preferences", "scoring-profile-v1", profile);
  const p0 = await openBackupFile(text, PASS, same.deps);
  assert.deepEqual([p0.settings.differs, p0.settings.preferencesDiffer, p0.settings.profileDiffers, p0.settings.localNewer], [false, false, false, false]);

  const profileOnly = device(); // no audit entry exists for a profile change
  await profileOnly.prefsPort.put("preferences", "current", prefs);
  await profileOnly.prefsPort.put("preferences", "scoring-profile-v1", null);
  const p1 = await openBackupFile(text, PASS, profileOnly.deps);
  assert.deepEqual([p1.settings.differs, p1.settings.preferencesDiffer, p1.settings.profileDiffers, p1.settings.localNewer], [true, false, true, false]);

  const prefsOnly = device();
  await prefsOnly.prefsPort.put("preferences", "current", normalizePreferences({ autoRefresh: true }));
  await prefsOnly.prefsPort.put("preferences", "scoring-profile-v1", profile);
  const p2 = await openBackupFile(text, PASS, prefsOnly.deps);
  assert.deepEqual([p2.settings.differs, p2.settings.preferencesDiffer, p2.settings.profileDiffers], [true, true, false]);

  const broken = device(); // an unreadable local profile counts as different
  await broken.prefsPort.put("preferences", "current", prefs);
  await broken.prefsPort.put("preferences", "scoring-profile-v1", { version: 9 });
  assert.equal((await openBackupFile(text, PASS, broken.deps)).settings.profileDiffers, true);

  // a backup with no settings never asks
  const none = await openBackupFile(await fileOf(emptyParts(NOW)), PASS, profileOnly.deps);
  assert.deepEqual([none.settings.present, none.settings.differs], [false, false]);
  // a null backup profile (all indicators) against a custom local one is a difference, and apply writes null
  const nullProfile = await fileOf({ ...emptyParts(NOW), settings: { preferences: prefs, scoringProfile: null } });
  const custom = device();
  await custom.prefsPort.put("preferences", "current", prefs);
  await custom.prefsPort.put("preferences", "scoring-profile-v1", profile);
  const p3 = await openBackupFile(nullProfile, PASS, custom.deps);
  assert.equal(p3.settings.profileDiffers, true);
  await applyRestore(p3, { settings: true }, custom.deps);
  assert.equal(await custom.prefsPort.get("preferences", "scoring-profile-v1"), null);
});

test("F3 the plan's row-cap number counts rows, not index units (a stored universe is 40 units)", async () => {
  const B = device("localstorage");
  const oldest = Date.parse(dayOf(NOW - 13 * DAY) + "T00:00:00Z");
  const first = Array.from({ length: 60 }, (_, i) => mkRow(`O${i}`, oldest, i)); // oldest day holds 60 rows
  const rest = mkRows(70, 69, 2).slice(0, 4800);
  assert.equal((await B.ledger.restoreRows([...first, ...rest])).added, 4860);
  assert.equal(await B.ledger.record([mkRow("U0", BAR0 - 4 * H, 0)], { t: BAR0 - 4 * H, list: [{ p: "BTCUSDT", qv: 1, ac: "crypto" }] }), 1);
  assert.equal((await B.ledger.stats()).rows, 4901); // 4,861 rows + 40 universe units
  const incoming = Array.from({ length: 100 }, (_, i) => mkRow(`N${i}`, BAR0, i));
  const plan = await openBackupFile(await fileOf({ ...emptyParts(NOW), ledger: { rows: incoming } }), PASS, B.deps);
  assert.equal(plan.ledger.capDropped, 60);
  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.deepEqual(report.ledger, plan.ledger);
  assert.equal(report.ledger.capDropped, 60);
});

test("F3b the reviewer's scenario: plan 400 equals applied 400, and age-pruned days are reported apart", async () => {
  const B = device("localstorage");
  const oldest = Date.parse(dayOf(NOW - 13 * DAY) + "T00:00:00Z");
  const first = Array.from({ length: 400 }, (_, i) => mkRow(`O${i}`, oldest, i));
  const rest = mkRows(70, 66, 1).slice(0, 4590);
  await B.ledger.restoreRows([...first, ...rest]);
  const incoming = Array.from({ length: 100 }, (_, i) => mkRow(`N${i}`, BAR0, i));
  const plan = await openBackupFile(await fileOf({ ...emptyParts(NOW), ledger: { rows: incoming } }), PASS, B.deps);
  assert.equal(plan.ledger.capDropped, 400);
  assert.equal(plan.ledger.agePrunedDays, 0);
  const report = await applyRestore(plan, { settings: false }, B.deps);
  assert.equal(report.ledger.capDropped, 400);
  assert.equal((await B.ledger.stats()).rows, 4690);
  // a stale local day (older than retention) is pruned by age and counted as days, not as cap rows
  const C = device("localstorage");
  await C.ledgerPort.put("ledger", "x", {});
  await C.ledgerPort.del("ledger", "x");
  const stale = Date.parse(dayOf(NOW - 20 * DAY) + "T00:00:00Z");
  const staleRow = mkRow("S0", stale, 0);
  await C.ledgerPort.put("ledger", `${dayOf(stale)}|binance|4h|c1|${stale}`, { schema: 2, day: dayOf(stale), src: "binance", tf: "4h", cfg: "c1", t: stale, rows: [staleRow] });
  await C.ledgerPort.put("ledger_meta", `day|${dayOf(stale)}`, { ids: [`${dayOf(stale)}|binance|4h|c1|${stale}`] });
  await C.ledgerPort.put("ledger_meta", "index", { schema: 2, days: { [dayOf(stale)]: 1 } });
  const p = await openBackupFile(await fileOf({ ...emptyParts(NOW), ledger: { rows: incoming.slice(0, 5) } }), PASS, C.deps);
  assert.equal(p.ledger.agePrunedDays, 1);
  assert.equal(p.ledger.capDropped, 0);
  assert.deepEqual((await applyRestore(p, { settings: false }, C.deps)).ledger, p.ledger);
});

test("F4 a successful open and plan writes nothing to any store", async () => {
  const A = device("sqlite", NOW - 2 * DAY);
  await A.ledger.restoreRows(mkRows(3, 5, 30));
  await A.paper.importJournal([mkJournal(1, NOW - 5 * DAY)]);
  await A.ledger.restorePreregistrations([mkPrereg({ cfg: "c9" })]);
  await A.ledger.restoreTrials([mkTrial(7)]);
  await A.prefsPort.put("preferences", "current", normalizePreferences({ autoRefresh: false }));
  const { text } = await createBackupFile(A.deps, PASS);

  const B = device();
  await B.ledger.restoreRows(mkRows(2, 4, 3));
  await B.paper.save(newBook(NOW));
  await B.paper.importJournal([mkJournal(5, NOW - H)]);
  await B.ledger.registerTrial("c1", "mine");
  await B.ledger.preregister({ cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full", hypothesis: "m", horizon: 6 });
  await B.prefsPort.put("preferences", "current", normalizePreferences({ autoRefresh: true }));
  B.log.push({ at: new Date(NOW).toISOString(), event: "preferences.update", record: "preferences", reason: "x" });
  const before = await snap(B);
  const plan = await openBackupFile(text, PASS, B.deps);
  assert.ok(plan.ledger.added > 0 && plan.journal.added === 1 && plan.preregistrations.added === 1 && plan.trials.added === 1);
  assert.equal(await snap(B), before, "open + plan changed a store or the audit");
});

test("createBackupFile reports what it left out per section", async () => {
  const A = device();
  await A.ledger.restoreRows(mkRows(1, 2));
  // a replay row can reach the ledger through the CSV import path; it is left out, and counted
  await A.ledgerPort.put("ledger", "2026-11-10|binance|4h|c1|1", { schema: 2, day: "2026-11-10", src: "binance", tf: "4h", cfg: "c1", t: 1, rows: [mkRow("RPL", BAR0 - 100 * 4 * H, 0, { live: 0 })] });
  const made = await createBackupFile(A.deps, PASS);
  assert.deepEqual(made.skipped, { rows: 1, preregistrations: 0, trials: 0, journal: 0 });
  assert.equal(made.counts.rows, 2);
});

test("F5 chained restores A to B to C to D keep exactly one bk: prefix and lose or duplicate nothing", async () => {
  const A = device();
  await putRaw(A, tradeEntry(1, { pair: "BTCUSDT" }));
  await putRaw(A, tradeEntry(2, { pair: "ETHUSDT" }));
  let from = A;
  for (let hop = 0; hop < 14; hop++) { // past the point where the old behaviour overflowed the 160-character id limit
    const { text } = await createBackupFile(from.deps, PASS);
    const to = device();
    const plan = await openBackupFile(text, PASS, to.deps);
    assert.deepEqual(plan.journal, { inFile: 2, added: 2, duplicates: 0, rejected: 0 }, `hop ${hop}`);
    assert.deepEqual((await applyRestore(plan, { settings: false }, to.deps)).journal, { added: 2, duplicates: 0 });
    // restoring the same backup again, or onto a device that already holds the namespaced entries, adds nothing
    assert.deepEqual((await openBackupFile(text, PASS, to.deps)).journal, { inFile: 2, added: 0, duplicates: 2, rejected: 0 });
    assert.deepEqual((await openBackupFile(text, PASS, from.deps)).journal, { inFile: 2, added: 0, duplicates: 2, rejected: 0 });
    from = to;
  }
  // the last device also trades on its own: its trade-1 is stored beside the restored entries
  const book = await from.paper.load(NOW);
  book.journal.push(tradeEntry(1, { pair: "SOLUSDT", proposalId: "local-1" }));
  await from.paper.save(book);
  const journal = (await from.paper.load(NOW)).journal;
  assert.equal(journal.length, 3);
  for (const j of journal.filter((x) => x.pair !== "SOLUSDT")) {
    assert.match(j.id, /^bk:[0-9a-f]{8}:trade-[12]$/, j.id);
    assert.ok(sanitizeJournalEntry(j));
  }
  assert.ok(journal.some((j) => j.id === "trade-1" && j.pair === "SOLUSDT"));
});

/* ---- WP28 Task 10 fix round 1 (I-1): a restore that stops part-way is audited and reported with what it wrote ---- */
async function partialSource() {
  const A = device();
  await A.ledger.restoreRows(mkRows(4, 50));
  await A.paper.importJournal([mkJournal(1, NOW - 2 * DAY), mkJournal(2, NOW - DAY)]);
  await A.ledger.preregister({ cfg: "c1", source: "binance", tf: "4h", assetClass: "crypto", windowMode: "full", hypothesis: "h", horizon: 6 });
  await A.ledger.registerTrial("c1", "variant-a", "note");
  await A.ledger.registerTrial("c1", "variant-b");
  return (await createBackupFile(A.deps, PASS)).text;
}
async function partialError(p) {
  try { await p; } catch (e) { return e; }
  assert.fail("expected the restore to fail");
}

test("a restore that fails in the journal step is audited as partial and reports the records it wrote", async () => {
  const text = await partialSource();
  const B = device();
  const plan = await openBackupFile(text, PASS, B.deps);
  const boom = new Error("journal store failed");
  B.deps.paper = { ...B.deps.paper, importJournal: async (list, o = {}) => { if (o.dryRun) return B.paper.importJournal(list, o); throw boom; } };
  const e = await partialError(applyRestore(plan, { settings: true }, B.deps));
  assert.ok(e instanceof BackupError, `expected BackupError, got ${e}`);
  assert.equal(e.code, "partial");
  assert.equal(e.cause, boom, "the original error is kept as the cause");
  assert.deepEqual(
    { n: e.detail.n, preregistrations: e.detail.preregistrations, trials: e.detail.trials, rows: e.detail.rows, journal: e.detail.journal, settings: e.detail.settings, step: e.detail.step, audit: e.detail.audit },
    { n: 203, preregistrations: 1, trials: 2, rows: 200, journal: 0, settings: 0, step: "journal", audit: "written" },
  );
  const partial = B.log.filter((x) => x.event === "backup.cloud.restore.partial");
  assert.equal(partial.length, 1);
  assert.equal(partial[0].record, "backup");
  assert.match(partial[0].reason, /stopped in the journal step · 200 rows, 0 trades, 1 pre-registrations, 2 trials, 0 settings written/);
  assert.equal(B.log.filter((x) => x.event === "backup.cloud.restore").length, 0);
  assert.ok(!B.log.some((x) => JSON.stringify(x).includes(PASS)));
  // running the same restore again is safe: it completes and adds only what was missing
  B.deps.paper = B.paper;
  const again = await applyRestore(await openBackupFile(text, PASS, B.deps), { settings: true }, B.deps);
  assert.equal(again.ledger.added, 0);
  assert.equal(again.journal.added, 2);
  assert.equal((await B.ledger.all()).length, 200);
});

test("a ledger store that throws mid-restore: the rows already written are counted, and a failing audit never masks the error", async () => {
  const text = await partialSource();
  const B = device();
  const plan = await openBackupFile(text, PASS, B.deps);
  const realPut = B.ledgerPort.put.bind(B.ledgerPort);
  let ledgerPuts = 0;
  const boom = new Error("disk went away");
  B.ledgerPort.put = async (c, i, d) => { if (c === "ledger" && ++ledgerPuts > 20) throw boom; return realPut(c, i, d); };
  B.deps.audit = { ...B.deps.audit, append: async () => { throw new Error("audit store failed"); } };
  const e = await partialError(applyRestore(plan, { settings: false }, B.deps));
  assert.ok(e instanceof BackupError);
  assert.equal(e.code, "partial");
  assert.equal(e.cause, boom, "the audit failure does not replace the original error");
  assert.equal(e.detail.step, "rows");
  assert.equal(e.detail.audit, "failed");
  B.ledgerPort.put = realPut;
  const written = (await B.ledger.all()).length;
  assert.ok(written > 0 && written < 200, `some rows were written (${written})`);
  assert.equal(e.detail.rows, written);
  assert.equal(e.detail.n, written + 1 + 2);
});
