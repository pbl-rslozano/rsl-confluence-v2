// Tests for release check R22 (tools/checks/no-org-ids.mjs). The guarded words are built from character
// codes at run time, so this file contains no organisation name either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGuarded, decodeEscapes, checkNoOrgIds, GUARDED, hashWord } from "./checks/no-org-ids.mjs";

const w = (...codes) => String.fromCharCode(...codes);
const SAMPLE = w(105, 66, 97, 107, 101);            // the employer brand, mixed case
const GROUP = w(83, 119, 105, 116, 122);            // the group name

test("every guarded hash is 24 hex characters", () => {
  for (const h of GUARDED) assert.match(h, /^[0-9a-f]{24}$/);
});

test("plain text: guarded words are found in any case, ordinary words are not", () => {
  assert.equal(findGuarded(`Powered by ${SAMPLE} – ${GROUP} Group`).length, 2);
  assert.equal(findGuarded(SAMPLE.toUpperCase()).length, 1);
  assert.deepEqual(findGuarded("Created by rsLozano · rsL Confluence Terminal · Personal workspace"), []);
  assert.deepEqual(findGuarded("bakery switch group bake"), [], "near words are not flagged");
});

test("obfuscated text: \\xNN and \\uNNNN escapes are decoded before matching", () => {
  const hex = [...SAMPLE].map((c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const uni = [...GROUP].map((c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  assert.equal(decodeEscapes(hex), SAMPLE);
  assert.equal(findGuarded(`var a='${hex}';var b="${uni}"`).length, 2);
});

test("hashWord is case-insensitive and salted", () => {
  assert.equal(hashWord(SAMPLE), hashWord(SAMPLE.toLowerCase()));
  assert.ok(GUARDED.has(hashWord(SAMPLE)));
});

test("tree scan: a clean tree passes, a tree with a guarded word in a built file fails", () => {
  const root = mkdtempSync(join(tmpdir(), "r22-"));
  mkdirSync(join(root, "apps", "out"), { recursive: true });
  writeFileSync(join(root, "README.md"), "Created by rsLozano\n");
  assert.equal(checkNoOrgIds(root).ok, true);
  writeFileSync(join(root, "apps", "out", "chunk.js"), `const c="Confidential switch group";`);
  writeFileSync(join(root, "apps", "out", "chunk2.js"), `x="${SAMPLE}"`);
  const r = checkNoOrgIds(root);
  assert.equal(r.ok, false);
  assert.equal(r.findings.length, 1, "only the file with a whole guarded word");
  assert.match(r.findings[0], /chunk2\.js/);
});
