/**
 * boot.ts — rsL cross-platform boot sequence (builder skill, phase 2).
 *
 * Order: platform → storage (SQLite first) → migrations (snapshot first) → audit →
 * identity (Customer Name Recall) → language → guarded clock → render.
 * Personal edition: no license step (ADR-0004). Every step is awaited; failures surface.
 */
import { createPlatform, detectPlatform, type Platform, type PlatformInfo } from "@rsl/core-kit/core/rsl-platform.js";
import {
  createIndexedDBAdapter,
  createLocalStorageAdapter,
  createSqlAdapter,
  exportSnapshot,
  openStorage,
  requestPersistence,
  runMigrations,
  type StoragePort,
} from "@rsl/core-kit/core/rsl-storage.js";
import { createAuditTrail, type AuditTrail } from "@rsl/core-kit/core/rsl-audit.js";
import { createIdentityStore, validateIdentity, type IdentityStore } from "@rsl/core-kit/core/rsl-identity.js";
import { applyToDocument, createI18n, negotiateLanguage, type I18n } from "@rsl/core-kit/core/rsl-i18n.js";
import { readGuardedNow } from "@rsl/core-kit/core/rsl-clock.js";
import { APP, COLLECTIONS, PERSONAL_IDENTITY } from "./app-info";
import { CATALOGS } from "./i18n/catalogs";
import { readLegacyPreferences } from "@/lib/preferences-store";
import { setCoinsphNativeGet } from "@/lib/coinsph";
import { setRelayNativeGet } from "@/lib/native-relay";
import { isAllowedNativeUrl } from "@/lib/public-hosts";
import { registerShellFullscreen } from "@/lib/shell-fullscreen";

export interface Adapters {
  shell?: string;
  sqlFactory?: () => Promise<import("@rsl/core-kit/core/rsl-storage.js").SqlExecutor>;
  tauri?: unknown;
  capacitor?: unknown;
  onBack?: (handler: () => Promise<boolean> | boolean) => unknown;
  openExternal?: (url: string) => Promise<void>;
  onMenu?: (handler: (id: string) => void) => Promise<unknown>;
  /** v2.5: native chrome follows the theme (status bar on mobile, window theme on desktop). */
  theme?: import("@/lib/theme").PlatformThemeHooks;
  /** v2.6 (ADR-0013): native GET for allow-listed public market data (Capacitor, Tauri). */
  makeNativeGet?: (isAllowed: (url: string) => boolean) => import("@/lib/coinsph").NativeGet;
  /** v2.7 (WP14.3): native help for the chart's full screen (window on desktop, status bar on phones). */
  fullscreen?: import("@/lib/shell-fullscreen").ShellFullscreen;
}

export interface BootResult {
  info: PlatformInfo;
  platform: Platform;
  port: StoragePort;
  notice: string | null;
  audit: AuditTrail;
  identity: IdentityStore;
  i18n: I18n;
  firstRun: boolean;
  clockSetBack: boolean;
  adapters: Adapters;
}

const VERSION = `${APP.version} ${APP.year}`;
const LOCAL_SNAPSHOT_KEY = "rsl-conf-premigration-snapshot";

/** Ordered, forward-only, idempotent. Never edit a shipped migration — add a new one. */
const MIGRATIONS = [
  {
    version: 1,
    name: "seed personal identity + import legacy (≤2.02) localStorage preferences",
    up: async (port: StoragePort) => {
      if (!(await port.get("identity", "current"))) {
        await port.put("identity", "current", validateIdentity(PERSONAL_IDENTITY).value);
      }
      const legacy = readLegacyPreferences();
      if (legacy && !(await port.get("preferences", "current"))) {
        await port.put("preferences", "current", legacy);
        await port.put("meta", "legacy-import", { from: "localStorage:ct-preferences-v1", at: new Date().toISOString(), records: 1 });
      }
      await port.put("meta", "first-run", { pending: true });
    },
  },
];

/** Keep the pre-migration snapshot outside the store being migrated (best effort). */
function saveLocalSnapshot(snapshot: unknown) {
  try {
    localStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota or blocked storage — the migration still runs; the audit records it */
  }
}

/** Two independent high-water marks for the guarded clock (port + localStorage). */
function clockStores(port: StoragePort) {
  return [
    {
      get: async () => ((await port.get("meta", "clock")) as { highWater?: number } | null)?.highWater ?? null,
      set: async (n: number) => port.put("meta", "clock", { highWater: n }),
    },
    {
      get: async () => {
        const v = Number(localStorage.getItem("rsl-conf-clock"));
        return Number.isFinite(v) && v > 0 ? v : null;
      },
      set: async (n: number) => localStorage.setItem("rsl-conf-clock", String(n)),
    },
  ];
}

