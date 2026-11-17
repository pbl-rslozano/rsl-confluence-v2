/**
 * @rsl/adapter-tauri — the ONLY place the desktop shell's plugins are imported (ADR-0001, rule 3).
 * Desktop (Windows / macOS) via Tauri 2: native SQLite for records, native save/open dialogs,
 * and (v2.6) a native GET for allow-listed public market-data URLs.
 */
import Database from '@tauri-apps/plugin-sql';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import { openUrl } from '@tauri-apps/plugin-opener';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { makeNativeRequest } from './native-request.js';
import { createLoopbackOAuth } from './oauth.js';
import { fromTauriSql } from '@rsl/core-kit/core/rsl-storage.js';

export const DB_URL = 'sqlite:rsl-conf.db';

/**
 * v2.6 (ADR-0013): GET through the Rust HTTP client for public market-data hosts that send no CORS
 * header (Coins.ph). Two fences: `isAllowed` (the app's allowlist, src/lib/public-hosts.ts) here,
 * and the capability scope in src-tauri/capabilities/main.json. No redirects, no credentials.
 */
export function makeNativeGet(isAllowed) {
  return async (url, { signal } = {}) => {
    if (typeof isAllowed !== 'function' || !isAllowed(url)) throw new Error('Native GET refused: URL not on the allowlist');
    const res = await httpFetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal, maxRedirections: 0, connectTimeout: 15000 });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, body: await res.text() };
  };
}

export async function createAdapters() {
  return {
    shell: 'tauri',
    makeNativeGet,
    /** v2.8 (WP28): backup HTTP behind the backup allowlist, and the loopback sign-in broker. */
    makeNativeRequest: (isAllowed) => makeNativeRequest(isAllowed, httpFetch),
    makeOAuth: (isSignIn) => createLoopbackOAuth({ invoke, openUrl, isSignIn }),
    /** v2.5: native window chrome follows the app theme (needs core:window:allow-set-theme). */
    theme: {
      // null = follow the OS (System preference); a forced theme also forces the webview's prefers-color-scheme.
      async setWindowTheme(theme) { await getCurrentWindow().setTheme(theme ?? null); },
    },
    /** v2.7 (WP14.3): chart full screen makes the window full screen (needs core:window:allow-set-fullscreen). */
    fullscreen: { shell: 'tauri', async set(on) { await getCurrentWindow().setFullscreen(Boolean(on)); } },
    sqlFactory: async () => fromTauriSql(await Database.load(DB_URL)),
    tauri: { dialog: { save, open }, fs: { writeFile, readFile } },
    /** https / mailto links open in the system browser / mail app (webview navigation stays locked). */
    openExternal: (url) => openUrl(url),
    /** Native menu → web app. Handler receives the menu item id (about, settings, backup.export, …). */
    onMenu: async (handler) => listen('rsl-menu', (e) => handler(String(e.payload))),
  };
}
