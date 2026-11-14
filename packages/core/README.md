# rsL Core Kit · v1.1 2026

These are the parts every rsL application shares, built once and reused: design tokens, an adaptive shell, the rsL identity, 18-language i18n, Customer Name Recall, one storage API, a hash-chained audit trail, the offline license core, a platform adapter, and export helpers.

The kit is plain ES modules and CSS with **no runtime dependencies**. The same files run in the Tauri 2 desktop shell (Windows, macOS), the Capacitor mobile shell (iOS, Android), a PWA and Node ≥ 22.

> Personal edition by rsLozano. It carries no organisation names, departments, people or sites (KIT-002).

---

## Quick start (5 minutes)

```bash
# 1. Run the tests (Node ≥ 22.5; node:sqlite is used for the SQLite contract test)
node --test

# 2. Rebuild the CSS after editing tokens
node tokens/build-tokens.mjs
```

```html
<link rel="stylesheet" href="tokens/rsl-tokens.css">
<link rel="stylesheet" href="ui/rsl-shell.css">
<script type="module">
  import { brandBlockHTML } from './core/rsl-brand.js';
  import { openStorage, createIndexedDBAdapter } from './core/rsl-storage.js';
  import { createAuditTrail } from './core/rsl-audit.js';

  const app = { name: 'PackOS', version: '1.0', year: 2026, build: '20261029' };
  document.querySelector('.rsl-appbar').insertAdjacentHTML('afterbegin', brandBlockHTML(app));

  const { port, notice } = await openStorage([
    () => createIndexedDBAdapter({ dbName: 'rsl-packos', collections: ['sku', 'meta', 'identity', 'audit', 'audit_meta'] }),
  ]);
  if (notice) showBanner(notice);              // session-only or best-effort storage is never silent
  const audit = createAuditTrail(port);
  await audit.append({ actorId: 'op-7', event: 'app.start' });
</script>
```

## Modules

| Layer | File | What it gives every app |
|---|---|---|
| Look | `tokens/rsl.tokens.json`, `rsl.dark.tokens.json` → `rsl-tokens.css` | DTCG 2025.10 tokens; light, dark and explicit-theme CSS; WCAG AA pairs tested |
| Look | `ui/rsl-shell.css` | Bottom nav under 600 px, icon rail to 1199 px, expanded rail above; 48 px touch targets; safe areas; RTL; A4 print |
| Look | `core/rsl-brand.js` | Monogram (unique gradient ids), brand block, build stamp, Powered-by line, personal credit line |
| Look | `core/rsl-signature-art.js` | Convergent Lattice signature, seeded by the app code (splash, About, empty states) |
| Language | `core/rsl-i18n.js` | 18 languages in rsL order, ICU MF1 subset (plural, select, number, date), English fallback, Latin digits for ar/ur/bn |
| Data | `core/rsl-identity.js` | Customer Name Recall store, validation, grapheme-safe initials, safe logo check |
| Data | `core/rsl-storage.js` | `StoragePort` over SQLite, IndexedDB, localStorage and memory; migrations; checksummed backups |
| Data | `core/rsl-audit.js` | Append-only SHA-256 chain with before/after, reason and actor id; clock set-back entries; footer reference |
| Data | `core/rsl-clock.js` | Monotonic clock with 30-day skew bound; UTC calendar-date helpers |
| Data | `core/rsl-crypto.js` | Canonical JSON, SHA-256, strict base64url, FNV-1a |
| Trust | `core/rsl-license-core.js` | ES256 verification (E-01…E-16), Luhn mod 36 numbers, site binding, trial → due → licensed state machine |
| Platform | `core/rsl-platform.js` | `saveOrShare` and `openFile` through Tauri, Capacitor or the browser |
| Platform | `core/rsl-export.js` | Injection-safe CSV, export file names, GS1 mod-10 (GTIN, SSCC) |

Core modules **never import** `@tauri-apps/*` or `@capacitor/*`. Each shell injects its plugins at startup (ports and adapters). Enforce this with ESLint `no-restricted-imports` on `packages/core`.

## Wiring each shell

### Desktop: Tauri 2 (Windows, macOS)

```js
import Database from '@tauri-apps/plugin-sql';
import { save, open } from '@tauri-apps/plugin-dialog';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
import { createSqlAdapter, fromTauriSql } from './core/rsl-storage.js';
import { createPlatform } from './core/rsl-platform.js';

const port = await createSqlAdapter(fromTauriSql(await Database.load('sqlite:rsl-packos.db')));
const platform = createPlatform({ tauri: { dialog: { save, open }, fs: { writeFile, readFile } } });
```

Capabilities: grant `sql:default`, `dialog:allow-save`, `dialog:allow-open` and `fs:allow-write-file` / `fs:allow-read-file`, scoped to `$DOCUMENT/**` and `$APPDATA/**` only. Set an explicit CSP in `tauri.conf.json`. The updater key pair is **not** the license key pair.

### Mobile: Capacitor 8+ (iOS, Android)

```js
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { createSqlAdapter, fromCapacitorSqlite } from './core/rsl-storage.js';
import { createPlatform } from './core/rsl-platform.js';

const port = await createSqlAdapter(fromCapacitorSqlite(conn));   // conn from your SQLite plugin
const platform = createPlatform({ capacitor: { Filesystem, Directory, Share } });
```

Start new iOS projects on Swift Package Manager (CocoaPods trunk becomes read-only on 2 Dec 2026). Turn off WebView debugging in release builds and exclude record files from Android backup.

### Browser / PWA

`openStorage([() => createIndexedDBAdapter(...), () => createLocalStorageAdapter(), ...])` then `requestPersistence()`. IndexedDB is best-effort and evictable, so show the `notice` and prompt for regular **Export backup**.

## Rules that every app keeps

1. **Records are durable only in native SQLite.** IndexedDB is a cache or the PWA fallback, never the only copy.
2. **Nothing is locked by the license.** Status affects only the watermark, chip, banner and prompt.
3. **Only public keys ship.** The release gate fails on private JWKs, `.enc.json`, issuer files or registries in `dist/`.
4. **Brand strings are never translated.** Insert them with `isolate()`.
5. **Every export carries the audit head** (`audit.footerRef()`) and the license state.
6. **No national ID or iqama numbers** in identity or audit records (PDPL minimisation). Use opaque `actorId`s.
7. **Supply chain.** Use exact versions, `pnpm install --frozen-lockfile`, lifecycle scripts off by default, a CycloneDX SBOM per release, and builds in CI only. Vendor SheetJS CE 0.20.3 from its tarball; the npm `xlsx` package is stale at 0.18.5.

## Testing

`node --test` runs 21 cases:
- license test vectors and the worked Luhn example (`RSL-NMRC-2026-0001` → `P`)
- the storage contract on real SQLite and the Tauri placeholder shim
- migrations, and backup tamper detection
- audit tamper detection and clock set-back handling
- Arabic plurals with Latin digits
- CSV injection and GS1
- identity sanitising
- brand order, and WCAG contrast of every text token pair in both themes

Browser-only paths (IndexedDB, Canvas signature, `saveOrShare` fallbacks) are exercised by the library page `index.html`.

## Versioning

Kit releases use `vMAJOR.MINOR YEAR` (for example `v1.0 2026`). A change to a public function signature, a storage format (`rsl_docs`, backup `formatVersion`) or the audit entry shape is a major version change. Apps pin the kit version they were tested with.

---

**Version v1.1 2026**

Created by rsLozano