export async function boot(adapters: Adapters = {}): Promise<BootResult> {
  // 1 — platform
  const info = detectPlatform();
  const platform = createPlatform(adapters);

  // 2 — storage: native SQLite first, then IndexedDB, then localStorage, then memory (with a notice)
  const factories: Array<() => Promise<StoragePort> | StoragePort> = [];
  if (adapters.sqlFactory) {
    const make = adapters.sqlFactory;
    factories.push(async () => createSqlAdapter(await make()));
  }
  factories.push(() => createIndexedDBAdapter({ dbName: "rsl-conf", collections: COLLECTIONS }));
  factories.push(() => createLocalStorageAdapter({ prefix: "rsl-conf" }));
  const { port, notice } = await openStorage(factories);
  if (port.kind !== "sqlite") await requestPersistence();

  // 3 — migrations, each preceded by a snapshot
  const fromVersion = ((await port.get("meta", "schema")) as { version?: number } | null)?.version ?? 0;
  await runMigrations(port, MIGRATIONS, {
    beforeEach: async () =>
      saveLocalSnapshot(await exportSnapshot(port, { appId: APP.code, appVersion: VERSION, collections: COLLECTIONS })),
  });

  // 4 — audit
  const audit = createAuditTrail(port);
  const legacy = (await port.get("meta", "legacy-import")) as { records?: number; logged?: boolean } | null;
  if (legacy && !legacy.logged) {
    await audit.append({ actorId: "system", event: "migration.import", record: "preferences", reason: `Imported ${legacy.records ?? 0} legacy preference record(s) from localStorage (≤ 2.02).` });
    await port.put("meta", "legacy-import", { ...legacy, logged: true });
  }

  // 5 — identity (Customer Name Recall)
  const identity = await createIdentityStore(port);
  const firstRun = Boolean(((await port.get("meta", "first-run")) as { pending?: boolean } | null)?.pending);

  // 6 — language
  const i18n = createI18n({ catalogs: CATALOGS, lang: identity.get().operator.preferredLang || negotiateLanguage() });
  if (firstRun && !identity.get().operator.displayName) i18n.setLang(negotiateLanguage());
  applyToDocument(i18n);

  // 7 — guarded clock (no license step in the personal edition)
  const clock = await readGuardedNow(clockStores(port));
  if (clock.setBack) {
    await audit.append({ actorId: "system", event: "clock.set-back", reason: "Device clock is behind the last trusted time." });
  }
  await audit.append({
    actorId: identity.get().operator.id || "local",
    event: "app.start",
    reason: `${info.shell}/${info.os} · storage ${port.kind} · schema ${fromVersion}→${((await port.get("meta", "schema")) as { version: number }).version} · personal edition`,
  });

  // 8 — render (the caller shows the splash using drawSignature(canvas, { appCode: APP.code }))
  return { info, platform, port, notice, audit, identity, i18n, firstRun, clockSetBack: clock.setBack, adapters };
}

/** Pick the shell's adapter package at runtime. Only the adapters import native plugins. */
export async function loadAdapters(): Promise<Adapters> {
  const g = globalThis as unknown as { __TAURI_INTERNALS__?: unknown; Capacitor?: { isNativePlatform?: () => boolean } };
  const adapters: Adapters = g.__TAURI_INTERNALS__
    ? await (await import("@rsl/adapter-tauri")).createAdapters()
    : g.Capacitor?.isNativePlatform?.()
      ? await (await import("@rsl/adapter-capacitor")).createAdapters()
      : await (await import("@rsl/adapter-web")).createAdapters();
  // v2.6: Coins.ph sends no CORS header; native shells reach its read paths through
  // their own HTTP stack, fenced by the public-host allowlist (R16).
  setCoinsphNativeGet(adapters.makeNativeGet ? adapters.makeNativeGet(isAllowedNativeUrl) : null);
  // v2.8 (WP26): Upbit's CORS is unreliable; the generic relay reaches its read paths the same way.
  setRelayNativeGet(adapters.makeNativeGet ? adapters.makeNativeGet(isAllowedNativeUrl) : null);
  registerShellFullscreen(adapters.fullscreen);
  return adapters;
}

export const BACKUP_COLLECTIONS = COLLECTIONS;
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
