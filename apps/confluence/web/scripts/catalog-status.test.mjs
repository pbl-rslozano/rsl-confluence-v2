import { test } from "node:test";
import assert from "node:assert/strict";
import { catalogHash, statusErrors, safetyErrors, SAFETY_KEYS } from "./catalog-status.mjs";

const base = { "a.one": "Uno", "b.two": "Dos" };

test("catalogHash ignores @ metadata and key order", () => {
  assert.equal(catalogHash({ "@status": "DRAFT", ...base }), catalogHash({ "b.two": "Dos", "a.one": "Uno" }));
  assert.notEqual(catalogHash(base), catalogHash({ ...base, "b.two": "Tres" }));
});

test("machine-checked tier-2 catalog is valid", () => {
  assert.deepEqual(statusErrors("es", { "@status": "MACHINE-CHECKED", "@reviewer": null, ...base }, 2), []);
});

test("unknown status is rejected", () => {
  assert.match(statusErrors("es", { "@status": "DONE", ...base }, 2)[0], /status/);
});

test("certified-missing-reviewer", () => {
  const cat = { "@status": "CERTIFIED", "@reviewer": "", "@certifiedAt": "2026-11-07", "@certifiedHash": catalogHash(base), ...base };
  assert.match(statusErrors("es", cat, 2).join(" "), /reviewer/);
});

test("certified-hash-mismatch", () => {
  const cat = { "@status": "CERTIFIED", "@reviewer": "Ana López", "@certifiedAt": "2026-11-07", "@certifiedHash": catalogHash(base), ...base, "b.two": "Tres" };
  assert.match(statusErrors("es", cat, 2).join(" "), /es: catalog changed since certification/);
});

test("valid certification passes", () => {
  const cat = { "@status": "CERTIFIED", "@reviewer": "Ana López", "@reviewerGithub": "ana-lopez", "@certifiedAt": "2026-11-07", "@certifiedHash": catalogHash(base), ...base };
  assert.deepEqual(statusErrors("es", cat, 2), []);
});

test("tier-1 catalogs stay APPROVED", () => {
  assert.deepEqual(statusErrors("ar", { "@status": "APPROVED", ...base }, 1), []);
  assert.match(statusErrors("ar", { "@status": "DRAFT", ...base }, 1)[0], /APPROVED/);
});

test("safety strings are locked: an edit fails until the lock is renewed", () => {
  const cat = { "paper.banner": "Simulado — no se envían órdenes", "status.disclaimer": "No es asesoría financiera" };
  const lock = { es: Object.fromEntries(SAFETY_KEYS.map((k) => [k, catalogHash({ [k]: cat[k] })])) };
  assert.deepEqual(safetyErrors("es", cat, lock), []);
  assert.match(safetyErrors("es", { ...cat, "paper.banner": "Simulado" }, lock).join(" "), /paper\.banner/);
});

test("certified catalogs name the reviewer's GitHub login (CI requires that login's approval)", () => {
  const cat = { "@status": "CERTIFIED", "@reviewer": "Ana López", "@certifiedAt": "2026-11-07", "@certifiedHash": catalogHash(base), ...base };
  assert.match(statusErrors("es", cat, 2).join(" "), /@reviewerGithub/);
  assert.match(statusErrors("es", { ...cat, "@reviewerGithub": "not a login!" }, 2).join(" "), /@reviewerGithub/);
  assert.match(statusErrors("es", { "@status": "MACHINE-CHECKED", "@reviewerGithub": "ana", ...base }, 2).join(" "), /only set on CERTIFIED/);
});

/* ---- Final review I-1: tier-1 drafts flagged for native review; no tier-1 string left in English ---- */
import * as cs from "./catalog-status.mjs";
import { readFileSync } from "node:fs";

const enBase = { "a.one": "One", "b.two": "Two", "ledger.psr": "PSR" };

