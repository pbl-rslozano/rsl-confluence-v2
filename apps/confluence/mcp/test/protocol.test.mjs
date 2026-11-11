// Protocol round-trip: spawn the real stdio server and speak newline-delimited JSON-RPC.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture } from "../test-support/fixture.mjs";
import { DISCLAIMER, SERVER_NAME, SERVER_VERSION } from "../src/server.mjs";
import { parseArgs } from "../src/cli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "src", "cli.mjs");
const REPO = resolve(here, "..", "..", "..", "..");
const cleanup = [];
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function startServer(args, env = {}, nodeFlags = []) {
  const child = spawn(process.execPath, [...nodeFlags, CLI, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
  children.push(child);
  let buf = "";
  const stdoutLines = [];
  const waiters = new Map();
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      stdoutLines.push(line);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      if (msg.id !== undefined && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); }
    }
  });
  let nextId = 1;
  const request = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    const timer = setTimeout(() => rej(new Error(`timeout waiting for ${method}; stderr: ${stderr}`)), 15_000);
    waiters.set(id, (m) => { clearTimeout(timer); res(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const stop = () => new Promise((res) => { child.on("exit", (code) => res(code)); child.stdin.end(); });
  return { child, request, notify, stop, stdoutLines, stderr: () => stderr };
}

async function roundTrip(t, srv) {
  const init = await srv.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "protocol-test", version: "1.0.0" } });
  assert.equal(init.result.serverInfo.name, SERVER_NAME);
  assert.equal(init.result.serverInfo.version, SERVER_VERSION);
  assert.equal(init.result.protocolVersion, "2025-11-25");
  assert.ok(init.result.capabilities.tools);
  assert.match(init.result.instructions, /Read-only/);
  srv.notify("notifications/initialized", {});

  const list = await srv.request("tools/list", {});
  assert.equal(list.result.tools.length, 7);

  const ov = await srv.request("tools/call", { name: "ledger_overview", arguments: {} });
  const text = ov.result.content[0].text;
  assert.ok(text.endsWith(DISCLAIMER));
  assert.equal(JSON.parse(text.slice(0, -DISCLAIMER.length)).rows > 0, true);

  const perf = await srv.request("tools/call", { name: "performance_report", arguments: { engine_id: "aaaaaaaaaaaaaaaa", source: "binance", horizons: [6], shuffles: 0 } });
  assert.ok(!perf.result.isError, perf.result.content[0].text.slice(0, 300));
  assert.ok(perf.result.content[0].text.endsWith(DISCLAIMER));

  const badArgs = await srv.request("tools/call", { name: "query_ledger", arguments: { limit: "ten" } });
  assert.equal(badArgs.result.isError, true);
  assert.ok(badArgs.result.content[0].text.endsWith(DISCLAIMER));

  const unknown = await srv.request("tools/call", { name: "place_order", arguments: { pair: "BTCUSDT" } });
  assert.equal(unknown.result.isError, true);
  assert.ok(unknown.result.content[0].text.endsWith(DISCLAIMER));

  const ping = await srv.request("ping", {});
  assert.deepEqual(ping.result, {});
  const code = await srv.stop();
  assert.equal(code, 0);
  assert.ok(srv.stdoutLines.length >= 7);
  assert.match(srv.stderr(), /ready/);
}

test("stdio round-trip: initialize, tools/list, tools/call (data dir via --data)", async (t) => {
  const fx = await buildFixture();
  cleanup.push(fx.dir);
  await roundTrip(t, startServer(["--data", fx.dir]));
});

test("stdio round-trip with CONFLUENCE_DATA_DIR under Node's permission model (fs read-only except trials.jsonl, no child processes)", async (t) => {
  const fx = await buildFixture();
  cleanup.push(fx.dir);
  const flags = ["--permission", `--allow-fs-read=${REPO}`, `--allow-fs-read=${fx.dir}`, `--allow-fs-write=${join(fx.dir, "trials.jsonl")}`];
  const srv = startServer([], { CONFLUENCE_DATA_DIR: fx.dir }, flags);
  const init = await srv.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "perm", version: "1" } });
  assert.equal(init.result.serverInfo.name, SERVER_NAME);
  srv.notify("notifications/initialized", {});
  const perf = await srv.request("tools/call", { name: "performance_report", arguments: { engine_id: "aaaaaaaaaaaaaaaa", source: "binance", horizons: [1], shuffles: 0 } });
  assert.ok(!perf.result.isError, perf.result.content[0].text.slice(0, 400));
  const logged = await srv.request("tools/call", { name: "log_trial", arguments: { hypothesis: "Logged under the permission model", metric: "m1" } });
  assert.ok(!logged.result.isError, logged.result.content[0].text);
  assert.equal(await srv.stop(), 0);
});

test("CLI: refuses to start without a valid data directory; parses options", () => {
  const none = spawnSync(process.execPath, [CLI], { env: { ...process.env, CONFLUENCE_DATA_DIR: "" }, encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /No data directory/);
  assert.equal(none.stdout, "", "nothing on stdout");
  const missing = spawnSync(process.execPath, [CLI, "--data", "/definitely/not/here"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  const unknown = spawnSync(process.execPath, [CLI, "--data", here, "--trade"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option/);
  const a = parseArgs(["--data=/x", "--max-file-mb", "10", "--max-rows", "5"], {});
  assert.equal(a.data, "/x");
  assert.equal(a.limits.maxStreamBytes, 10 * 1024 * 1024);
  assert.equal(a.limits.maxRows, 5);
  assert.equal(parseArgs([], { CONFLUENCE_DATA_DIR: "/env" }).data, "/env");
  assert.throws(() => parseArgs(["--max-json-mb", "-1"], {}), /positive/);
});
