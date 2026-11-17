// WP28 final review: the cloud-backup docs and copy must say what the code does (I-1, I-2, I-3, M-2, M-4, M-5, M-6, M-7).
//   node --test tools/backup-docs-truth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const GUIDE_ALL = read("docs/user-guide/en.md");
const start = GUIDE_ALL.indexOf("<!-- wp:WP28 -->");
const GUIDE = GUIDE_ALL.slice(start, GUIDE_ALL.indexOf("<!-- wp:", start + 10));
const ADR = read("docs/adr/0019-cloud-backup.md");
const SETUP = read("docs/backup-provider-setup.md");
const I18N = "apps/confluence/web/src/rsl/i18n";
const catalogs = Object.fromEntries(readdirSync(join(ROOT, I18N)).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(read(`${I18N}/${f}`))]));
const flat = (s) => s.replace(/\s+/g, " ");

test("the guide section is found", () => {
  assert.ok(start > 0 && GUIDE.includes("Cloud backup (encrypted"));
});

test("I-3 no doc says the desktop app runs the gateway; the bucket key lives until the gateway stops", () => {
  const wrong = /desktop app'?s? (local )?gateway|it runs the gateway|runs the gateway\)|desktop gateway|gone when the app closes/i;
  for (const [name, text] of [["guide", GUIDE], ["ADR-0019", ADR], ["setup", SETUP], ["gateway README", read("apps/confluence/gateway/README.md")]]) {
    assert.ok(!wrong.test(text), `${name}: ${(wrong.exec(text) || [""])[0]}`);
  }
  assert.match(flat(GUIDE), /separate program you start by hand/);
  assert.match(flat(GUIDE), /pnpm gateway/);
  assert.match(flat(GUIDE), /until the gateway stops/);
  assert.match(flat(SETUP), /pnpm gateway/);
  assert.match(flat(ADR), /separate Node process started by hand/);
});

test("M-6 the copy names the real control: the header's Private API button, in each catalog's own words", () => {
  for (const [lang, cat] of Object.entries(catalogs)) {
    for (const [k, v] of Object.entries(cat)) if (k.startsWith("bk.")) assert.ok(!/Settings → API|الإعدادات ← API/.test(v), `${lang} ${k}`);
    for (const k of ["bk.state.needsGateway", "bk.err.needs-gateway", "bk.err.gateway"]) assert.ok(cat[k].includes(cat["ctl.api"]), `${lang} ${k} names ${cat["ctl.api"]}`);
  }
  assert.equal(catalogs.en["ctl.api"], "Private API");
  for (const text of [GUIDE, ADR, SETUP]) assert.ok(!text.includes("Settings → API") && !/Settings, API/.test(text));
  assert.match(GUIDE, /\*\*Private API\*\*/);
});

test("I-1 the guide and ADR-0019 name what is backed up and every record that is left out", () => {
  for (const [name, text] of [["guide", flat(GUIDE)], ["ADR-0019", flat(ADR)]]) {
    for (const inside of [/outcome snapshots/i, /trade notes/i, /recorded gaps/i, /universe snapshots/i]) assert.match(text, inside, `${name} in: ${inside}`);
    for (const out of [/market history/i, /paper account/i, /open positions/i, /risk settings/i, /radar caches/i, /replay rows/i, /cursors/i, /measured slippage/i, /last ledger export/i]) {
      assert.match(text, out, `${name} out: ${out}`);
    }
  }
  assert.match(flat(ADR), /ledger":\{"rows","outcomes","universes","gaps"\}/);
  assert.match(flat(ADR), /paper":\{"journal","notes"\}/);
});

test("I-2 the partial-restore limitation is gone from the docs: a full store stops cleanly and a re-run is safe", () => {
  for (const text of [GUIDE, ADR]) assert.ok(!/not re-indexed/.test(text), "old known limitation still documented");
  assert.match(flat(ADR), /1,000 rows/);
  assert.match(flat(GUIDE), /storage is full/i);
});

test("M-2 the guide gives the realistic row ceiling and quotes both size messages", () => {
  assert.match(flat(GUIDE), /about [\d,]+ live rows/);
  assert.equal(catalogs.en["bk.err.too-large-plain"].startsWith("The backup would be about {size}"), true);
  assert.match(flat(GUIDE), /once unpacked/);
});

test("M-4 the web pCloud sign-in's history entry and how to revoke the token are documented", () => {
  assert.match(flat(GUIDE), /On the web, pCloud/);
  assert.match(flat(GUIDE), /browser history/);
  assert.match(flat(GUIDE), /revoke/i);
  assert.match(flat(ADR), /web sign-in/i);
});

test("M-7 the guide tells users to delete old backups", () => {
  assert.match(flat(GUIDE), /[Dd]elete old backups/);
});

test("M-5 the pCloud host comment says where the host comes from", () => {
  const src = read("apps/confluence/web/src/lib/public-hosts.ts");
  assert.ok(!src.includes("the app asks the user which"));
  assert.match(src, /comes from the\s+(\* )?sign-in response/);
});
