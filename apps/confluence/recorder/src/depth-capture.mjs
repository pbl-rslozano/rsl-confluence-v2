export function reconcileDepth(snapshot, buffered) {
  const match = buffered.findIndex((row) => row.u === snapshot.u && row.seq === snapshot.seq);
  if (match < 0) return null;
  const tail = buffered.slice(match + 1);
  let previous = snapshot;
  for (const row of tail) {
    if (row.u !== previous.u + 1 || row.seq < previous.seq) return null;
    previous = row;
  }
  return tail;
}

export function normalizeDepth(pair, type, data, at) {
  if (data?.s !== pair || !Number.isSafeInteger(data.u) || data.u < 1 ||
      !Number.isSafeInteger(data.seq) || data.seq < 1 || !Number.isFinite(at) ||
      !Array.isArray(data.b) || !Array.isArray(data.a)) return null;
  return { pair, type, at, u: data.u, seq: data.seq, bids: data.b, asks: data.a };
}

export async function captureWithReconnect({ deadline, now, wait, recordGap, captureSegment }) {
  for (let retry = 0; now() < deadline; retry++) {
    const reason = await captureSegment();
    if (reason === "duration limit" || reason === "capture size limit" || reason === "subscription refused") return reason;
    if (!recordGap(reason)) return "capture size limit";
    if (retry >= 3) return "reconnect limit";
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await wait(Math.min(500 * 2 ** retry, remaining));
  }
  return "duration limit";
}

export function normalizeLiquidations(pair, message) {
  if (!Number.isSafeInteger(message?.ts) || !Array.isArray(message.data)) return [];
  return message.data.flatMap((event, index) => {
    if (event?.s !== pair || !Number.isSafeInteger(event.T) || event.T <= 0 ||
        (event.S !== "Buy" && event.S !== "Sell")) return [];
    const price = Number(event.p);
    const size = Number(event.v);
    if (![price, size].every((value) => Number.isFinite(value) && value > 0)) return [];
    return [{ id: pair + "|" + message.ts + "|" + index, type: "liquidation", pair,
      at: message.ts, time: event.T, side: event.S === "Buy" ? "long" : "short", price, size }];
  });
}
