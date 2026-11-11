// v2.1 — origin policy for the localhost gateway (Tauri origins allowed; null/foreign refused).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = 18787 + Math.floor(Math.random() * 500);
const TOKEN = "test-token-0123456789abcdef";

async function withServer(fn, recorderDir = "") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./server.mjs", import.meta.url))], {
    env: { ...process.env, CONFLUENCE_GATEWAY_PORT: String(PORT), CONFLUENCE_GATEWAY_TOKEN: TOKEN, CONFLUENCE_RECORDER_DIR: recorderDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(`http://127.0.0.1:${PORT}/profiles`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    await fn();
  } finally {
    child.kill();
  }
}

const get = (origin) => fetch(`http://127.0.0.1:${PORT}/profiles`, {
  headers: { ...(origin ? { Origin: origin } : {}), Authorization: `Bearer ${TOKEN}` },
});

test("gateway origin policy", async () => {
  await withServer(async () => {
    for (const ok of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://127.0.0.1:8770"]) {
      const r = await get(ok);
      assert.equal(r.status, 200, `${ok} should be allowed`);
      assert.equal(r.headers.get("access-control-allow-origin"), ok);
    }
    for (const bad of ["null", "https://evil.example", "http://tauri.localhost.evil.example", "capacitor://localhost"]) {
      const r = await get(bad);
      assert.equal(r.status, 403, `${bad} should be refused`);
    }
    assert.equal((await get(null)).status, 403, "missing Origin is refused");
  });
});

test("recorder sync is opt-in, authenticated and uses fixed filenames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "confluence-gateway-"));
  const headers = { Origin: "http://127.0.0.1:8770", Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" };
  const url = "http://127.0.0.1:" + PORT + "/recorder/";
  const rule = { id: "fixture", source: "binance", timeframe: "4h", symbols: ["BTCUSDT"], threshold: 70 };
  try {
    await withServer(async () => {
      assert.equal((await fetch(url + "inbox", { headers })).status, 404);
    });
    await withServer(async () => {
      assert.equal((await fetch(url + "inbox", { headers: { Origin: headers.Origin } })).status, 401);
      const bad = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [{ ...rule, symbols: ["../x"] }] }) });
      assert.equal(bad.status, 400);
      const deployed = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [rule] }) });
      assert.equal(deployed.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace-rules.json"), "utf8")).rules, [rule]);
      const second = { ...rule, id: "second", threshold: 55 };
      const updated = await fetch(url + "rules", { method: "POST", headers, body: JSON.stringify({ version: 1, rules: [second] }) });
      assert.equal(updated.status, 200);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace-rules.json"), "utf8")).rules, [rule, second]);
      const inbox = { version: 1, events: [{ id: "fixture" }] };
      writeFileSync(join(dir, "workspace-inbox.json"), JSON.stringify(inbox));
      assert.deepEqual(await (await fetch(url + "inbox", { headers })).json(), inbox);
    }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
