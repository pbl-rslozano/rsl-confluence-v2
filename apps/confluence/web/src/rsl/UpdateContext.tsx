"use client";

/**
 * UpdateContext — v2.5.1 update channel (ADR-0012). Reads /updates/latest.json at launch and every 6 hours
 * while online and enabled (About → Updates), and exposes the result to the notice and the About dialog.
 * Read-only: one GET with no credentials; nothing about the user or device is sent.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { APP } from "./app-info";
import { useRsl } from "./RslContext";
import {
  CHECK_INTERVAL_MS, UPDATE_META_KEY, channelShell, dueForCheck, isNewer, manifestUrl, parseManifest, updateAction,
  type UpdateAction, type UpdateManifest,
} from "@/lib/update-channel";

interface UpdateMeta { enabled: boolean; lastCheckedAt: string | null; dismissedBuild: string | null }
export type UpdateStatus = "idle" | "checking" | "current" | "available" | "failed";

interface UpdateValue {
  enabled: boolean;
  status: UpdateStatus;
  manifest: UpdateManifest | null;
  action: UpdateAction | null;
  lastCheckedAt: string | null;
  /** Shown as a notice: available and not dismissed for this build. */
  showNotice: boolean;
  checkNow: () => Promise<void>;
  setEnabled: (on: boolean) => Promise<void>;
  dismiss: () => Promise<void>;
  applyReload: () => Promise<void>;
}

const DEFAULT_META: UpdateMeta = { enabled: true, lastCheckedAt: null, dismissedBuild: null };
const Ctx = createContext<UpdateValue | null>(null);

export function useUpdate(): UpdateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useUpdate() outside <UpdateProvider>");
  return v;
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { port, info, online } = useRsl();
  const shell = channelShell(info.shell);
  const [meta, setMeta] = useState<UpdateMeta | null>(null);
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [manifest, setManifest] = useState<UpdateManifest | null>(null);
  const metaRef = useRef<UpdateMeta | null>(null);
  const busy = useRef(false);

  const save = useCallback(async (next: UpdateMeta) => {
    metaRef.current = next;
    setMeta(next);
    await port.put("meta", UPDATE_META_KEY, next);
  }, [port]);

  useEffect(() => {
    let alive = true;
    void port.get("meta", UPDATE_META_KEY).then((saved) => {
      if (!alive) return;
      const m = { ...DEFAULT_META, ...((saved as Partial<UpdateMeta> | null) ?? {}) };
      metaRef.current = m;
      setMeta(m);
    });
    return () => { alive = false; };
  }, [port]);

  const check = useCallback(async () => {
    const m = metaRef.current;
    if (!m || busy.current) return;
    busy.current = true;
    setStatus("checking");
    try {
      const r = await fetch(manifestUrl(shell, window.location.href), { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = parseManifest(await r.json());
      if (!parsed.ok) throw new Error(parsed.error);
      const newer = isNewer({ version: APP.version, build: APP.build }, parsed.manifest);
      setManifest(newer ? parsed.manifest : null);
      setStatus(newer ? "available" : "current");
    } catch {
      setStatus("failed");
    } finally {
      busy.current = false;
      await save({ ...(metaRef.current ?? m), lastCheckedAt: new Date().toISOString() });
    }
  }, [shell, save]);

  // At launch (once preferences are read) and whenever the app comes back online, then every 6 hours.
  const enabled = meta?.enabled ?? false;
  useEffect(() => {
    if (!enabled || !online) return;
    // Started outside the effect body (no synchronous setState in an effect).
    const first = window.setTimeout(() => void check(), 0);
    const id = window.setInterval(() => {
      if (dueForCheck(metaRef.current?.lastCheckedAt, Date.now(), CHECK_INTERVAL_MS)) void check();
    }, 15 * 60 * 1000);
    return () => { window.clearTimeout(first); window.clearInterval(id); };
  }, [enabled, online, check]);

  const value = useMemo<UpdateValue>(() => {
    const action = manifest ? updateAction(shell, info.os, manifest) : null;
    return {
      enabled,
      status,
      manifest,
      action,
      lastCheckedAt: meta?.lastCheckedAt ?? null,
      showNotice: status === "available" && !!manifest && meta?.dismissedBuild !== `${manifest.version}+${manifest.build}`,
      checkNow: check,
      setEnabled: async (on) => { if (!on) { setManifest(null); setStatus("idle"); } await save({ ...(metaRef.current ?? DEFAULT_META), enabled: on }); },
      dismiss: async () => { if (manifest) await save({ ...(metaRef.current ?? DEFAULT_META), dismissedBuild: `${manifest.version}+${manifest.build}` }); },
      applyReload: async () => {
        // PWA: let the waiting service worker take over, then reload; without one, drop cached pages and reload.
        const reg = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
        await reg?.update().catch(() => {});
        if (reg?.waiting) {
          navigator.serviceWorker.addEventListener("controllerchange", () => window.location.reload(), { once: true });
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          return;
        }
        const keys = await caches?.keys?.().catch(() => [] as string[]) ?? [];
        await Promise.all(keys.filter((k) => k.startsWith("confluence-shell-")).map((k) => caches.delete(k)));
        window.location.reload();
      },
    };
  }, [enabled, status, manifest, meta, shell, info.os, check, save]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
