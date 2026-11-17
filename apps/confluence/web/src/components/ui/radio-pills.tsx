"use client";

import { useRef } from "react";

/**
 * Radio pills with roving tab index and arrow-key navigation (WAI-ARIA radio group pattern; arrows follow the
 * reading direction in RTL). Shared by the ledger dialog and the Scenarios section (v2.8). `testId` sets
 * `data-testid` on the group; without it the markup is exactly the ledger's v2.7 markup.
 */
export function RadioPills<T extends string | number>({ label, value, options, onChange, testId }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; testId?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (from: number, delta: number) => {
    const next = (from + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex flex-wrap gap-1">
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          tabIndex={value === o.value ? 0 : -1}
          onClick={() => onChange(o.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, document.dir === "rtl" && e.key === "ArrowRight" ? -1 : 1); }
            else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, document.dir === "rtl" && e.key === "ArrowLeft" ? 1 : -1); }
          }}
          className={`rsl-touch min-h-8 rounded-md border px-2 text-xs ${value === o.value ? "border-cyan-400 bg-cyan-500/10 text-cyan-200" : "border-zinc-700 text-zinc-300"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
