// WP28 Task 5: the storage targets of cloud backup (Google Drive app data, OneDrive app folder, pCloud) over the
// backup HTTP port. Every request URL passes `isAllowedBackupUrl` (or its OneDrive-download-origin twin) before it is
// sent, and so does the Google resumable-session URL, which is treated as untrusted. Errors carry a code, a status or
// an origin only: never upstream text, a URL, a header or a token.
import { BackupError, BACKUP_FILE_RE, BACKUP_MAX_FILE_BYTES, utf8Bytes } from "./backup-crypto";
import type { BackupHttp, BackupRequest, BackupResponse } from "./backup-http";
import type { BackupProviderId, OAuthProviderId } from "./backup-providers";
import { clearSession } from "./backup-session";
import type { ProviderSession } from "./backup-session";
import { BACKUP_NATIVE_URLS, ONEDRIVE_DOWNLOAD_ORIGINS, PCLOUD_API_HOSTS, urlAllowed } from "./public-hosts";

export interface BackupFileInfo {
  id: string;
  name: string;
  size: number;
  modifiedAt: number;
}

export interface BackupTarget {
  provider: BackupProviderId;
  upload(name: string, text: string, signal?: AbortSignal): Promise<BackupFileInfo>;
  list(signal?: AbortSignal): Promise<BackupFileInfo[]>;
  download(f: BackupFileInfo, signal?: AbortSignal): Promise<string>;
}

const MAX_LIST = 20;
const MAX_ID_CHARS = 200;
const GDRIVE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;
const ONEDRIVE_ID_RE = /^[A-Za-z0-9!_-]{1,200}$/;
const PCLOUD_ID_RE = /^[0-9]{1,20}$/;

/** Same gate as `isAllowedBackupUrl`, plus any extra origins this target was explicitly given (OneDrive downloads). */
function gated(url: string, extra: readonly string[] = []): boolean {
  return urlAllowed(url, BACKUP_NATIVE_URLS, [...ONEDRIVE_DOWNLOAD_ORIGINS, ...extra]);
}

/** multipart/form-data body, CRLF line ends (RFC 2046). A header with a line break, or a body holding the boundary, is refused. */
export function multipartBody(parts: { headers: Record<string, string>; body: string }[], boundary: string): string {
  if (!/^[0-9A-Za-z'()+_,.\/:=?-]{8,70}$/.test(boundary)) throw new BackupError("format");
  let out = "";
  for (const p of parts) {
    if (p.body.includes("--" + boundary)) throw new BackupError("format");
    out += "--" + boundary + "\r\n";
    for (const [k, v] of Object.entries(p.headers)) {
      if (/[\r\n:]/.test(k) || /[\r\n]/.test(v)) throw new BackupError("format");
      out += k + ": " + v + "\r\n";
    }
    out += "\r\n" + p.body + "\r\n";
  }
  return out + "--" + boundary + "--\r\n";
}

function randomBoundary(avoid: string): string {
  for (let i = 0; i < 8; i++) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    const id = "rslbk" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    if (!avoid.includes(id)) return id;
  }
  throw new BackupError("format");
}

interface Ctx {
  provider: OAuthProviderId;
  s: ProviderSession;
  http: BackupHttp;
}

function authHeaders(c: Ctx, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: "Bearer " + c.s.token, ...extra };
}

/** Gate, send, map the status. 401/403 clears the session. Nothing from the response body reaches an error. */
async function send(c: Ctx, r: BackupRequest, okStatuses: readonly number[] = [200], extraOrigins: readonly string[] = []): Promise<BackupResponse> {
  if (!c.s.token) throw new BackupError("session");
  if (!gated(r.url, extraOrigins)) throw new BackupError("unavailable");
  const res = await c.http(r);
  if (res.status === 401 || res.status === 403) {
    clearSession(c.provider);
    throw new BackupError("session");
  }
  if (!okStatuses.includes(res.status)) throw new BackupError("http", { status: res.status });
  return res;
}

