"use client";

/**
 * About → the optional rsL Coffee Kit tip card (owner request, 15 Nov 2026). Collapsed by default; it is the only
 * entry point, never opens by itself and gates nothing. Everything shown — wording, card images, Copy label — comes
 * from coffee-kit.json unchanged ({appName} replaced). Only the frame follows the app theme; the card PNGs are shown
 * whole at 600 × 868, never cropped, overlaid or recoloured. GCash and PayPal are scan-only; only a method with a
 * copyValue (Bitcoin) gets a Copy button.
 */
import KIT_JSON from "../coffee-kit.json";
import { coffeeAlt, coffeeCardSrc, coffeeText, copyToClipboard, type CoffeeKit } from "../coffee-kit";

const KIT = KIT_JSON as CoffeeKit;
const HEADING = { fontFamily: "var(--font-brand)" } as const;
const BODY = { fontFamily: "var(--font-ui)" } as const;

export function CoffeeSection() {
  return (
    <details data-testid="about-coffee" data-kit-version={KIT.kitVersion} className="mt-4 rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400" style={BODY}>
      <summary className="cursor-pointer select-none text-sm font-semibold text-zinc-200" lang="en" dir="ltr">
        <span style={HEADING}>☕ {coffeeText(KIT.buttonLabel)}</span>
        <span className="ms-2 inline-block text-[11px] font-normal text-zinc-500">{coffeeText(KIT.buttonNote)}</span>
      </summary>
      <div lang="en" dir="ltr">
        <p className="mt-2 leading-relaxed">{coffeeText(KIT.intro)}</p>
        <div className="mt-3 grid justify-items-center gap-4" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))" }}>
          {KIT.methods.map((m) => (
            <figure key={m.id} data-coffee-method={m.id} className="m-0 flex w-full max-w-[280px] flex-col items-center gap-1 text-center">
              <img
                src={coffeeCardSrc(m)}
                alt={coffeeAlt(m)}
                width={m.cardPixels[0]}
                height={m.cardPixels[1]}
                loading="lazy"
                decoding="async"
                draggable={false}
                style={{ display: "block", width: "100%", maxWidth: 280, height: "auto", borderRadius: 14 }}
              />
              <figcaption className="mt-1 space-y-0.5">
                <span className="block text-sm font-semibold text-zinc-200" style={HEADING}>{coffeeText(m.name)}</span>
                <span className="block text-zinc-300">{coffeeText(m.shownLine)}</span>
                <span className="block text-zinc-500">{coffeeText(m.hint)}</span>
              </figcaption>
              {m.copyValue !== null && (
                <button type="button" data-coffee-copy={m.id}
                  className="mt-1 inline-flex h-11 items-center justify-center rounded-md border border-zinc-700 px-3 text-sm text-zinc-200 hover:bg-zinc-800"
                  onClick={() => void copyToClipboard(m.copyValue as string)}>
                  {coffeeText(m.copyLabel ?? "")}
                </button>
              )}
            </figure>
          ))}
        </div>
        <p className="mt-3 text-center text-zinc-300">{coffeeText(KIT.footer)}</p>
      </div>
    </details>
  );
}
