// rsL Coffee Kit tip card (owner request, 15 Nov 2026): the committed kit is the verified master copy, the app only reads it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COFFEE_APP_NAME, COFFEE_KIT_BUILD, COFFEE_KIT_VERSION, coffeeAlt, coffeeKitVersion, coffeeCardSrc, coffeeText, copyToClipboard,
} from "./coffee-kit.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_FILE = join(HERE, "coffee-kit.json");
const KIT = JSON.parse(readFileSync(KIT_FILE, "utf8"));
const byId = (id) => KIT.methods.find((m) => m.id === id);
const sha256 = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

/** The six fingerprints of the master kit 1.1.0, build 20261115 (QR PNG / card PNG). */
const KNOWN = {
  gcash: ["0151f6cf9699b30d98fac50073528b6827caff2b7f6533d1e49ea3b0a5062d04", "b3c1a84b184ad6c84ec54f14df16cbccbe4638723cf51381d514b139e26f8314"],
  paypal: ["b2378da740b285d8984dcb97e83864f2e77641409ee452cbce9c1ef0dd9e918b", "dcd63bd337b13060b4d6f37e737bce9b8300c5384ba5b08896277409053d4bee"],
  btc: ["db2e696c0746759048e12e6c509799d5d753ea5529f6cefd53d970630f1d0536", "c8a5e9ed5e4c70e46c2653cf474c0b1b309f0c903c6c90bde51cba4f09b900e0"],
};

test("kit 1.1.0 build 20261115 with the three methods in order", () => {
  assert.equal(KIT.kit, "rsL Coffee Kit");
  assert.equal(KIT.kitVersion, "1.1");
  assert.equal(COFFEE_KIT_VERSION, "1.1.0", "display string is SemVer, no v, no year (KIT-003)");
  assert.equal(COFFEE_KIT_VERSION, coffeeKitVersion(KIT.kitVersion), "derived from the kit data's kitVersion");
  assert.equal(COFFEE_KIT_BUILD, "20261115");
  assert.deepEqual(KIT.methods.map((m) => m.id), ["gcash", "paypal", "btc"]);
});

test("coffeeKitVersion pads kitVersion to MAJOR.MINOR.PATCH, the kit data itself is not touched", () => {
  assert.equal(coffeeKitVersion("1.1"), "1.1.0");
  assert.equal(coffeeKitVersion("1.0"), "1.0.0");
  assert.equal(coffeeKitVersion("2"), "2.0.0");
  assert.equal(coffeeKitVersion("1.2.3"), "1.2.3");
  assert.equal(coffeeKitVersion("beta"), "beta");
  assert.equal(KIT.kitVersion, "1.1", "kitVersion in the master kit JSON stays 1.1");
});

test("image hashes: SHA-256 of each decoded QR and card PNG equals the kit and the known fingerprints", () => {
  for (const [id, [qr, card]] of Object.entries(KNOWN)) {
    const m = byId(id);
    assert.equal(m.qrSha256, qr, `${id} qrSha256 in the kit`);
    assert.equal(m.cardSha256, card, `${id} cardSha256 in the kit`);
    assert.equal(sha256(m.qrPng), qr, `${id} QR PNG`);
    assert.equal(sha256(m.cardPng), card, `${id} card PNG`);
  }
});

test("card PNGs are 600 × 868 (IHDR)", () => {
  for (const m of KIT.methods) {
    const png = Buffer.from(m.cardPng, "base64");
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [600, 868], m.id);
    assert.deepEqual(m.cardPixels, [600, 868], m.id);
  }
});

test("copyValue: GCash and PayPal are scan-only; Bitcoin copies the exact bech32 address", () => {
  assert.equal(byId("gcash").copyValue, null);
  assert.equal(byId("paypal").copyValue, null);
  const btc = byId("btc");
  assert.match(btc.copyValue, /^bc1q[02-9ac-hj-np-z]{38}$/);
  assert.equal(btc.copyValue, btc.qrPayload);
  assert.equal(btc.copyLabel, "Copy address");
});

test("GCash QR Ph payload: valid EMV CRC and tag 59 is the issuer-masked name", () => {
  const p = byId("gcash").qrPayload;
  const tlv = parseTlv(p);
  assert.equal(tlv.get("00"), "01");
  assert.equal(tlv.get("59"), "RO***D L.");
  assert.equal(tlv.get("63"), crc16(p.slice(0, -4)));
});

test("kit wording: {appName} becomes the app name; nothing else changes", () => {
  assert.equal(COFFEE_APP_NAME, "rsL Confluence Terminal");
  const intro = coffeeText(KIT.intro);
  assert.ok(intro.startsWith("rsL Confluence Terminal is built by"), intro);
  assert.ok(!intro.includes("{appName}"));
  assert.equal(intro, KIT.intro.replaceAll("{appName}", "rsL Confluence Terminal"));
  assert.equal(coffeeText(KIT.footer), KIT.footer);
  assert.equal(coffeeText("{appName} · {appName}", "X"), "X · X");
});

test("alt text describes each card without contact details", () => {
  assert.deepEqual(KIT.methods.map(coffeeAlt), [
    "GCash QR Ph code for RO***D L.",
    "PayPal QR code for rsLozano",
    "Bitcoin on-chain QR code for rsLozano",
  ]);
});

test("card image source is the kit's base64, unchanged", () => {
  for (const m of KIT.methods) assert.equal(coffeeCardSrc(m), `data:image/png;base64,${m.cardPng}`);
});

