# Port audit — Confluence Terminal 2.02 → rsL v2.1 2026

| Feature | Where used (2.02) | WebView2 (Win) | WKWebView (mac/iOS) | Android WebView | Fix in 2.1 |
|---|---|---|---|---|---|
| Electron main/preload, `file://` origin | desktop wrapper | n/a | n/a | n/a | Replaced by Tauri 2 (ADR-0001); gateway now allows Tauri origins, still refuses `null` |
| Preferences in `localStorage` (`ct-preferences-v1`) | `preferences-store.ts` | OK | evictable | OK | Moved to StoragePort record (SQLite in shells); one-time import + audit (ADR-0002) |
| Candle history in IndexedDB | `history-store.ts` | OK | best-effort, evictable | OK | Kept as a re-fetchable cache, not a record (ADR-0002) |
| Theme hint `ct-theme` in `localStorage` | `layout.tsx` first-paint script | OK | OK | OK | Kept only to avoid a theme flash; the real value lives in preferences |
| Save/open files | none in 2.02 | — | `showSaveFilePicker` missing | missing | New backup/identity export go through kit `saveOrShare` / `openFile` (dialog+fs / Filesystem+Share / download) |
| Next.js API route (`/api`) | dev proxy | — | — | — | Excluded from static builds (build script moves it aside); exchanges called directly from allow-listed hosts |
| Service worker | `sw.js` | OK | OK | OK | Registered only in the PWA; skipped in Tauri/Capacitor; cache version bumped |
| Runtime CDN / web fonts | none (system fonts) | — | — | — | Fonts vendored (@fontsource 5.3.0) incl. Arabic Naskh and Urdu Nastaliq |
| WebGL / Three.js | none in 2.02 | OK | OK (iPad spike: NOT VERIFIED on device) | OK | New 3D monogram in About only; static SVG fallback; context released on close |
| `eval` / `new Function` | none | — | — | — | CSP blocks them anyway |
| `alert` / `confirm` / `prompt` | none in web core | — | — | — | Restore uses an inline confirm; Android back-exit confirm lives in the Capacitor adapter |
| `window.print` | none | — | — | — | Not needed (ADR-0006) |
| `target=_blank` / external links | none | — | — | — | Links go through `openExternal` (Tauri opener limited to the contact mailto) |
| Drag-and-drop import | none | — | — | — | Tauri `dragDropEnabled: false` |
| Electron-only CSS / APIs | file-origin note in API dialog | — | — | — | Removed |
| Data stores and counts | 1 localStorage key, 1 IndexedDB DB (candles) | | | | No record data at risk: the legacy key is read, never deleted |
