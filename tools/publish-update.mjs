#!/usr/bin/env node
// publish-update.mjs — v2.5.1 update channel publisher (ADR-0012). Run by the CI `publish` job only.
//
//   NETLIFY_AUTH_TOKEN=… node tools/publish-update.mjs --dir apps/confluence/web/out --apk app-release.apk
//   node tools/publish-update.mjs --dir apps/confluence/web/out --apk app-release.apk --dry-run
//
// Stages the PWA + /updates/latest.json + /updates/<apk> and deploys them atomically with Netlify's file-digest
// API (only files Netlify does not already store are uploaded). Host: api.netlify.com (tools/egress-manifest.json,
// process "publish"). The token comes only from the environment and is never printed.
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_SITE = "effervescent-bubblegum-1e5c03.netlify.app";
const API = "https://api.netlify.com/api/v1";

export const apkFileName = (version, build) => `rsL-Confluence-v${version}-build${build}.apk`;

export function buildManifest({ version, build, publishedAt, notes, apk }) {
  return { schema: 1, app: "rsl-confluence", version, build, publishedAt, notes: (notes ?? "").slice(0, 500), android: apk ? { file: apk.file, bytes: apk.bytes, sha256: apk.sha256 } : null };
}

/** The bullet lines under the `# v<version>` (or `##`/`###`) heading of CHANGELOG.md, joined, ≤ 500 characters. */
export function notesFromChangelog(text, version) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{1,3}\\s+v?${version.replace(/\./g, "\\.")}(\\s|$)`).test(l));
  if (start < 0) return "";
  const out = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,3}\s/.test(l)) break; const m = l.match(/^\s*[-*]\s+(.*)$/); if (m) out.push(m[1].replace(/\*\*|`/g, "").trim()); }
  const s = out.join(" ");
  return s.length > 500 ? `${s.slice(0, 497)}...` : s;
}

/** { "/path": { sha1, read() } } for every file under dir. */
export function collectDigest(dir) {
  const files = {};
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files["/" + relative(dir, p).split(sep).join("/")] = { sha1: createHash("sha1").update(readFileSync(p)).digest("hex"), read: () => readFileSync(p) };
    }
  };
  walk(dir);
  return files;
}

const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

/** Netlify file-digest deploy: create (async) → wait for the upload list → upload required → wait for ready. */
export async function deployDigest({ site, token, files, fetch = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, title = "rsL Confluence update" }) {
  if (!token) throw new Error("NETLIFY_AUTH_TOKEN is not set");
  const headers = { Authorization: `Bearer ${token}`, "User-Agent": "rsl-confluence-publish" };
  const call = async (url, init = {}) => {
    const r = await fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`Netlify ${init.method ?? "GET"} ${url.replace(API, "")} → HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const digest = Object.fromEntries(Object.entries(files).map(([p, f]) => [p, f.sha1]));
  const created = await call(`${API}/sites/${site}/deploys`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: digest, async: true, title }) });
  log(`deploy ${created.id}: ${Object.keys(digest).length} files`);
  let d = created;
  for (let i = 0; d.state === "preparing" || d.state === "new" || d.state === "pending"; i++) {
    if (i > 120) throw new Error("Netlify deploy stuck in preparing");
    await sleep(2000);
    d = await call(`${API}/sites/${site}/deploys/${created.id}`);
  }
  if (d.state === "error") throw new Error(`Netlify deploy failed: ${d.error_message ?? "error"}`);
  const need = new Set(d.required ?? []);
  const done = new Set();
  for (const [p, f] of Object.entries(files)) {
    if (!need.has(f.sha1) || done.has(f.sha1)) continue;
    for (let attempt = 1; ; attempt++) {
      try {
        await call(`${API}/deploys/${created.id}/files/${encPath(p.slice(1))}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: f.read() });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        log(`upload ${p} failed (attempt ${attempt}), retrying`);
        await sleep(3000 * attempt);
      }
    }
    done.add(f.sha1);
  }
  log(`uploaded ${done.size} new files`);
  for (let i = 0; d.state !== "ready"; i++) {
    if (i > 150) throw new Error(`Netlify deploy not ready (state ${d.state})`);
    if (d.state === "error") throw new Error(`Netlify deploy failed: ${d.error_message ?? "error"}`);
    await sleep(2000);
    d = await call(`${API}/deploys/${created.id}`);
  }
  return { id: created.id, state: d.state, url: d.ssl_url ?? d.url };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const root = resolve(new URL("..", import.meta.url).pathname);
  const dir = resolve(arg("--dir") ?? join(root, "apps/confluence/web/out"));
  const apkPath = arg("--apk");
  const site = arg("--site") ?? DEFAULT_SITE;
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const build = /build:\s*"(\d{8})"/.exec(readFileSync(join(root, "apps/confluence/web/src/rsl/app-info.ts"), "utf8"))?.[1];
  if (!build) throw new Error("build not found in app-info.ts");
  const target = (() => { try { return readFileSync(join(dir, ".rsl-target"), "utf8").trim(); } catch { return null; } })();
  if (target !== "html") throw new Error(`${dir} is not a PWA (html) export (found ${target ?? "no .rsl-target"})`);

  const stage = mkdtempSync(join(tmpdir(), "rsl-publish-"));
  cpSync(dir, stage, { recursive: true, filter: (src) => !src.endsWith(".rsl-target") });
  mkdirSync(join(stage, "updates"), { recursive: true });
  let apk = null;
  if (apkPath) {
    const file = apkFileName(version, build);
    copyFileSync(apkPath, join(stage, "updates", file));
    const bytes = readFileSync(apkPath);
    apk = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const notes = notesFromChangelog(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version);
  const manifest = buildManifest({ version, build, publishedAt: new Date().toISOString(), notes, apk });
  writeFileSync(join(stage, "updates", "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const files = collectDigest(stage);
  console.log(JSON.stringify(manifest, null, 2));
  if (process.argv.includes("--dry-run")) { console.log(`dry run: ${Object.keys(files).length} files staged for ${site}; nothing deployed`); rmSync(stage, { recursive: true, force: true }); }
  else {
    try {
      const r = await deployDigest({ site, token: process.env.NETLIFY_AUTH_TOKEN ?? "", files, title: `v${version} build ${build}` });
      console.log(`published v${version} build ${build} → ${r.url} (deploy ${r.id})`);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
}
