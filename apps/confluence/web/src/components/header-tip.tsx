"use client";

/**
 * v2.8 header (owner decision 16 Nov 2026): at ≥ 1280 px the secondary header buttons are icon-only. Hovering shows
 * their native `title`; `HeaderTip` adds the same name as a tooltip on keyboard focus (`:focus-visible`), which a
 * native `title` never shows. It uses the app's Tooltip component and opens only on keyboard focus, so a mouse user
 * never sees two tooltips. Below 1280 px the child renders unchanged (no wrapper, no tooltip).
 */
import { useState, type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/lib/use-media-query";

/** Tailwind `xl` (1280 px): the two-line header ribbon with icon buttons. */
export const WIDE_HEADER_QUERY = "(min-width: 1280px)";

export function HeaderTip({ label, children }: { label: string; children: ReactElement }) {
  const wide = useMediaQuery(WIDE_HEADER_QUERY);
  const [open, setOpen] = useState(false);
  if (!wide) return children;
  return (
    <Tooltip open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <TooltipTrigger
        asChild
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
        onBlur={() => setOpen(false)}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="border border-zinc-700 bg-zinc-900 text-xs text-zinc-100">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
