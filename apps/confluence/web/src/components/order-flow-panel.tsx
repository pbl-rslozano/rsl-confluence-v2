"use client";

import { useEffect, useRef, useState } from "react";
import { fetchBybitLinearTrades, fetchOrderBook, type OrderBook } from "@/lib/market-client";
import { DepthHeatmap } from "./depth-heatmap";
import { reconstructDepth } from "@/lib/depth-replay";
import { readLiquidations, type Liquidation, type PublicTrade } from "@/lib/order-flow";

type Frame = { at: number; book: OrderBook; trades: PublicTrade[] } | { at: number; error: string };

export function OrderFlowPanel({ pair }: { pair: string }) {
  const [liquidations, setLiquidations] = useState<Liquidation[]>([]);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [importStatus, setImportStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  async function capture() {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const [depth, trades] = await Promise.all([
        fetchOrderBook("bybit-perp", pair, controller.signal),
        fetchBybitLinearTrades(pair, controller.signal),
      ]);
      if (!depth.bids.length || !depth.asks.length) throw new Error("Incomplete order book");
      if (!controller.signal.aborted) setFrames((previous) => [...previous, {
        at: Date.now(), book: { bids: depth.bids.slice(0, 15), asks: depth.asks.slice(0, 15) }, trades,
      }].slice(-60));
    } catch (error) {
      if (!controller.signal.aborted) setFrames((previous) => [...previous, {
        at: Date.now(), error: error instanceof Error ? error.message : "Capture failed",
      }].slice(-60));
    } finally {
      if (!controller.signal.aborted) {
        controller.abort();
        request.current = null;
        setSelected(null);
        setBusy(false);
      }
    }
  }

  async function importDepth(file: File) {
    if (request.current) return;
    setBusy(true);
    try {
      if (file.size > 8_000_000) throw new Error("Choose a depth capture under 8 MB.");
      const messages = (await file.text()).split(/\r?\n/).filter((line) => line.trim());
      if (messages.length > 2000) throw new Error("Choose a capture with at most 2,000 messages.");
      const parsed = messages.map((line) => JSON.parse(line));
      const replay = reconstructDepth(parsed, pair);
      if (!replay.length) throw new Error("No depth messages for " + pair + ".");
      setFrames(replay.map((frame): Frame => frame.gap
        ? { at: frame.at, error: "Waiting for a valid replacement snapshot" }
        : { at: frame.at, book: { bids: frame.bids, asks: frame.asks }, trades: [] }));
      setLiquidations(readLiquidations(parsed, pair));
      setSelected(0);
      setImportStatus("Depth capture loaded.");
    } catch (error) {
      setImportStatus(error instanceof Error ? error.message : "Depth import failed.");
    } finally {
      setBusy(false);
    }
  }

  const index = selected ?? frames.length - 1;
  const frame = frames[index];
  return (
    <section aria-label="Bybit order flow" className="space-y-2 rounded border border-zinc-800 p-3 text-xs">
      <h3 className="font-semibold">Order flow · {pair}</h3>
      <p className="text-zinc-400">Bybit linear snapshots and recent executions. Captures are kept for this panel session.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void capture()} className="rounded border border-zinc-700 px-2 py-1">
          {busy ? "Capturing…" : "Capture order flow"}
        </button>
        <button type="button" disabled={index <= 0} onClick={() => setSelected(index - 1)}>Previous capture</button>
        <button type="button" disabled={index >= frames.length - 1} onClick={() => setSelected(index + 1)}>Next capture</button>
      </div>
      <label className="block">Import sequenced depth JSONL
        <input type="file" accept=".jsonl" disabled={busy} className="block max-w-full" onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void importDepth(file);
        }} />
      </label>
      {importStatus && <p role="status">{importStatus}</p>}
      {frame && (
        <p aria-live="polite">Capture {index + 1} of {frames.length} · {new Date(frame.at).toISOString()}</p>
      )}
      {frames.length > 1 && <DepthHeatmap frames={frames} selected={index} liquidations={liquidations} />}
      {liquidations.length > 0 && (
        <details className="rounded border border-zinc-800 p-2">
          <summary>Observed liquidations · {liquidations.length}</summary>
          <p className="text-zinc-400">Bybit reports the bankruptcy price for each event.</p>
          <ul className="max-h-40 overflow-auto">
            {liquidations.filter((event) => frame && event.time <= frame.at).slice(-50).reverse().map((event) => (
              <li key={event.id}>{new Date(event.time).toISOString()} · {event.side} · {event.size} at {event.price}</li>
            ))}
          </ul>
        </details>
      )}
      {frame && ("error" in frame ? <p role="status" className="text-amber-300">Capture gap · {frame.error}</p> : (
        <div className="grid gap-3 sm:grid-cols-2">
          <table className="w-full tabular-nums">
            <caption className="text-start font-medium">Depth ladder</caption>
            <thead><tr><th scope="col">Side</th><th scope="col">Price</th><th scope="col">Size</th></tr></thead>
            <tbody>
              {[...frame.book.asks].reverse().map(([price, size]) => <tr key={"ask-" + price}><td>Ask</td><td>{price}</td><td>{size}</td></tr>)}
              {frame.book.bids.map(([price, size]) => <tr key={"bid-" + price}><td>Bid</td><td>{price}</td><td>{size}</td></tr>)}
            </tbody>
          </table>
          <table className="w-full tabular-nums">
            <caption className="text-start font-medium">Recent trades</caption>
            <thead><tr><th scope="col">Time</th><th scope="col">Side</th><th scope="col">Price</th><th scope="col">Size</th></tr></thead>
            <tbody>{frame.trades.map((trade) => <tr key={trade.id}>
              <td>{new Date(trade.time).toISOString().slice(11, 23)}</td><td>{trade.side}</td><td>{trade.price}</td><td>{trade.size}</td>
            </tr>)}</tbody>
          </table>
        </div>
      ))}
    </section>
  );
}
