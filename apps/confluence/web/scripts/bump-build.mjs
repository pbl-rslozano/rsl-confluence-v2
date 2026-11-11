import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const pkgPath = path.join(root, "package.json");
const infoPath = path.join(root, "src", "lib", "build-info.ts");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const current = fs.existsSync(infoPath) ? fs.readFileSync(infoPath, "utf8") : "";

const read = (re, fallback) => {
  const m = current.match(re);
  return m ? m[1] : fallback;
};

const nextBuild = (Number(read(/build:\s*(\d+)/, "0")) || 0) + 1;
// Display label + release date are author-controlled and preserved across bumps.
const label = read(/label:\s*"([^"]*)"/, "2.02");
const releaseDate = read(/releaseDate:\s*"([^"]*)"/, "31.10.2026");
const updatedAt = new Date().toISOString();
const version = pkg.version ?? "0.0.0";

const contents =
  `export const BUILD_INFO = {\n` +
  `  version: "${version}",\n` +
  `  build: ${nextBuild},\n` +
  `  label: "${label}",\n` +
  `  releaseDate: "${releaseDate}",\n` +
  `  updatedAt: "${updatedAt}",\n` +
  `} as const;\n`;
fs.writeFileSync(infoPath, contents, "utf8");
console.log(`Build metadata bumped to ${version}+${nextBuild} (label ${label}, released ${releaseDate})`);
