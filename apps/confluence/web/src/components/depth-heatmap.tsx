import { useMemo } from "react";
import { buildDepthHeatmap, HEATMAP_ROWS } from "@/lib/depth-heatmap";
import type { Liquidation } from "@/lib/order-flow";
import type { OrderBook } from "@/lib/market-client";

export function DepthHeatmap({ frames, selected, liquidations }: {
  frames: ({ at: number; book: OrderBook } | { at: number; error: string })[];
  liquidations: Liquidation[];
  selected: number;
}) {
  const { columns, maximum, low, high, hasDepth } = useMemo(
    () => buildDepthHeatmap(frames.map((frame) => "book" in frame ? frame.book : null)), [frames],
  );
  if (!hasDepth) return null;

  const width = 600;
  const height = 144;
  const cellWidth = width / columns.length;
  const cellHeight = height / HEATMAP_ROWS;
  const gaps = columns.filter((column) => column === null).length;
  return (
    <figure className="space-y-1 rounded border border-zinc-800 p-2">
      <figcaption className="font-medium">Depth heatmap · {columns.length} captures · {gaps} gaps</figcaption>
      <div className="flex gap-2">
        <div className="flex flex-col justify-between text-zinc-400">
          <span>{high}</span><span>{low}</span>
        </div>
        <svg role="img" aria-label="Resting liquidity by price and capture, oldest to newest"
          viewBox={`0 0 ${width} ${height}`} className="min-w-0 flex-1 bg-zinc-950">
          {columns.map((cells, index) => cells === null
            ? <rect key={index} x={index * cellWidth} width={cellWidth} height={height} fill="#71717a" data-depth-gap="true" />
            : <g key={index}>
                {cells.map((cell) => <rect key={cell.side + cell.row} x={index * cellWidth}
                  y={cell.row * cellHeight} width={cellWidth} height={cellHeight}
                  fill={cell.side === "bid" ? "#34d399" : "#fb7185"}
                  opacity={0.12 + 0.88 * Math.sqrt(cell.size / maximum)} />)}
              </g>)}
          {liquidations.map((event) => {
            if (event.time < frames[0].at || event.time > frames[frames.length - 1].at) return null;
            const column = frames.findIndex((frame) => frame.at >= event.time);
            if (column < 0 || columns[column] === null) return null;
            return <circle key={event.id} data-liquidation-side={event.side}
              cx={(column + 0.5) * cellWidth} cy={event.side === "long" ? 5 : 14} r={3}
              fill={event.side === "long" ? "#fbbf24" : "#a78bfa"}>
              <title>{event.side} liquidation · {event.size} at bankruptcy price {event.price}</title>
            </circle>;
          })}
          <rect x={selected * cellWidth} width={cellWidth} height={height}
            fill="none" stroke="var(--color-zinc-100)" strokeWidth={1} />
        </svg>
      </div>
      <p className="text-zinc-400">Oldest to newest by capture · green bid · pink ask · gray gap. Brighter cells hold more size. Amber and purple dots mark long and short liquidations.</p>
    </figure>
  );
}