test("tier-1 catalog: a string left identical to English fails; allow-listed brand/provider/ticker keys pass", () => {
  assert.equal(typeof cs.untranslatedErrors, "function", "untranslatedErrors exported");
  const ar = { "@status": "APPROVED", "a.one": "واحد", "b.two": "Two", "ledger.psr": "PSR" };
  assert.match((cs.untranslatedErrors?.("ar", ar, enBase, 1) ?? []).join(" "), /b\.two/);
  assert.deepEqual(cs.untranslatedErrors?.("ar", { ...ar, "b.two": "اثنان" }, enBase, 1), []);
  assert.ok(cs.TIER1_SAME_AS_EN?.includes("ledger.psr"));
  // Tier 2 may fall back to English (plan Global Constraint) and en is the source.
  assert.deepEqual(cs.untranslatedErrors?.("ja", { "a.one": "One" }, enBase, 2), []);
  assert.deepEqual(cs.untranslatedErrors?.("en", enBase, enBase, 1), []);
});

test("tier-1 @pendingReview lists existing message keys, once each; only tier-1 catalogs carry it", () => {
  const ar = { "@status": "APPROVED", "a.one": "واحد", "b.two": "اثنان" };
  assert.deepEqual(statusErrors("ar", { ...ar, "@pendingReview": ["b.two"] }, 1), []);
  assert.match(statusErrors("ar", { ...ar, "@pendingReview": ["c.nope"] }, 1).join(" "), /pendingReview/);
  assert.match(statusErrors("ar", { ...ar, "@pendingReview": "b.two" }, 1).join(" "), /pendingReview/);
  assert.match(statusErrors("ar", { ...ar, "@pendingReview": ["b.two", "b.two"] }, 1).join(" "), /pendingReview/);
  assert.match(statusErrors("ar", { ...ar, "@pendingReview": ["@status"] }, 1).join(" "), /pendingReview/);
  assert.match(statusErrors("es", { "@status": "MACHINE-CHECKED", ...base, "@pendingReview": ["a.one"] }, 2).join(" "), /pendingReview/);
});

test("release gate: fails while tier-1 strings are pending native review, passes without", () => {
  assert.equal(typeof cs.pendingReviewErrors, "function", "pendingReviewErrors exported");
  const ar = { "@status": "APPROVED", "a.one": "واحد", "b.two": "اثنان" };
  assert.match((cs.pendingReviewErrors?.("ar", { ...ar, "@pendingReview": ["a.one", "b.two"] }) ?? []).join(" "), /ar: 2 strings pending native-speaker review/);
  assert.deepEqual(cs.pendingReviewErrors?.("ar", ar), []);
  assert.deepEqual(cs.pendingReviewErrors?.("ar", { ...ar, "@pendingReview": [] }), []);
});

test("repository ar.json: no English-identical string outside the allow-list; drafts are flagged for review", () => {
  const dir = new URL("../src/rsl/i18n/", import.meta.url);
  const en = JSON.parse(readFileSync(new URL("en.json", dir), "utf8"));
  const ar = JSON.parse(readFileSync(new URL("ar.json", dir), "utf8"));
  assert.deepEqual(cs.untranslatedErrors?.("ar", ar, en, 1) ?? ["untranslatedErrors missing"], []);
  assert.deepEqual(statusErrors("ar", ar, 1), []);
  const pending = ar["@pendingReview"] ?? [];
  for (const k of ["about.edition", "fx.src.ecb", "paper.intro", "paper.drawdownWaiting", "paper.heldFeedFailed", "about.catalogApprovedPending"]) {
    assert.ok(pending.includes(k), `${k} is flagged @pendingReview`);
  }
});

// Fix-wave re-review N-2 / N-3: two Arabic drafts said something else than the English.
test("ar drafts: paper.set.locked says the risk LIMITS cannot be loosened; drawdownResetWaiting says scan, not erase", () => {
  const dir = new URL("../src/rsl/i18n/", import.meta.url);
  const ar = JSON.parse(readFileSync(new URL("ar.json", dir), "utf8"));
  assert.match(ar["paper.set.locked"], /حدود المخاطر/);
  assert.doesNotMatch(ar["paper.set.locked"], /لا يمكن تخفيف المخاطر/);
  assert.match(ar["paper.set.locked"], /UTC/);
  assert.doesNotMatch(ar["paper.drawdownResetWaiting"], /امسح/);
  assert.match(ar["paper.drawdownResetWaiting"], /افحص \{series\} أولًا/);
  for (const k of ["paper.set.locked", "paper.drawdownResetWaiting"]) assert.ok(ar["@pendingReview"].includes(k), `${k} stays @pendingReview`);
});
