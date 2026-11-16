#!/usr/bin/env node
/**
 * check-egress.mjs — static egress check against tools/egress-manifest.json (ADR-0003, ADR-0008).
 *
 *   node tools/check-egress.mjs            exit 0 = every URL literal is allowed, 1 = findings
 *
 * For each process with source roots (recorder, mcp), every http(s):// literal
 * in a source file must name a host listed for that process (`hosts` or
 * `conditionalHosts`). A literal whose host is an interpolation
 * (`https://${host}/…`) cannot be verified and is a finding too — write the
 * host literally.
 *
 * Reserved names never reach a third party and are allowed anywhere: the
 * RFC 6761 special-use TLDs (.test, .invalid, .example, .localhost) and the
 * RFC 2606 documentation domains (example.com / .net / .org). A process with
 * `loopbackListen: true` (the local PWA launcher) may also name its own
 * 127.0.0.1 listen address, port included. Inside test
 * files (a test/ or __tests__/ folder, or *.test.*) single-label hosts such as
 * "https://x" are allowed too: they are fixtures for URL-rejection tests and
 * no test reaches the network (fetch is mocked).
 *
 * Also verifies that the manifest's `web.csp` list matches CONNECT_SRC in
 * apps/confluence/web/src/lib/csp.ts, so the one-page overview cannot drift
 * from what the app actually enforces (release-check R8 guards csp.ts itself),
 * and (v2.8 WP20, licence audit) that every CSP_HOSTS host is in `web.hosts`.
 *
 * Release-check hook (to be added in tools/release-check.mjs):
 *   const { checkEgress, formatEgressFindings } = await import("./check-egress.mjs");
 *   const eg = checkEgress();
 *   check("R11", "Recorder/MCP egress limited to tools/egress-manifest.json", eg.ok, formatEgressFindings(eg));
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_EXT = /\.(mjs|cjs|js|ts|mts|cts|tsx|jsx|json)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "out", "dist", "coverage", "recorder-data", ".turbo"]);
// Scheme, then the authority up to the first "/", "?", "#", quote, space or backslash.
const URL_RE = /\b(?:https?|wss):\/\/([^\s/?#"'`<>\\]+)/gi;
const RESERVED_HOST = /(^|\.)(test|invalid|example|localhost)(:\d+)?$|(^|\.)example\.(com|net|org)(:\d+)?$/i;
const SINGLE_LABEL = /^[a-z0-9-]+(:\d+)?$/i;
const isTestFile = (p) => /(^|[\\/])(test|tests|__tests__)[\\/]/.test(p) || /\.test\.[cm]?[jt]sx?$/.test(p);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (SOURCE_EXT.test(name) && st.size < 5 * 1024 * 1024) yield p;
  }
}

function hostOf(authority) {
  const host = authority.replace(/^[^@]*@/, "").toLowerCase(); // drop user:pass@
  return host.replace(/[.,;:)\]}]+$/, ""); // trailing punctuation from prose ("…api.bybit.com).")
}

/**
 * @param {{ root?: string, manifestPath?: string, processes?: string[], roots?: Record<string, string[]> }} [options]
 *   `roots` overrides a process's source roots (absolute or relative to `root`) — used by tests.
 * @returns {{ ok: boolean, findings: {process: string, file: string, line: number, url: string, host: string, reason: string}[], scanned: number, skippedRoots: string[], cspDrift: string[], webHostDrift: string[] }}
 */
