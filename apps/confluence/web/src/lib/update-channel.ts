/**
 * update-channel.ts — v2.5.1 update notices (ADR-0012).
 *
 * The app only *reads* one public file, `/updates/latest.json`, and shows a notice when it describes a newer
 * version. Nothing is sent. The Android download URL is always built from UPDATE_ORIGIN plus a validated file
 * name — never taken from the manifest — so a manifest cannot point the app at another host.
 * Pure helpers only (no DOM at import time); unit-tested in Node.
 */

/** The Netlify site the CI `publish` job deploys to (ADR-0003 amendment, release check R8). */
export const UPDATE_ORIGIN = "https://effervescent-bubblegum-1e5c03.netlify.app";
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** `meta` document holding { enabled, lastCheckedAt, dismissedBuild }. */
export const UPDATE_META_KEY = "update-check";

export interface UpdateManifest {
  schema: 1;
  app: "rsl-confluence";
  version: string;
  build: string;
  publishedAt: string;
  notes: string;
  android: { file: string; bytes: number; sha256: string } | null;
}

export type UpdateAction =
  | { kind: "reload" }
  | { kind: "download"; url: string; bytes: number; sha256: string }
  | { kind: "notice"; hint: "ios" | "desktop" | "android-later" };

const VERSION = /^\d{1,4}(\.\d{1,4}){1,2}$/;
const BUILD = /^\d{8}$/;
const APK = /^[A-Za-z0-9._-]{1,120}\.apk$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_APK = 200 * 1024 * 1024;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Strict validation; anything unexpected means "no update notice". */
export function parseManifest(raw: unknown): { ok: true; manifest: UpdateManifest } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "not an object" };
  if (raw.schema !== 1) return { ok: false, error: "schema" };
  if (raw.app !== "rsl-confluence") return { ok: false, error: "app" };
  if (typeof raw.version !== "string" || !VERSION.test(raw.version)) return { ok: false, error: "version" };
  if (typeof raw.build !== "string" || !BUILD.test(raw.build)) return { ok: false, error: "build" };
  const notes = raw.notes ?? "";
  if (typeof notes !== "string" || notes.length > 500) return { ok: false, error: "notes" };
  const publishedAt = typeof raw.publishedAt === "string" ? raw.publishedAt : "";
  let android: UpdateManifest["android"] = null;
  if (raw.android !== null && raw.android !== undefined) {
    const a = raw.android;
    if (!isObj(a)) return { ok: false, error: "android" };
    if (typeof a.file !== "string" || !APK.test(a.file) || a.file.includes("..")) return { ok: false, error: "android.file" };
    if (typeof a.bytes !== "number" || !Number.isInteger(a.bytes) || a.bytes <= 0 || a.bytes > MAX_APK) return { ok: false, error: "android.bytes" };
    if (typeof a.sha256 !== "string" || !SHA256.test(a.sha256)) return { ok: false, error: "android.sha256" };
    android = { file: a.file, bytes: a.bytes, sha256: a.sha256 };
  }
  return { ok: true, manifest: { schema: 1, app: "rsl-confluence", version: raw.version, build: raw.build, publishedAt, notes, android } };
}

const parts = (v: string) => { const p = v.split(".").map(Number); while (p.length < 3) p.push(0); return p; };

/** Higher version wins; with an equal version, the later build wins. */
export function isNewer(current: { version: string; build: string }, remote: { version: string; build: string }): boolean {
  const a = parts(current.version), b = parts(remote.version);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return b[i] > a[i];
  return remote.build > current.build;
}

export function dueForCheck(lastCheckedAt: string | null | undefined, now: number, interval = CHECK_INTERVAL_MS): boolean {
  const t = lastCheckedAt ? Date.parse(lastCheckedAt) : NaN;
  return !Number.isFinite(t) || now - t >= interval;
}

/** PWA: its own origin (`'self'`, wherever it is hosted). Native shells: the update origin. */
export function manifestUrl(shell: string, location: string): string {
  if (shell === "web") return new URL("/updates/latest.json", location).href;
  return `${UPDATE_ORIGIN}/updates/latest.json`;
}

export function updateAction(shell: string, os: string, m: UpdateManifest): UpdateAction {
  if (shell === "web") return { kind: "reload" };
  if (shell === "capacitor" && os === "android") {
    return m.android
      ? { kind: "download", url: `${UPDATE_ORIGIN}/updates/${m.android.file}`, bytes: m.android.bytes, sha256: m.android.sha256 }
      : { kind: "notice", hint: "android-later" };
  }
  if (shell === "capacitor") return { kind: "notice", hint: "ios" };
  return { kind: "notice", hint: "desktop" };
}

export function formatBytes(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** rsl-platform shell names → channel shells: everything that is not a native shell reads its own origin. */
export function channelShell(kitShell: string): "web" | "tauri" | "capacitor" {
  return kitShell === "tauri" || kitShell === "capacitor" ? kitShell : "web";
}
