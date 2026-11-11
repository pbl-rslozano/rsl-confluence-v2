"use client";

import { useEffect } from "react";

/**
 * Registers the service worker so the PWA works offline / installable on
 * Android. Only runs in production to avoid caching surprises during dev.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // Native shells (Tauri / Capacitor) serve the app from the bundle; a service worker adds nothing there.
    const g = window as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
    if (g.__TAURI_INTERNALS__ || g.Capacitor?.isNativePlatform?.()) return;
    const onLoad = () => {
      navigator.serviceWorker.register(new URL("./sw.js", window.location.href)).catch(() => {
        /* registration failures are non-fatal */
      });
    };
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}