export function checkEgress({ root = ROOT, manifestPath = join(root, "tools", "egress-manifest.json"), processes, roots = {} } = {}) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const procs = manifest.processes ?? {};
  const findings = [];
  const skippedRoots = [];
  let scanned = 0;

  for (const name of processes ?? Object.keys(procs)) {
    const proc = procs[name];
    if (!proc) {
      findings.push({ process: name, file: relative(root, manifestPath), line: 0, url: "", host: "", reason: "process missing from manifest" });
      continue;
    }
    const allowed = new Set([...(proc.hosts ?? []), ...Object.keys(proc.conditionalHosts ?? {})].map((h) => h.toLowerCase()));
    const websocketAllowed = new Set((proc.websocketHosts ?? []).map((h) => h.toLowerCase()));
    for (const r of roots[name] ?? proc.roots ?? []) {
      const dir = resolve(root, r);
      if (!existsSync(dir)) {
        skippedRoots.push(r); // e.g. apps/confluence/mcp before it exists
        continue;
      }
      // A root may be a single file (e.g. a Node tool) or a folder.
      for (const file of statSync(dir).isDirectory() ? walk(dir) : [dir]) {
        scanned++;
        const testFile = isTestFile(relative(root, file));
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((text, i) => {
          for (const m of text.matchAll(URL_RE)) {
            const dynamic = m[1].includes("$");
            const host = dynamic ? m[1] : hostOf(m[1]);
            let reason = null;
            // v2.6: a local server's own listen address (loopback, any port) is not egress.
            if (proc.loopbackListen && /^127\.0\.0\.1(:|$)/.test(m[1])) reason = null;
            else if (dynamic) reason = "host is built at runtime; write it literally";
            else if (RESERVED_HOST.test(host) || (testFile && SINGLE_LABEL.test(host))) reason = null;
            else if (!(m[0].toLowerCase().startsWith("wss:") ? websocketAllowed : allowed).has(host)) reason = `host not allowed for process "${name}"`;
            if (reason) findings.push({ process: name, file: relative(root, file).split(sep).join("/"), line: i + 1, url: m[0], host, reason });
          }
        });
      }
    }
  }

  // Overview drift: manifest web.csp must equal CONNECT_SRC in csp.ts (+ Tauri-only ipc entries).
  const cspDrift = [];
  const webHostDrift = [];
  const cspFile = join(root, "apps", "confluence", "web", "src", "lib", "csp.ts");
  if (procs.web?.csp && existsSync(cspFile)) {
    // v2.7: CONNECT_SRC is built from the public-host table (src/lib/public-hosts.ts CSP_HOSTS).
    const hostsFile = join(root, "apps", "confluence", "web", "src", "lib", "public-hosts.ts");
    const table = (readFileSync(hostsFile, "utf8").match(/export const CSP_HOSTS = \[([\s\S]*?)\] as const;/) || [, ""])[1];
    const block = ["'self'", ...[...table.matchAll(/origin:\s*"([^"]+)"/g)].map((m) => m[1])].map((h) => `"${h}"`).join(", ");
    const fromCsp = new Set([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const listed = new Set(procs.web.csp);
    for (const h of fromCsp) if (!listed.has(h)) cspDrift.push(`csp.ts has ${h}, manifest web.csp does not`);
    for (const h of listed) if (!fromCsp.has(h) && h !== "ipc:" && h !== "http://ipc.localhost") cspDrift.push(`manifest web.csp has ${h}, csp.ts does not`);
    // v2.8 WP20: the host overview (web.hosts, no scheme) names every host the WebView may fetch.
    const hosts = new Set((procs.web.hosts ?? []).map((h) => h.toLowerCase()));
    for (const m of table.matchAll(/origin:\s*"([^"]+)"/g)) {
      const h = m[1].replace(/^(?:https?|wss):\/\//, "").toLowerCase();
      if (!hosts.has(h)) webHostDrift.push(`${h} is in CSP_HOSTS but not in web.hosts`);
    }
  }

  return { ok: findings.length === 0 && cspDrift.length === 0 && webHostDrift.length === 0, findings, scanned, skippedRoots, cspDrift, webHostDrift };
}

export function formatEgressFindings(result) {
  if (result.ok) return `${result.scanned} files scanned${result.skippedRoots.length ? `; not present: ${result.skippedRoots.join(", ")}` : ""}`;
  return [
    ...result.findings.slice(0, 10).map((f) => `${f.file}:${f.line} ${f.url} (${f.reason})`),
    ...result.cspDrift,
    ...(result.webHostDrift ?? []),
    result.findings.length > 10 ? `… ${result.findings.length - 10} more` : "",
  ].filter(Boolean).join(" | ");
}

// CLI (also works when invoked with a relative or Windows path).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkEgress();
  console.log(`${result.ok ? "PASS" : "FAIL"}  egress  ${formatEgressFindings(result)}`);
  for (const f of result.findings) console.log(`  ${f.process}: ${f.file}:${f.line}  ${f.url}  — ${f.reason}`);
  for (const d of result.cspDrift) console.log(`  web: ${d}`);
  for (const d of result.webHostDrift) console.log(`  web: ${d}`);
  process.exit(result.ok ? 0 : 1);
}
