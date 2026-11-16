/**
 * rsL Coffee Kit — the optional "Treat the developer to a coffee" tip card (owner request, 15 Nov 2026).
 *
 * coffee-kit.json is the master KIT object of the rsL Coffee Kit, copied unchanged (images, hashes and wording).
 * The app never edits it: kit changes happen only in the master, which bumps kitVersion and the hashes.
 * Its wording is shown verbatim with {appName} replaced; it is not sent through the i18n catalogs (the master owns it,
 * as brand strings are never translated). The tip is optional and personal, never a fee: nothing is gated on it and
 * the card opens only when the viewer expands it in About.
 */

import { semver } from "@rsl/core-kit/core/rsl-brand.js";
import KIT_DATA from "./coffee-kit.json" with { type: "json" };

/** Display version of a kit: kitVersion padded to MAJOR.MINOR.PATCH ("1.1" -> "1.1.0"), no "v", no year (KIT-003). */
export function coffeeKitVersion(kitVersion: string): string {
  return semver(kitVersion);
}

/** Kit version and build of the committed coffee-kit.json (kitVersion "1.1" shown as "1.1.0"). Display string only. */
export const COFFEE_KIT_VERSION: string = coffeeKitVersion(KIT_DATA.kitVersion);
export const COFFEE_KIT_BUILD = "20261115";
/** Replaces {appName} in the kit wording. Brand string, never translated. */
export const COFFEE_APP_NAME = "rsL Confluence Terminal";

export type CoffeeMethod = {
  id: string;
  name: string;
  network: string;
  accountName: string;
  shownLine: string;
  copyValue: string | null;
  copyLabel: string | null;
  hint: string;
  cardPng: string;
  cardPixels: number[];
};

export type CoffeeKit = {
  kit: string;
  kitVersion: string;
  title: string;
  intro: string;
  buttonLabel: string;
  buttonNote: string;
  footer: string;
  methods: CoffeeMethod[];
};

/** Kit wording with every {appName} replaced; nothing else is changed. */
export function coffeeText(text: string, appName: string = COFFEE_APP_NAME): string {
  return text.replaceAll("{appName}", appName);
}

/** Alt text that describes the card (method, QR kind, account as the kit shows it). */
export function coffeeAlt(m: Pick<CoffeeMethod, "name" | "network" | "accountName">): string {
  const kind = /^QR Ph\b/.test(m.network) ? "QR Ph code" : /\bon-chain\b/i.test(m.network) ? "on-chain QR code" : "QR code";
  return `${m.name} ${kind} for ${m.accountName}`;
}

/** The card PNG exactly as the kit holds it. */
export function coffeeCardSrc(m: Pick<CoffeeMethod, "cardPng">): string {
  return `data:image/png;base64,${m.cardPng}`;
}

type CopyEnv = {
  clipboard?: { writeText(text: string): Promise<void> };
  document?: {
    body?: { appendChild(n: unknown): unknown };
    createElement(tag: string): any;
    execCommand?(cmd: string): boolean;
  };
};

/** Clipboard first, then a hidden-textarea fallback; fails silently (returns false) and never throws. */
export async function copyToClipboard(text: string, env: CopyEnv = defaultEnv()): Promise<boolean> {
  try {
    if (env.clipboard?.writeText) {
      await env.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea fallback */
  }
  try {
    const doc = env.document;
    if (!doc?.body || !doc.execCommand) return false;
    const ta = doc.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    doc.body.appendChild(ta);
    try {
      ta.select();
      return doc.execCommand("copy") === true;
    } finally {
      ta.remove();
    }
  } catch {
    return false;
  }
}

function defaultEnv(): CopyEnv {
  if (typeof document === "undefined") return {};
  return { clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined, document: document as unknown as CopyEnv["document"] };
}
