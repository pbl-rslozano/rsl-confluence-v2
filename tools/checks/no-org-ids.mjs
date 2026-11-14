#!/usr/bin/env node
/**
 * no-org-ids.mjs — release check R22 (v2.8, KIT-002, owner decision 14 Nov 2026).
 *
 * The app, the rsL Core Kit and the docs carry no organisation details: no employer or company names,
 * departments, people or sites. This check keeps it that way in the source tree and, when present,
 * in the built web output (plain and obfuscated: \xNN and \uNNNN escapes are decoded first).
 *
 * The guarded words are stored only as salted SHA-256 prefixes, so this file names nobody.
 * Every alphanumeric word of every text file is hashed and compared.
 *
 *   node tools/checks/no-org-ids.mjs        exit 0 = ok
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SALT = "rsl-org-guard:";
/** sha256(SALT + lower-case word), first 24 hex characters. Add a word: node tools/checks/no-org-ids.mjs --hash <word> */
export const GUARDED = new Set([
  "fcc8b12f0dc8f23c2f74fb91", "4e68bfb5913253bbe2e0a38a", "36970dfbc760eac9311aaad0", "e948d274c6ffbd7c4f8bcc61",
  "444118f630faa0c9e7fcf06a", "75fb6aa61b17a017a1d6c709", "2449b1c954099c5721cdc136",
]);
export const hashWord = (w) => createHash("sha256").update(SALT + w.toLowerCase()).digest("hex").slice(0, 24);

/** Decode the escapes an obfuscator or minifier may use, so an escaped word such as "\x41BC" is still read as one word. */
export function decodeEscapes(text) {
  return text
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Words of `text` that are guarded (deduplicated, as hashes so the report names nobody either). */
export function findGuarded(text) {
  const hits = new Set();
  const words = decodeEscapes(text).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
  for (const w of words) if (w.length <= 24 && GUARDED.has(hashWord(w))) hits.add(hashWord(w));
  return [...hits];
}

const SKIP = new Set(["node_modules", ".git", ".next", "target", "gen", ".turbo", "android", "ios", "confluence-terminal-2.01", "evidence"]);
const BINARY = /\.(png|ico|icns|jpe?g|gif|webp|woff2?|ttf|otf|zip|gz|tgz|jar|keystore|jks|aab|apk|ipa|dmg|msi|exe|db|sqlite|wasm)$/i;

function* walk(dir) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!BINARY.test(e) && st.size < 8_000_000) yield p;
  }
}

/** Scan the source tree (and apps/confluence/web/out + dist-minified when built). */
export function checkNoOrgIds(root = ROOT) {
  const findings = [];
  let scanned = 0;
  for (const f of walk(root)) {
    scanned++;
    const hits = findGuarded(readFileSync(f, "utf8"));
    if (hits.length) findings.push(`${relative(root, f).split(sep).join("/")} (${hits.length} guarded word${hits.length > 1 ? "s" : ""})`);
  }
  return { ok: findings.length === 0, findings, summary: `${scanned} text files, ${GUARDED.size} guarded words` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv[2] === "--hash") { console.log(hashWord(process.argv[3] ?? "")); process.exit(0); }
  const r = checkNoOrgIds();
  console.log(r.ok ? `ok — ${r.summary}` : r.findings.join("\n"));
  process.exit(r.ok ? 0 : 1);
}
