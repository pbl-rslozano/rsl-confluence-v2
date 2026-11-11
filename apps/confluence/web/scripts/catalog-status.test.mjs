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
