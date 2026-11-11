"use client";

import { useCallback, useEffect, useState } from "react";
import { PriceChart } from "@/components/price-chart";
import { newBook } from "@/lib/paper-broker";
import { advanceReplayTrade, queueReplayTrade, type ReplayInstrument } from "@/lib/replay-paper";
import type { Kline } from "@/lib/indicators";

export function ChartReplay({ candles: sourceCandles, startAt, visible = 250, instrument }: {
  candles: Kline[];
  startAt?: number;
  visible?: number;
  instrument?: ReplayInstrument;
}) {
  const [candles] = useState(sourceCandles);
  const [position, setPosition] = useState(() => {
    const first = startAt === undefined ? -1 : candles.findIndex((bar) => bar.time >= startAt);
    return first < 0 ? Math.min(60, Math.max(2, candles.length - 1)) : Math.max(2, first + 1);
  });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [session, setSession] = useState(() => ({ book: newBook(candles[0]?.time ?? 0), ambiguousIds: [] as string[] }));
  const [side, setSide] = useState<"long" | "short">("long");
  const [size, setSize] = useState("1");
  const [stop, setStop] = useState("1");
  const [target, setTarget] = useState("2");
  const [message, setMessage] = useState("");
  const count = Math.min(position, candles.length);

  const advance = useCallback(() => {
    const bar = candles[count];
    if (!bar) return;
    if (instrument) setSession((current) => {
      if (!current.book.positions.length) return current;
      const result = advanceReplayTrade(current.book, instrument, bar);
      const closed = result.book.journal.at(-1);
      return { book: result.book, ambiguousIds: result.ambiguous && closed
        ? [...current.ambiguousIds, closed.id] : current.ambiguousIds };
    });
    setPosition(count + 1);
  }, [candles, count, instrument]);

  function queue() {
    if (!instrument || !candles[count - 1] || count >= candles.length) return;
    const book = queueReplayTrade(session.book, instrument, candles[count - 1], side, Number(size), Number(stop), Number(target));
    if (book) {
      setPlaying(false);
      setSession({ ...session, book });
      setMessage("Queued for the next eligible candle open.");
    } else setMessage("Enter a positive size and stop and target distances below 100%.");
  }

  useEffect(() => {
    if (!playing || count >= candles.length) return;
    const timer = window.setTimeout(advance, 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, count, candles.length, speed, advance]);

  if (candles.length < 2) return <p>Not enough saved candles to replay.</p>;

  return (
    <section aria-label="Chart replay" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <button type="button" disabled={count >= candles.length} onClick={() => setPlaying(!playing)}
          className="rounded border border-zinc-700 px-2 py-1">{playing && count < candles.length ? "Pause replay" : "Play replay"}</button>
        <button type="button" disabled={count >= candles.length} onClick={() => { setPlaying(false); advance(); }}
          className="rounded border border-zinc-700 px-2 py-1">Next bar</button>
        <label>Speed <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}
          className="rounded border border-zinc-700 bg-zinc-900 p-1">
          {[1, 2, 4].map((value) => <option key={value} value={value}>{value}×</option>)}
        </select></label>
        <span data-testid="replay-position" data-bar-count={count} aria-live="polite">
          Bar {count} of {candles.length} · {new Date(candles[count - 1].time).toLocaleString()}
        </span>
      </div>
      {instrument && (
        <section aria-label="Replay paper account" className="space-y-2 rounded border border-zinc-800 p-2 text-xs">
          <p>Replay paper session · simulated fills at the next eligible bar open.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label>Side <select value={side} onChange={(event) => setSide(event.target.value === "short" ? "short" : "long")}
              className="rounded bg-zinc-900 p-1"><option value="long">Long</option><option value="short">Short</option></select></label>
            <label>Size <input type="number" min="0" step="any" value={size} onChange={(event) => setSize(event.target.value)} className="w-16 rounded bg-zinc-900 p-1" /></label>
            <label>Stop % <input type="number" min="0" step="any" value={stop} onChange={(event) => setStop(event.target.value)} className="w-16 rounded bg-zinc-900 p-1" /></label>
            <label>Target % <input type="number" min="0" step="any" value={target} onChange={(event) => setTarget(event.target.value)} className="w-16 rounded bg-zinc-900 p-1" /></label>
            <button type="button" disabled={!!session.book.positions.length || count >= candles.length} onClick={queue}
              className="rounded border border-zinc-700 px-2 py-1">Queue replay trade</button>
          </div>
          {message && <p role="status">{message}</p>}
          {session.book.positions.map((trade) => <p key={trade.id}>
            {trade.status === "pending" ? "Pending fill" : "Filled at " + trade.entry} · {trade.side} · {trade.size}
          </p>)}
          <ul aria-label="Replay trade journal">
            {session.book.journal.map((trade) => <li key={trade.id}>
              {trade.side} · {trade.entry} → {trade.exit} · {trade.reason} · net P&amp;L {trade.pnl.toFixed(2)}
              {session.ambiguousIds.includes(trade.id) && " · Stop and target touched in one candle. Stop assumed first."}
            </li>)}
          </ul>
        </section>
      )}
      <PriceChart klines={candles.slice(0, count)} visible={visible} />
    </section>
  );
}
