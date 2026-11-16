"use client";

/**
 * v2.8 header (owner decision 16 Nov 2026): at ≥ 1280 px the secondary header buttons are icon-only. There `HeaderTip`
 *   - adds the native `title` (hover tooltip) with the control's name, and
 *   - shows the same name as a tooltip on keyboard focus (`:focus-visible`), which a native `title` never does. It uses
 *     the app's Tooltip component and opens only on keyboard focus, so a mouse user never sees two tooltips.
 * `label` must be the control's accessible name (or that name without a decorative glyph), so the tooltip is not tied
 * to the control with aria-describedby: a screen reader would read the name twice ("About, button, About"; review M3).
 * Below 1280 px the child renders exactly as before: no wrapper, no tooltip and no added title (review M2). The server
 * snapshot of the media query is false (desktop-first static export), so the first client render matches the
 * prerendered HTML and the title appears after hydration.
 */
import { cloneElement, useState, type ReactElement } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/lib/use-media-query";

/** Tailwind `xl` (1280 px): the two-line header ribbon with icon buttons. */
export const WIDE_HEADER_QUERY = "(min-width: 1280px)";

export function HeaderTip({ label, children }: { label: string; children: ReactElement<{ title?: string }> }) {
  const wide = useMediaQuery(WIDE_HEADER_QUERY);
  const [open, setOpen] = useState(false);
  if (!wide) return children;
  return (
    <Tooltip open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <TooltipTrigger
        asChild
        aria-describedby={undefined}
        onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) setOpen(true); }}
        onBlur={() => setOpen(false)}
      >
        {cloneElement(children, { title: children.props.title ?? label })}
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4} className="border border-zinc-700 bg-zinc-900 text-xs text-zinc-100">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