test("copy: clipboard first, silent textarea fallback, never throws", async () => {
  const written = [];
  assert.equal(await copyToClipboard("abc", { clipboard: { writeText: async (t) => { written.push(t); } } }), true);
  assert.deepEqual(written, ["abc"]);

  const fallback = [];
  const doc = fakeDocument(fallback, true);
  assert.equal(await copyToClipboard("xyz", { clipboard: { writeText: async () => { throw new Error("denied"); } }, document: doc }), true);
  assert.deepEqual(fallback, ["xyz"]);
  assert.equal(doc.body.children.length, 0, "fallback textarea removed");

  assert.equal(await copyToClipboard("q", { document: fakeDocument([], false) }), false);
  assert.equal(await copyToClipboard("q", { document: { createElement() { throw new Error("no DOM"); } } }), false);
  assert.equal(await copyToClipboard("q", {}), false);
});

/* ---------- leak scan (generic patterns only; base64 runs of 200+ characters skipped) ---------- */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+|\b00)\d[\d ().-]{8,}\d|\b09\d{2}[ -]?\d{3}[ -]?\d{4}\b/g;

/**
 * An EMV QR Ph payload is a run of tag-length-value fields, so its first characters ("000201…") look like an
 * international "00…" number to the phone pattern. It is scanned field by field instead: every value (including the
 * nested merchant-account fields) is still checked by both patterns.
 */
function emvFields(text) {
  return text.replace(/"(000201\d{2}[^"]*6304[0-9A-F]{4})"/g, (_, p) => JSON.stringify(tlvValues(p).join(" ")));
}
function leaks(text) {
  const s = emvFields(text).replace(/[A-Za-z0-9+/=]{200,}/g, "");
  return [...s.matchAll(EMAIL), ...s.matchAll(PHONE)].map((m) => m[0]);
}

test("leak scan helper finds generic e-mail and phone shapes", () => {
  // Fixtures are assembled at run time so this file itself holds no e-mail or phone shape.
  const at = "@", plus = "+";
  assert.equal(leaks(`write to a.b${at}c.example`).length, 1);
  assert.equal(leaks(`call ${plus}1 555 0100 999`).length, 1);
  assert.equal(leaks(`call ${"09"}17 000 0000`).length, 1);
  assert.equal(leaks(`"${"A".repeat(250)}${at}x.example"`).length, 0, "long base64 runs are skipped");
  // a phone shape hidden inside an EMV field is still found
  assert.equal(leaks(JSON.stringify(emv([["00", "01"], ["59", `${plus}6391${"7".repeat(8)}`]]))).length, 1);
});

test("leak scan: zero e-mail or phone hits in the kit file and the coffee code", () => {
  for (const f of [KIT_FILE, join(HERE, "coffee-kit.ts"), join(HERE, "components", "CoffeeSection.tsx"), join(HERE, "components", "AboutDialog.tsx")]) {
    assert.deepEqual(leaks(readFileSync(f, "utf8")), [], f);
  }
});

test("CoffeeSection renders the kit, collapsed, before the licences section and the credit", () => {
  const src = readFileSync(join(HERE, "components", "CoffeeSection.tsx"), "utf8");
  assert.match(src, /<details[^>]*data-testid="about-coffee"/);
  assert.doesNotMatch(src, /<details[^>]*\sopen\b/, "collapsed by default");
  assert.match(src, /data-coffee-copy/);
  assert.match(src, /repeat\(auto-fit,\s*minmax\(220px,\s*1fr\)\)/);
  // wording comes from the kit data, never retyped or sent through the i18n catalogs
  for (const w of ["kabayan", "Treat the developer", "never a fee", "Salamat", "Copy address"]) assert.ok(!src.includes(w), `retyped "${w}"`);
  assert.doesNotMatch(src, /\bt\(\s*["']coffee/);
  const about = readFileSync(join(HERE, "components", "AboutDialog.tsx"), "utf8");
  const [coffee, licences, footer] = ["<CoffeeSection", "<LicencesSection", "<footer"].map((x) => about.indexOf(x));
  assert.ok(coffee > 0 && coffee < licences && licences < footer, "coffee, then licences, then the credit footer");
});

/* ---------- helpers ---------- */
function parseTlv(s) {
  const out = new Map();
  for (let i = 0; i < s.length;) {
    const tag = s.slice(i, i + 2), len = Number(s.slice(i + 2, i + 4));
    out.set(tag, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}
/** Every value, recursing into the merchant-account templates (tags 26–51) and the additional data field (62). */
function tlvValues(s) {
  const vals = [];
  for (const [tag, v] of parseTlv(s)) {
    const n = Number(tag);
    if ((n >= 26 && n <= 51) || n === 62) vals.push(...tlvValues(v));
    else vals.push(v);
  }
  return vals;
}
function emv(fields) {
  const body = fields.map(([t, v]) => t + String(v.length).padStart(2, "0") + v).join("") + "6304";
  return body + crc16(body);
}
function crc16(s) {
  let crc = 0xffff;
  for (const ch of Buffer.from(s, "latin1")) {
    crc ^= ch << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function fakeDocument(sink, ok) {
  const body = { children: [], appendChild(n) { this.children.push(n); }, removeChild(n) { this.children = this.children.filter((x) => x !== n); } };
  return {
    body,
    createElement: () => ({ value: "", style: {}, setAttribute() {}, select() {}, remove() { body.removeChild(this); } }),
    execCommand(cmd) { if (cmd === "copy" && ok) sink.push(body.children.at(-1).value); return ok; },
  };
}
