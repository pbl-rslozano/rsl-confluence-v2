/**
 * @rsl/adapter-capacitor — the ONLY place the mobile shell's plugins are imported (ADR-0001, rule 3).
 * iOS / Android via Capacitor 8: native SQLite for records, Filesystem + Share for exports,
 * hardware back button handling, and (v2.6) a native GET for allow-listed public market-data URLs.
 */
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';
import { StatusBar, Style } from '@capacitor/status-bar';
import { CapacitorHttp } from '@capacitor/core';
import { fromCapacitorSqlite } from '@rsl/core-kit/core/rsl-storage.js';

export const DB_NAME = 'rsl-conf';

/**
 * v2.6 (ADR-0013): GET through the native HTTP stack, for public market-data hosts that send no
 * CORS header (Coins.ph). `isAllowed` is the app's allowlist (src/lib/public-hosts.ts); every URL
 * is checked here before any request, because native HTTP is not policed by the CSP. The global
 * CapacitorHttp switch stays OFF so no other request (Binance, Bybit, Bitget, updates) changes path.
 * No request headers beyond Accept; no cookies are read or sent by the app.
 */
export function makeNativeGet(isAllowed) {
  return async (url, { signal } = {}) => {
    if (typeof isAllowed !== 'function' || !isAllowed(url)) throw new Error('Native GET refused: URL not on the allowlist');
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await CapacitorHttp.get({ url, headers: { Accept: 'application/json' }, responseType: 'text', connectTimeout: 15000, readTimeout: 20000 });
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return { status: res.status, headers: res.headers ?? {}, body: res.data };
  };
}

export async function createAdapters() {
  return {
    shell: 'capacitor',
    makeNativeGet,
    sqlFactory: async () => {
      const sqlite = new SQLiteConnection(CapacitorSQLite);
      const consistent = (await sqlite.checkConnectionsConsistency()).result;
      const exists = (await sqlite.isConnection(DB_NAME, false)).result;
      const conn = consistent && exists
        ? await sqlite.retrieveConnection(DB_NAME, false)
        : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
      await conn.open();
      return fromCapacitorSqlite(conn);
    },
    capacitor: { Filesystem, Directory, Share },
    /** v2.5: status bar follows the app theme (light icons on dark, dark icons on light). */
    theme: {
      async setStatusBar(resolved) {
        await StatusBar.setStyle({ style: resolved === 'dark' ? Style.Dark : Style.Light });
        await StatusBar.setBackgroundColor({ color: resolved === 'dark' ? '#0B1B33' : '#F5F7FA' }).catch(() => {}); // Android only
      },
    },
    /** Android back: the app passes a handler that closes the top sheet / navigates; returns true when handled. */
    onBack(handler) {
      return App.addListener('backButton', async ({ canGoBack }) => {
        if (await handler()) return;
        if (canGoBack) globalThis.history.back();
        else if (globalThis.confirm?.('Exit Confluence Terminal?') !== false) App.exitApp();
      });
    },
  };
}
