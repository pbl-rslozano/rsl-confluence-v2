import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createGuardedFetch, getJson, loadRecorderManifest } from "./src/net.mjs";
import { captureWithReconnect, normalizeDepth, normalizeLiquidations, reconcileDepth } from "./src/depth-capture.mjs";

const [pair, file, duration = "30"] = process.argv.slice(2);
if (!/^[A-Z0-9]{2,30}$/.test(pair ?? "") || !file?.endsWith(".jsonl") ||
    !/^\d+$/.test(duration) || Number(duration) < 5 || Number(duration) > 120) {
  console.error("Usage: pnpm capture-depth BTCUSDT capture.jsonl [seconds 5–120]");
  process.exit(2);
}

const endpoint = "wss://stream.bybit.com/v5/public/linear";
const { hosts, websocketHosts } = loadRecorderManifest();
if (!websocketHosts.includes(new URL(endpoint).hostname)) throw new Error("Bybit websocket is outside the recorder allowlist.");
const guard = createGuardedFetch({ hosts, timeoutMs: 5000 });
const topic = "orderbook.full." + pair;
const liquidationTopic = "allLiquidation." + pair;
const recorded = [];
let bytes = 0;
let lastTime = 0;
let hasSnapshot = false;
const deadline = Date.now() + Number(duration) * 1000;

function record(row) {
  const at = Math.max(lastTime, row.at);
  const line = JSON.stringify({ ...row, at }) + "\n";
  const size = Buffer.byteLength(line);
  if (recorded.length >= 2000 || bytes + size > 7_900_000) return false;
  recorded.push(line);
  bytes += size;
  lastTime = at;
  if (row.type === "snapshot") hasSnapshot = true;
  return true;
}

async function captureSegment() {
  const socket = new WebSocket(endpoint);
  const buffered = [];
  let cursor;
  let ended = "";

  function accept(row) {
    if (row.u !== 1 && (row.u <= cursor.u || row.seq < cursor.seq)) return;
    if (!record(row)) { ended = "capture size limit"; return; }
    if (!ended && (row.u === 1 || row.u !== cursor.u + 1)) ended = "sequence gap or reset";
    cursor = row;
  }

  socket.addEventListener("open", () => socket.send(JSON.stringify({ op: "subscribe", args: [topic, liquidationTopic] })));
  socket.addEventListener("error", () => { if (!ended) ended = "websocket error"; });
  socket.addEventListener("close", () => { if (!ended) ended = "websocket disconnected"; });
  socket.addEventListener("message", (event) => {
    if (ended) return;
    try {
      if (typeof event.data !== "string" || event.data.length > 2_000_000) { ended = "invalid message"; return; }
      const message = JSON.parse(event.data);
      if (message.op === "subscribe" && message.success === false) { ended = "subscription refused"; return; }
      if (message.topic === liquidationTopic) {
        if (cursor) {
          for (const event of normalizeLiquidations(pair, message)) {
            if (!record(event)) { ended = "capture size limit"; break; }
          }
        }
        return;
      }
      if (message.topic !== topic) return;
      const row = normalizeDepth(pair, "delta", message.data, message.ts);
      if (!row) { ended = "invalid depth update"; return; }
      if (cursor) accept(row);
      else if (buffered.length >= 2000) ended = "initialization buffer limit";
      else if (row.u === 1 || (buffered.length && row.u !== buffered.at(-1).u + 1)) {
        buffered.length = 0;
        buffered.push(row);
      } else buffered.push(row);
    } catch {
      ended = "malformed websocket message";
    }
  });
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
  }, 20_000);

  try {
    while (!ended && Date.now() < deadline) {
      if (!cursor && buffered.length) {
        guard.clearMemo();
        const response = await getJson(guard.fetch,
          "https://api.bybit.com/v5/market/full_orderbook?category=linear&symbol=" + encodeURIComponent(pair),
          "Bybit full-depth snapshot", AbortSignal.timeout(Math.max(1, deadline - Date.now())));
        const snapshot = normalizeDepth(pair, "snapshot", response.result, response.result?.ts);
        const tail = snapshot && snapshot.bids.length && snapshot.asks.length && reconcileDepth(snapshot, buffered);
        if (!ended && tail) {
          if (!record(snapshot)) { ended = "capture size limit"; break; }
          cursor = snapshot;
          for (const row of tail) {
            if (ended) break;
            accept(row);
          }
        }
      }
      if (!ended) await delay(Math.max(0, Math.min(cursor ? 100 : 750, deadline - Date.now())));
    }
  } catch (error) {
    ended = "snapshot request failed: " + (error instanceof Error ? error.message : String(error));
  } finally {
    clearInterval(heartbeat);
    socket.close();
  }
  return ended || "duration limit";
}

const reason = await captureWithReconnect({
  deadline,
  now: Date.now,
  wait: delay,
  captureSegment,
  recordGap: (failure) => !hasSnapshot || record({ pair, type: "gap", at: lastTime, reason: failure }),
});
if (hasSnapshot) {
  writeFileSync(file, recorded.join(""), { flag: "wx" });
  console.log("Wrote " + recorded.length + " depth messages. End reason: " + reason);
} else {
  console.error("No synchronized depth capture: " + reason);
  process.exitCode = 1;
}