function parseJson(res: BackupResponse): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(res.text);
  } catch {
    throw new BackupError("http", { status: res.status });
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BackupError("http", { status: res.status });
  return v as Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** One validated file entry, or null for anything foreign or hostile (dropped, never thrown). */
function entry(id: unknown, name: unknown, size: unknown, modified: unknown, idRe: RegExp): BackupFileInfo | null {
  if (typeof id !== "string" || id.length > MAX_ID_CHARS || !idRe.test(id)) return null;
  if (typeof name !== "string" || !BACKUP_FILE_RE.test(name)) return null;
  const n = typeof size === "string" && size.trim() !== "" ? Number(size) : size;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > BACKUP_MAX_FILE_BYTES) return null;
  const t = typeof modified === "string" && modified.length <= 64 ? Date.parse(modified) : NaN;
  if (!Number.isFinite(t)) return null;
  return { id, name, size: Math.floor(n), modifiedAt: t };
}

function newestFirst(files: BackupFileInfo[]): BackupFileInfo[] {
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)).slice(0, MAX_LIST);
}

function checkUpload(name: string, text: string): void {
  if (typeof name !== "string" || !BACKUP_FILE_RE.test(name)) throw new BackupError("format");
  if (typeof text !== "string") throw new BackupError("format");
  if (text.length > BACKUP_MAX_FILE_BYTES || utf8Bytes(text) > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
}

function checkDownload(f: BackupFileInfo, idRe: RegExp): void {
  if (!f || typeof f.id !== "string" || !idRe.test(f.id)) throw new BackupError("format");
  if (typeof f.size !== "number" || !Number.isFinite(f.size) || f.size < 0) throw new BackupError("format");
  if (f.size > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
}

function checkBody(text: string): string {
  if (text.length > BACKUP_MAX_FILE_BYTES || utf8Bytes(text) > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
  return text;
}

// ---------------------------------------------------------------------------------------------------- Google Drive

const GOOGLE_ORIGIN = "https://www.googleapis.com";

export function gdriveTarget(s: ProviderSession, http: BackupHttp): BackupTarget {
  const c: Ctx = { provider: "gdrive", s, http };
  return {
    provider: "gdrive",
    async upload(name, text, signal) {
      checkUpload(name, text);
      const init = await send(
        c,
        {
          method: "POST",
          url: GOOGLE_ORIGIN + "/upload/drive/v3/files?uploadType=resumable",
          headers: authHeaders(c, { "Content-Type": "application/json; charset=UTF-8" }),
          body: JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json" }),
          signal,
        },
      );
      // The session URL comes from the server: untrusted. It must pass the gate and stay on the same origin.
      const location = init.headers["location"];
      let sameOrigin = false;
      try {
        sameOrigin = typeof location === "string" && new URL(location).origin === GOOGLE_ORIGIN;
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin || !gated(location)) throw new BackupError("http", { status: init.status });
      const res = await send(
        c,
        { method: "PUT", url: location, headers: authHeaders(c, { "Content-Type": "application/json" }), body: text, signal },
        [200, 201],
      );
      const o = parseJson(res);
      const id = typeof o.id === "string" && GDRIVE_ID_RE.test(o.id) ? o.id : null;
      if (!id) throw new BackupError("http", { status: res.status });
      return { id, name, size: utf8Bytes(text), modifiedAt: Date.now() };
    },
    async list(signal) {
      const res = await send(c, {
        method: "GET",
        url: GOOGLE_ORIGIN + "/drive/v3/files?spaces=appDataFolder&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=100",
        headers: authHeaders(c),
        signal,
      });
      const files = parseJson(res).files;
      if (!Array.isArray(files)) throw new BackupError("http", { status: res.status });
      const out: BackupFileInfo[] = [];
      for (const f of files) {
        if (!isRecord(f)) continue;
        const e = entry(f.id, f.name, f.size, f.modifiedTime, GDRIVE_ID_RE);
        if (e) out.push(e);
      }
      return newestFirst(out);
    },
    async download(f, signal) {
      checkDownload(f, GDRIVE_ID_RE);
      const res = await send(c, { method: "GET", url: GOOGLE_ORIGIN + "/drive/v3/files/" + f.id + "?alt=media", headers: authHeaders(c), signal });
      return checkBody(res.text);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- OneDrive

const GRAPH = "https://graph.microsoft.com/v1.0";

/** `deps.downloadOrigins`: extra pre-authenticated download origins (tests only; empty by default, like the frozen list). */
export function onedriveTarget(s: ProviderSession, http: BackupHttp, deps: { downloadOrigins?: readonly string[] } = {}): BackupTarget {
  const c: Ctx = { provider: "onedrive", s, http };
  const extra = [...(deps.downloadOrigins ?? [])];
  for (const o of extra) {
    let ok = false;
    try {
      ok = o.startsWith("https://") && new URL(o).origin === o;
    } catch {
      ok = false;
    }
    if (!ok) throw new BackupError("unavailable");
  }
  const origins = [...ONEDRIVE_DOWNLOAD_ORIGINS, ...extra];
  return {
    provider: "onedrive",
    async upload(name, text, signal) {
      checkUpload(name, text); // the name matches BACKUP_FILE_RE, so it holds no "%", "..", "/" or other path character
      const res = await send(
        c,
        {
          method: "PUT",
          url: GRAPH + "/me/drive/special/approot:/" + name + ":/content",
          headers: authHeaders(c, { "Content-Type": "application/json" }),
          body: text,
          signal,
        },
        [200, 201],
      );
      const o = parseJson(res);
      const id = typeof o.id === "string" && ONEDRIVE_ID_RE.test(o.id) ? o.id : null;
      if (!id) throw new BackupError("http", { status: res.status });
      return { id, name, size: utf8Bytes(text), modifiedAt: Date.now() };
    },
    async list(signal) {
      const res = await send(c, {
        method: "GET",
        url: GRAPH + "/me/drive/special/approot/children?$select=id,name,size,lastModifiedDateTime&$top=200",
        headers: authHeaders(c),
        signal,
      });
      const items = parseJson(res).value;
      if (!Array.isArray(items)) throw new BackupError("http", { status: res.status });
      const out: BackupFileInfo[] = [];
      for (const f of items) {
        if (!isRecord(f) || "folder" in f) continue;
        const e = entry(f.id, f.name, f.size, f.lastModifiedDateTime, ONEDRIVE_ID_RE);
        if (e) out.push(e);
      }
      return newestFirst(out);
    },
    async download(f, signal) {
      checkDownload(f, ONEDRIVE_ID_RE);
      const meta = await send(c, {
        method: "GET",
        url: GRAPH + "/me/drive/items/" + f.id + "?$select=id,size,@microsoft.graph.downloadUrl",
        headers: authHeaders(c),
        signal,
      });
      const o = parseJson(meta);
      if (typeof o.size === "number" && o.size > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
      const dl = o["@microsoft.graph.downloadUrl"];
      if (typeof dl !== "string" || dl.length > 4096) throw new BackupError("http", { status: meta.status });
      let origin: string;
      try {
        origin = new URL(dl).origin;
      } catch {
        throw new BackupError("download-host");
      }
      // Owner ruling: the download host is unverified until the manual check, so an unlisted origin is refused, never followed.
      if (!origins.includes(origin)) throw new BackupError("download-host", { origin });
      // The pre-authenticated URL carries its own grant: the bearer token is NOT sent to that host.
      const res = await send(c, { method: "GET", url: dl, signal }, [200], extra);
      return checkBody(res.text);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- pCloud

export function pcloudTarget(s: ProviderSession, http: BackupHttp): BackupTarget {
  const c: Ctx = { provider: "pcloud", s, http };
  const host = (PCLOUD_API_HOSTS as readonly string[]).includes(s.apiHost ?? "") ? s.apiHost : undefined;
  const FOLDER = "%2FrsL%20Confluence%20Backup"; // "/rsL Confluence Backup", in the query only (the gate ignores it)
  const base = (): string => {
    if (!host) throw new BackupError("unavailable");
    return "https://" + host;
  };
  /** pCloud answers 200 with a JSON `result`. 2000 is "log in required". */
  const checkResult = (o: Record<string, unknown>, status: number): void => {
    if (typeof o.result !== "number" || !Number.isFinite(o.result)) throw new BackupError("http", { status });
    if (o.result === 1000 || o.result === 2000 || o.result === 2094) { // login required, login failed, invalid access_token
      clearSession("pcloud");
      throw new BackupError("session");
    }
    if (o.result !== 0) throw new BackupError("http", { status: o.result });
  };
  const fileEntry = (m: unknown): BackupFileInfo | null => {
    if (!isRecord(m) || m.isfolder === true) return null;
    const id = typeof m.fileid === "number" && Number.isSafeInteger(m.fileid) && m.fileid >= 0 ? String(m.fileid) : null;
    return entry(id, m.name, m.size, m.modified, PCLOUD_ID_RE);
  };
  return {
    provider: "pcloud",
    async upload(name, text, signal) {
      checkUpload(name, text);
      const boundary = randomBoundary(text);
      const body = multipartBody(
        [{ headers: { "Content-Disposition": `form-data; name="file"; filename="${name}"`, "Content-Type": "application/json" }, body: text }],
        boundary,
      );
      const made = await send(c, { method: "GET", url: base() + "/createfolderifnotexists?path=" + FOLDER, headers: authHeaders(c), signal });
      checkResult(parseJson(made), made.status);
      const res = await send(c, {
        method: "POST",
        url: base() + "/uploadfile?path=" + FOLDER + "&filename=" + name + "&nopartial=1",
        headers: authHeaders(c, { "Content-Type": "multipart/form-data; boundary=" + boundary }),
        body,
        signal,
      });
      const o = parseJson(res);
      checkResult(o, res.status);
      const meta = Array.isArray(o.metadata) ? o.metadata[0] : undefined;
      const id = isRecord(meta) && typeof meta.fileid === "number" && Number.isSafeInteger(meta.fileid) && meta.fileid >= 0 ? String(meta.fileid) : null;
      if (!id) throw new BackupError("http", { status: res.status });
      return { id, name, size: utf8Bytes(text), modifiedAt: Date.now() };
    },
    async list(signal) {
      const res = await send(c, { method: "GET", url: base() + "/listfolder?path=" + FOLDER, headers: authHeaders(c), signal });
      const o = parseJson(res);
      if (o.result === 2005) return []; // the folder does not exist yet: nothing has been backed up
      checkResult(o, res.status);
      const contents = isRecord(o.metadata) ? o.metadata.contents : undefined;
      if (!Array.isArray(contents)) throw new BackupError("http", { status: res.status });
      const out: BackupFileInfo[] = [];
      for (const m of contents) {
        const e = fileEntry(m);
        if (e) out.push(e);
      }
      return newestFirst(out);
    },
    async download(f, signal) {
      checkDownload(f, PCLOUD_ID_RE);
      const res = await send(c, { method: "GET", url: base() + "/gettextfile?fileid=" + f.id, headers: authHeaders(c), signal });
      const text = checkBody(res.text);
      // A failure comes back as a small JSON `{ result: <code> }`; a backup envelope never has a `result` field.
      if (text.length < 4096 && text.trimStart().startsWith("{")) {
        try {
          const o: unknown = JSON.parse(text);
          if (isRecord(o) && typeof o.result === "number") checkResult(o, res.status);
        } catch (e) {
          if (e instanceof BackupError) throw e;
        }
      }
      return text;
    },
  };
}
