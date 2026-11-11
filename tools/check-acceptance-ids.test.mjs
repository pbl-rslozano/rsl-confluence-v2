import { test } from "node:test";
import assert from "node:assert/strict";
import { listAcceptanceIds, checkIds } from "./check-acceptance-ids.mjs";

test("listAcceptanceIds returns sorted unique record() ids", () => {
  const src = 'record("M-20", "x", true); record("ID-8.11", "y", ok); record("M-20", "again", 1)';
  assert.deepEqual(listAcceptanceIds(src), ["ID-8.11", "M-20"]);
});

test("listAcceptanceIds keeps templated ids as prefix patterns", () => {
  assert.deepEqual(listAcceptanceIds("record(`BLD-9.4-9-${label}-${dir}`, t, ok)"), ["BLD-9.4-9-*"]);
});

test("listAcceptanceIds reads ids declared for dynamic record() calls", () => {
  assert.deepEqual(listAcceptanceIds("/* acceptance-ids: M-20, M-21 */ for (const [id] of x) record(id, t, ok);"), ["M-20", "M-21"]);
});

test("checkIds reports ids missing from the current suite", () => {
  assert.deepEqual(checkIds(["A"], { ids: ["A", "B"], removals: [] }), { ok: false, missing: ["B"] });
});

test("checkIds accepts a removal that cites an ADR", () => {
  assert.deepEqual(checkIds(["A"], { ids: ["A", "B"], removals: [{ id: "B", adr: "docs/adr/0011-x.md" }] }), { ok: true, missing: [] });
});

test("checkIds ignores a removal without an ADR path", () => {
  assert.equal(checkIds(["A"], { ids: ["A", "B"], removals: [{ id: "B", adr: "" }] }).ok, false);
});

test("record() calls inside comments do not count", async () => {
  const { listAcceptanceIds } = await import("./check-acceptance-ids.mjs");
  assert.deepEqual(listAcceptanceIds('// record("M-20", t, ok);\n/* record("M-21", t, ok) */\nrecord("A-1", t, ok);'), ["A-1"]);
});

test("a removal must cite an ADR file that exists", async () => {
  const { checkIds } = await import("./check-acceptance-ids.mjs");
  const baseline = { ids: ["A", "B"], removals: [{ id: "B", adr: "docs/adr/0099-gone.md" }] };
  assert.equal(checkIds(["A"], baseline, () => false).ok, false);
  assert.equal(checkIds(["A"], baseline, () => true).ok, true);
});

test("every ID on the base branch must still exist (a snapshot cannot overwrite both suite and baseline)", async () => {
  const { checkAgainstBase } = await import("./check-acceptance-ids.mjs");
  assert.deepEqual(checkAgainstBase(["A", "C"], ["A", "B"], [], () => true), { ok: false, missing: ["B"] });
  assert.deepEqual(checkAgainstBase(["A"], ["A", "B"], [{ id: "B", adr: "docs/adr/0011-x.md" }], () => true), { ok: true, missing: [] });
});

test("// and /* inside strings and regexes do not swallow real record() calls", async () => {
  const { listAcceptanceIds } = await import("./check-acceptance-ids.mjs");
  const src = 'const u = "https://x.test/a";\nrecord("A-3", t, ok);\nconst g = "src/*.js"; const r = /a\\/\\*b/;\nrecord("A-4", t, ok);\nconst z = "*/";\nrecord("A-5", t, ok);';
  assert.deepEqual(listAcceptanceIds(src), ["A-3", "A-4", "A-5"]);
});
