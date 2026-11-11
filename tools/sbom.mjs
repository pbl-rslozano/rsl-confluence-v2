#!/usr/bin/env node
/**
 * sbom.mjs — CycloneDX 1.6 JSON SBOM for rsL Confluence Terminal.
 *
 *   node tools/sbom.mjs            → dist/rsL-Confluence-v<ver>-<year>-sbom.cdx.json
 *
 * Sources: pnpm-lock.yaml (npm packages, with integrity hashes) and
 * apps/confluence/desktop/src-tauri/Cargo.lock (Rust crates, with checksums).
 * No network, no dependencies: both lockfiles are parsed line by line.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version.replace(/\.0$/, "");          // 2.1.0 → 2.1
const YEAR = 2026;
const components = [];

/* ---- npm (pnpm-lock v9: "packages:" section, keys are 'name@version') ---- */
const lock = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split("\n");
let inPackages = false, current = null;
for (const line of lock) {
  if (/^packages:\s*$/.test(line)) { inPackages = true; continue; }
  if (inPackages && /^\S/.test(line)) { inPackages = false; current = null; continue; }
  if (!inPackages) continue;
  const key = line.match(/^ {2}'?((?:@[^/]+\/)?[^@'\s]+)@([^'(:\s]+)'?:\s*$/);
  if (key) {
    current = { type: "library", name: key[1], version: key[2], purl: `pkg:npm/${key[1].replace("@", "%40")}@${key[2]}`, "bom-ref": `npm:${key[1]}@${key[2]}` };
    components.push(current);
    continue;
  }
  const integ = current && line.match(/integrity:\s*(sha\d+)-([A-Za-z0-9+/=]+)/);
  if (integ) current.hashes = [{ alg: integ[1].toUpperCase().replace("SHA", "SHA-"), content: Buffer.from(integ[2], "base64").toString("hex") }];
}
const npmCount = components.length;

/* ---- Rust (Cargo.lock [[package]] blocks) ---- */
const cargoPath = join(ROOT, "apps/confluence/desktop/src-tauri/Cargo.lock");
if (existsSync(cargoPath)) {
  for (const block of readFileSync(cargoPath, "utf8").split("[[package]]").slice(1)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    const sum = block.match(/^checksum = "([0-9a-f]+)"/m)?.[1];
    if (!name || !version) continue;
    const c = { type: "library", name, version, purl: `pkg:cargo/${name}@${version}`, "bom-ref": `cargo:${name}@${version}` };
    if (sum) c.hashes = [{ alg: "SHA-256", content: sum }];
    components.push(c);
  }
}

/* ---- Vendored rsL Core Kit (pinned by manifest) ---- */
const manifest = readFileSync(join(ROOT, "packages/core/KIT-MANIFEST.sha256"), "utf8");
components.push({
  type: "library", name: "rsl-core-kit", version: "1.0.2026", supplier: { name: "rsLozano" },
  "bom-ref": "rsl:core-kit@1.0.2026",
  hashes: [{ alg: "SHA-256", content: createHash("sha256").update(manifest).digest("hex") }],
  description: "Vendored unchanged; hash is of KIT-MANIFEST.sha256 (per-file hashes inside).",
});

const bom = {
  bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: "application", name: "rsl-sbom.mjs", version: "1.0" }] },
    component: { type: "application", name: "rsL Confluence Terminal", version: `${VERSION} ${YEAR}`, "bom-ref": "app", supplier: { name: "rsLozano" } },
  },
  components,
};
mkdirSync(join(ROOT, "dist"), { recursive: true });
const out = join(ROOT, "dist", `rsL-Confluence-v${VERSION}-${YEAR}-sbom.cdx.json`);
writeFileSync(out, JSON.stringify(bom, null, 2) + "\n");
console.log(`SBOM: ${npmCount} npm + ${components.length - npmCount - 1} cargo + 1 vendored = ${components.length} components → ${out.replace(ROOT + "/", "")}`);
