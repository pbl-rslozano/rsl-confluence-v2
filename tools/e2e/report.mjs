#!/usr/bin/env node
// Turns tools/e2e/evidence/results.json into docs/acceptance.md.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const r = JSON.parse(readFileSync(join(ROOT, "tools/e2e/evidence/results.json"), "utf8"));
const VER = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version.replace(/\.0$/, "");
const cell = (v) => (v == null ? "" : typeof v === "string" ? v : JSON.stringify(v)).replace(/\|/g, "/").slice(0, 160);
const rows = r.results.map((x) => `| ${x.id} | ${x.name} | ${x.pass ? "PASS" : "**FAIL**"} | ${cell(x.evidence)} |`);
const n = r.results.filter((x) => x.pass).length;
writeFileSync(join(ROOT, "docs/acceptance.md"), `# Acceptance evidence — rsL Confluence Terminal v${VER} 2026

Run \`${r.at}\` against the PWA static export (${r.base}) in Chromium via Playwright 1.63.0, with axe-core 4.14.0 and mocked exchange APIs.
**Result: ${n}/${r.results.length} passed.** Re-run: \`pnpm build:pwa\`, serve \`apps/confluence/web/out\` on 127.0.0.1:8770, then \`pnpm e2e\`.

Screenshots in \`tools/e2e/evidence/\`: splash, wizard, terminal at 1366 (dark, light, Arabic, Urdu, Japanese), About, About with WebGL off, and 390/820/1366 px in LTR and RTL.

| Id | Check | Result | Evidence |
|---|---|---|---|
${rows.join("\n")}

ID-* = rsl-app-identity-system §8 · BLD-* = rsl-cross-platform-app-builder §9.4. Desktop/mobile shells, signing and device behaviour are not covered here — see docs/security-controls.md gaps and README "Not verified".
`);
console.log(`docs/acceptance.md — ${n}/${r.results.length}`);
