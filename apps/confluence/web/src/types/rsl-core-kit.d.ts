/* Type declarations for the vendored rsL Core Kit (plain ES modules, no bundled types). */
declare module "@rsl/core-kit/core/rsl-storage.js" {
  export interface StoragePort {
    kind: "sqlite" | "indexeddb" | "localstorage" | "memory";
    durable: boolean;
    sessionOnly: boolean;
    get(col: string, id: string): Promise<any>;
    put(col: string, id: string, doc: unknown): Promise<void>;
    del(col: string, id: string): Promise<void>;
    list(col: string): Promise<{ id: string; doc: any }[]>;
    clear(col: string): Promise<void>;
    close?(): Promise<void>;
  }
  export interface SqlExecutor { execute(q: string, p: unknown[]): Promise<unknown>; select(q: string, p: unknown[]): Promise<any[]>; close?(): unknown }
  export function createSqlAdapter(sql: SqlExecutor): Promise<StoragePort>;
  export function createIndexedDBAdapter(o: { dbName: string; collections: readonly string[] }): Promise<StoragePort>;
  export function createLocalStorageAdapter(o?: { prefix?: string }): StoragePort;
  export function createMemoryAdapter(): StoragePort;
  export function openStorage(f: Array<() => Promise<StoragePort> | StoragePort>): Promise<{ port: StoragePort; notice: string | null; tried: string[] }>;
  export function requestPersistence(): Promise<boolean | null>;
  export function runMigrations(port: StoragePort, m: Array<{ version: number; name: string; up: (p: StoragePort) => Promise<void> }>, o?: { beforeEach?: (from: number, to: number) => Promise<void> }): Promise<number>;
  export function exportSnapshot(port: StoragePort, o: { appId: string; appVersion: string; collections: readonly string[]; auditHead?: unknown }): Promise<any>;
  export function importSnapshot(port: StoragePort, bundle: unknown, o: { appId: string; maxSchemaVersion: number; mode?: "replace" | "merge" }): Promise<{ collections: number; schemaVersion: number }>;
  export const NOTICE_SESSION_ONLY: string;
  export const NOTICE_BEST_EFFORT: string;
  export function fromTauriSql(db: unknown): SqlExecutor;
  export function fromCapacitorSqlite(conn: unknown): SqlExecutor;
}
declare module "@rsl/core-kit/core/rsl-audit.js" {
  import type { StoragePort } from "@rsl/core-kit/core/rsl-storage.js";
  export interface AuditEntry { seq: number; at: string; actorId: string; event: string; record: string | null; reason: string; before: unknown; after: unknown; prev: string; hash: string }
  export interface AuditTrail {
    append(e: { actorId: string; event: string; record?: string | null; reason?: string; before?: unknown; after?: unknown }): Promise<AuditEntry>;
    verify(): Promise<{ intact: boolean; count: number; brokenAt: number | null; head: string }>;
    entries(o?: { record?: string }): Promise<AuditEntry[]>;
    head(): Promise<{ seq: number; hash: string; highWater: number | null }>;
    footerRef(): Promise<string>;
  }
  export function createAuditTrail(port: StoragePort, o?: { now?: () => number }): AuditTrail;
  export function diffFields(before?: object | null, after?: object | null): { before: Record<string, unknown>; after: Record<string, unknown> };
  export const GENESIS: string;
}
declare module "@rsl/core-kit/core/rsl-identity.js" {
  import type { StoragePort } from "@rsl/core-kit/core/rsl-storage.js";
  export interface Identity {
    customer: { legalName: string; shortName: string; code: string; logo: string | null; site: string };
    operator: { id: string | null; displayName: string; role: string; preferredLang: string };
    recent: { legalName: string; shortName: string; code: string }[];
    updatedAt: string;
  }
  export interface IdentityStore {
    get(): Identity;
    subscribe(fn: (v: Identity) => void): () => void;
    set(next: unknown): Promise<{ ok: boolean; errors: string[]; value: Identity }>;
    forgetCustomer(code: string): Promise<void>;
    exportJSON(): string;
    importJSON(text: string): Promise<{ ok: boolean; errors: string[] }>;
  }
  export function createIdentityStore(port: StoragePort): Promise<IdentityStore>;
  export function validateIdentity(input: unknown): { ok: boolean; errors: string[]; value: Identity };
  export function initials(name: string): string;
  export function avatarColor(code: string): string;
  export function isSafeLogo(uri: unknown): boolean;
  export function greetingKey(d?: Date): "greet.morning" | "greet.afternoon" | "greet.evening";
  export function defaultIdentity(): Identity;
}
declare module "@rsl/core-kit/core/rsl-i18n.js" {
  export interface Language { code: string; native: string; english: string; dir: "ltr" | "rtl"; locale: string; flag: string; tier: 1 | 2 }
  export const LANGUAGES: readonly Language[];
  export function getLanguage(code: string): Language;
  export function negotiateLanguage(requested?: readonly string[]): string;
  export function isolate(s: string): string;
  export interface I18n {
    readonly lang: string; readonly dir: "ltr" | "rtl"; readonly locale: string;
    t(key: string, vars?: Record<string, unknown>): string;
    setLang(code: string): void;
    onChange(fn: (lang: string) => void): () => void;
    formatNumber(n: number, o?: Intl.NumberFormatOptions): string;
    formatDate(d: Date | number | string, o?: Intl.DateTimeFormatOptions): string;
    status(code: string): string;
  }
  export function createI18n(cfg: { catalogs: Record<string, Record<string, string>>; lang?: string; fallback?: string; onMissing?: (k: string, l: string) => void }): I18n;
  export function applyToDocument(i18n: I18n, doc?: Document): void;
}
declare module "@rsl/core-kit/core/rsl-brand.js" {
  export const BRAND: { owner: string; byline: string; contactEmail: string; colors: Record<string, string> };
  export function monogramSVG(o?: { className?: string; label?: string; background?: string | null; width?: number; height?: number }): string;
  export function buildStamp(app: { version: string; year?: number; build: string }): string;
  export function poweredBy(app: { name: string; version: string; year?: number; build: string }): string;
  export function contactMailto(app: { name: string }, subject?: string): string;
  export function brandBlockHTML(app: { name: string; version: string; year?: number; build: string }): string;
}
declare module "@rsl/core-kit/core/rsl-clock.js" {
  export function readGuardedNow(stores: Array<{ get(): Promise<number | null>; set(n: number): Promise<void> }>, real?: number): Promise<{ now: number; nextHighWater: number; ignored: number | null; setBack: boolean }>;
}
declare module "@rsl/core-kit/core/rsl-platform.js" {
  export interface PlatformInfo { shell: "tauri" | "capacitor" | "electron" | "pwa" | "browser"; os: string; pointer: "coarse" | "fine"; mobile: boolean }
  export function detectPlatform(g?: unknown): PlatformInfo;
  export interface Platform {
    info: PlatformInfo;
    saveOrShare(data: string | Uint8Array | Blob, filename: string, mime: string): Promise<{ ok: boolean; method: string; cancelled?: boolean; path?: string }>;
    openFile(o: { accept?: string[]; maxBytes?: number }): Promise<{ name: string; bytes: Uint8Array } | null>;
  }
  export function createPlatform(adapters?: unknown, g?: unknown): Platform;
}
declare module "@rsl/core-kit/core/rsl-signature-art.js" {
  export function drawSignature(canvas: HTMLCanvasElement, o?: { appCode?: string; [k: string]: unknown }): { done: Promise<void>; stop(): void };
  export function seedFromAppCode(code: string): number;
}
declare module "@rsl/core-kit/core/rsl-export.js" {
  export function exportFileName(o: { app: string; customerCode?: string; docId?: string; date?: Date; ext: string }): string;
  export function toCSV(rows: unknown[], o?: { columns?: string[]; headers?: string[]; bom?: boolean; notice?: string }): string;
}
declare module "@rsl/adapter-tauri" { export function createAdapters(): Promise<any> }
declare module "@rsl/adapter-capacitor" { export function createAdapters(): Promise<any> }
declare module "@rsl/adapter-web" { export function createAdapters(): Promise<any> }
