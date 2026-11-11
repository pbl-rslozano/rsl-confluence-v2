"use client";

/**
 * Splash — signature art (Convergent Lattice seeded by the app code), localised greeting,
 * then a decode reveal of the workspace name (≤ 900 ms, once per session, skippable,
 * static under reduced motion). Identity skill §3.3.
 */
import { useEffect, useRef, useState } from "react";
import { drawSignature } from "@rsl/core-kit/core/rsl-signature-art.js";
import { greetingKey } from "@rsl/core-kit/core/rsl-identity.js";
import { APP } from "../app-info";
import { BrandBlock } from "./BrandBlock";

const GLYPHS = "▖▗▘▙▚▛▜▝▞▟░▒▓01ABCDEF#%&";
const SESSION_KEY = "rsl-conf-splash-seen";

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

interface SplashValue { t: (k: string, v?: Record<string, unknown>) => string; id: { customer: { legalName: string }; operator: { displayName: string } } }

export function Splash({ ready, value, onDone }: { ready: boolean; value: SplashValue | null; onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [decoded, setDecoded] = useState("");
  const [finished, setFinished] = useState(false);
  const seen = typeof window !== "undefined" && (() => { try { return sessionStorage.getItem(SESSION_KEY) === "1"; } catch { return false; } })();

  // Signature art behind the brand
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(c.clientWidth * dpr);
    c.height = Math.round(c.clientHeight * dpr);
    const ctl = drawSignature(c, { appCode: APP.code });
    return () => ctl.stop();
  }, []);

  // Seen this session or reduced motion → no animation: show the name as soon as boot is ready.
  const instant = seen || reducedMotion();
  const shownName = instant ? (ready && value ? value.id.customer.legalName : "") : decoded;
  const isFinished = instant ? ready : finished;

  // Decode reveal once boot has finished
  useEffect(() => {
    if (!ready || !value || instant) return;
    const target = value.id.customer.legalName;
    const start = performance.now();
    const DURATION = 850;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DURATION);
      const fixed = Math.floor(target.length * p);
      const chars = Array.from(target);
      setDecoded(chars.map((ch, i) => (i < fixed || ch === " " ? ch : GLYPHS[(i * 7 + Math.floor(now / 40)) % GLYPHS.length])).join(""));
      if (p < 1) raf = requestAnimationFrame(tick);
      else setFinished(true);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, value, instant]);

  useEffect(() => {
    if (!isFinished) return;
    try { sessionStorage.setItem(SESSION_KEY, "1"); } catch { /* private mode */ }
    const t = window.setTimeout(onDone, seen || reducedMotion() ? 0 : 350);
    return () => window.clearTimeout(t);
  }, [isFinished, onDone, seen]);

  const name = value?.id.operator.displayName;
  const greeting = value ? (name ? value.t(greetingKey(), { name }) : value.t("greet.anon")) : "";

  return (
    <div className="rsl-splash fixed inset-0 z-[100] flex items-center justify-center bg-[#090F1A] text-white" role="status" aria-busy={!isFinished}>
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full opacity-60" />
      <div className="relative flex flex-col items-center gap-4 rounded-2xl bg-[#090F1A]/80 px-8 py-6 text-center shadow-2xl backdrop-blur">
        <BrandBlock large />
        <p className="text-sm text-[#C9D5E4]">{greeting || " "}</p>
        <p className="min-h-6 font-mono text-base tracking-wide text-white" dir="ltr">
          <bdi>{shownName || " "}</bdi>
        </p>
        {!ready && <p className="text-xs text-[#8EA3BD]">{value?.t("splash.loading") ?? "…"}</p>}
        {ready && !isFinished && (
          <button type="button" onClick={() => setFinished(true)} className="text-xs text-[#8EA3BD] underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-cyan-400">
            {value?.t("splash.skip")}
          </button>
        )}
      </div>
    </div>
  );
}
