/**
 * rsl-storage.js — rsL Core Kit · 1.2.0
 * One StoragePort for every shell. Durable records live in native SQLite (Tauri / Capacitor);
 * IndexedDB is the browser/PWA fallback; memory is the session-only last resort.
 *
 * Why: inside WKWebView (macOS/iOS shells) IndexedDB is best-effort, capped at ~15 % of disk per
 * origin and evicted least-recently-used, so it must never be the only copy of quality records.
 *
 * StoragePort (document model, JSON values):
 *   kind: 'sqlite' | 'indexeddb' | 'localstorage' | 'memory'
 *   durable: boolean          sessionOnly: boolean
 *   get(col, id) → doc|null   put(col, id, doc)   del(col, id)
 *   list(col) → [{id, doc}]   clear(col)          close()
 * No framework imports here: shells inject their plugin objects (see fromTauriSql / fromCapacitorSqlite).
 */
import { canonicalJSON, sha256Hex } from './rsl-crypto.js';

const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const assertName = (s, what) => {
  const ok = what === 'collection' ? /^[A-Za-z0-9_.:-]{1,64}$/.test(String(s)) : /^[^\u0000-\u001F\u007F]{1,200}$/.test(String(s));
  if (!ok) throw new Error(`Invalid ${what}: ${String(s).slice(0, 40)}`);
};

/* ───────────── Memory (session-only) ───────────── */
export function createMemoryAdapter() {
  const cols = new Map();
  const c = (n) => { assertName(n, 'collection'); if (!cols.has(n)) cols.set(n, new Map()); return cols.get(n); };
  return {
    kind: 'memory', durable: false, sessionOnly: true,
    async get(col, id) { return clone(c(col).get(String(id)) ?? null); },
    async put(col, id, doc) { assertName(id, 'id'); c(col).set(String(id), clone(doc)); },
    async del(col, id) { c(col).delete(String(id)); },
    async list(col) { return [...c(col)].map(([id, doc]) => ({ id, doc: clone(doc) })); },
    async clear(col) { c(col).clear(); },
    async close() {},
  };
}

/* ───────────── localStorage (small, synchronous, browser only) ───────────── */
export function createLocalStorageAdapter({ prefix = 'rsl', storage = globalThis.localStorage } = {}) {
  if (!storage) throw new Error('localStorage unavailable');
  const probe = `${prefix}::__probe`;
  storage.setItem(probe, '1'); storage.removeItem(probe); // throws when blocked
  const k = (col, id) => `${prefix}::${col}::${id}`;
  return {
    kind: 'localstorage', durable: false, sessionOnly: false,
    async get(col, id) { const v = storage.getItem(k(col, id)); return v === null ? null : JSON.parse(v); },
    async put(col, id, doc) { assertName(col, 'collection'); assertName(id, 'id'); storage.setItem(k(col, id), JSON.stringify(doc)); },
    async del(col, id) { storage.removeItem(k(col, id)); },
    async list(col) {
      const pre = `${prefix}::${col}::`; const out = [];
      for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key && key.startsWith(pre)) out.push({ id: key.slice(pre.length), doc: JSON.parse(storage.getItem(key)) }); }
      return out.sort((a, b) => (a.id < b.id ? -1 : 1));
    },
    async clear(col) { for (const { id } of await this.list(col)) storage.removeItem(k(col, id)); },
    async close() {},
  };
}

/* ───────────── IndexedDB (browser / PWA) ───────────── */
export async function createIndexedDBAdapter({ dbName = 'rsl-app', collections = [], indexedDB = globalThis.indexedDB } = {}) {
  if (!indexedDB) throw new Error('IndexedDB unavailable');
  collections.forEach((c) => assertName(c, 'collection'));
  const open = (version) => new Promise((resolve, reject) => {
    const req = version ? indexedDB.open(dbName, version) : indexedDB.open(dbName);
    req.onupgradeneeded = () => { for (const c of collections) if (!req.result.objectStoreNames.contains(c)) req.result.createObjectStore(c); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
  });
  let db = await open();
  const missing = collections.filter((c) => !db.objectStoreNames.contains(c));
  if (missing.length) { const v = db.version + 1; db.close(); db = await open(v); }
  const tx = (col, mode, fn) => new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(col)) return reject(new Error(`Unknown collection "${col}" (declare it in collections)`));
    const t = db.transaction(col, mode); const store = t.objectStore(col); let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    kind: 'indexeddb', durable: false, sessionOnly: false,
    get: (col, id) => tx(col, 'readonly', (s) => req(s.get(String(id)))).then((v) => v ?? null),
    put: (col, id, doc) => { assertName(id, 'id'); return tx(col, 'readwrite', (s) => req(s.put(clone(doc), String(id)))); },
    del: (col, id) => tx(col, 'readwrite', (s) => req(s.delete(String(id)))),
    list: (col) => tx(col, 'readonly', async (s) => {
      const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
      return keys.map((id, i) => ({ id: String(id), doc: vals[i] }));
    }),
    clear: (col) => tx(col, 'readwrite', (s) => req(s.clear())),
    async close() { db.close(); },
  };
}

/* ───────────── SQLite (Tauri plugin-sql, Capacitor SQLite, node:sqlite in tests) ───────────── */
/**
 * @param {{ execute(sql, params):Promise<void>, select(sql, params):Promise<object[]> }} sql
 *   A minimal executor using `?` placeholders. Build it with fromTauriSql / fromCapacitorSqlite.
 */
export async function createSqlAdapter(sql) {
  await sql.execute(
    'CREATE TABLE IF NOT EXISTS rsl_docs (col TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (col, id))', []);
  return {
    kind: 'sqlite', durable: true, sessionOnly: false,
    async get(col, id) {
      const rows = await sql.select('SELECT json FROM rsl_docs WHERE col = ? AND id = ?', [col, String(id)]);
      return rows.length ? JSON.parse(rows[0].json) : null;
    },
    async put(col, id, doc) {
      assertName(col, 'collection'); assertName(id, 'id');
      await sql.execute(
        'INSERT INTO rsl_docs (col, id, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(col, id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
        [col, String(id), JSON.stringify(doc), new Date().toISOString()]);
    },
    async del(col, id) { await sql.execute('DELETE FROM rsl_docs WHERE col = ? AND id = ?', [col, String(id)]); },
    async list(col) {
      const rows = await sql.select('SELECT id, json FROM rsl_docs WHERE col = ? ORDER BY id', [col]);
      return rows.map((r) => ({ id: r.id, doc: JSON.parse(r.json) }));
    },
    async clear(col) { await sql.execute('DELETE FROM rsl_docs WHERE col = ?', [col]); },
    async close() { if (sql.close) await sql.close(); },
  };
}

/** Tauri v2 `@tauri-apps/plugin-sql`: `const db = await Database.load('sqlite:rsl-app.db')`. Uses $1…$n placeholders. */
export function fromTauriSql(db) {
  const conv = (q) => { let i = 0; return q.replace(/\?/g, () => `$${++i}`); };
  return { execute: (q, p) => db.execute(conv(q), p), select: (q, p) => db.select(conv(q), p), close: () => db.close?.() };
}

/** Capacitor SQLite connection (`@capacitor-community/sqlite` or Capawesome SQLite) exposing run/query. */
export function fromCapacitorSqlite(conn) {
  return {
    execute: (q, p) => conn.run(q, p),
    select: async (q, p) => { const r = await conn.query(q, p); return r.values ?? r.rows ?? r ?? []; },
    close: () => conn.close?.(),
  };
}

/** Node ≥ 22 `node:sqlite` DatabaseSync — used by the test suite and CLI tools. */
export function fromNodeSqlite(db) {
  return {
    execute: async (q, p) => { db.prepare(q).run(...p); },
    select: async (q, p) => db.prepare(q).all(...p),
    close: async () => db.close(),
  };
}

/* ───────────── Open with fallback ───────────── */
/**
 * Try factories in order; the first that opens wins. Falls back to memory (session-only).
 * @param {Array<() => Promise<StoragePort>>} factories
 * @returns {Promise<{ port, notice:string|null, tried:string[] }>}
 */
export async function openStorage(factories) {
  const tried = [];
  for (const f of factories) {
    try { const port = await f(); return { port, notice: port.durable ? null : NOTICE_BEST_EFFORT, tried }; }
    catch (e) { tried.push(String(e && e.message || e)); }
  }
  return { port: createMemoryAdapter(), notice: NOTICE_SESSION_ONLY, tried };
}
export const NOTICE_SESSION_ONLY = 'Storage is blocked on this device. Your work is kept only until you close the app. Export a backup before closing.';
export const NOTICE_BEST_EFFORT = 'This device may clear browser storage when space runs low. Export a backup regularly.';

/** Ask the browser for persistent storage; returns true / false / null (API absent). */
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch { return false; }
}

/* ───────────── Migrations (ordered, forward-only) ───────────── */
/**
 * @param {StoragePort} port
 * @param {Array<{ version:number, name:string, up:(port)=>Promise<void> }>} migrations
 * @param {{ beforeEach?: (from, to) => Promise<void> }} opts  e.g. take a snapshot first
 */
export async function runMigrations(port, migrations, { beforeEach } = {}) {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => { if (i && m.version === sorted[i - 1].version) throw new Error(`Duplicate migration version ${m.version}`); });
  const meta = (await port.get('meta', 'schema')) || { version: 0, history: [] };
  for (const m of sorted) {
    if (m.version <= meta.version) continue;
    if (beforeEach) await beforeEach(meta.version, m.version);
    await m.up(port);
    meta.version = m.version;
    meta.history.push({ version: m.version, name: m.name, at: new Date().toISOString() });
    await port.put('meta', 'schema', meta);
  }
  return meta.version;
}

/* ───────────── Backup bundle ───────────── */
/**
 * Versioned, checksummed snapshot. Include the audit chain head so a restored copy can be
 * matched to printed reports.
 */
export async function exportSnapshot(port, { appId, appVersion, collections, auditHead = null }) {
  const data = {};
  for (const c of collections) data[c] = await port.list(c);
  const schema = (await port.get('meta', 'schema')) || { version: 0 };
  const body = { format: 'rsl-backup', formatVersion: 1, appId, appVersion, schemaVersion: schema.version,
    exportedAt: new Date().toISOString(), auditHead, data };
  return { ...body, sha256: await sha256Hex(canonicalJSON(body)) };
}

/** Validates checksum, app and schema version before writing anything. mode 'replace' clears collections first. */
export async function importSnapshot(port, bundle, { appId, maxSchemaVersion, mode = 'replace' }) {
  if (!bundle || bundle.format !== 'rsl-backup' || bundle.formatVersion !== 1) throw new Error('Not an rsL backup file.');
  const { sha256, ...body } = bundle;
  if ((await sha256Hex(canonicalJSON(body))) !== sha256) throw new Error('The backup file is damaged (checksum does not match).');
  if (body.appId !== appId) throw new Error(`This backup belongs to ${body.appId}, not ${appId}.`);
  if (body.schemaVersion > maxSchemaVersion) throw new Error('This backup comes from a newer version of the app. Update the app first.');
  for (const [col, rows] of Object.entries(body.data)) {
    if (mode === 'replace') await port.clear(col);
    for (const { id, doc } of rows) await port.put(col, id, doc);
  }
  return { collections: Object.keys(body.data).length, schemaVersion: body.schemaVersion };
}
