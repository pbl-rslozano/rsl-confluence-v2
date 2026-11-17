// WP28 Task 9: the gateway backup target. The encrypted file goes to the user's own B2 or R2 bucket through the
// loopback gateway, which holds the bucket key in memory. This module never sees a bucket key. Errors carry a code or a
// status only: never gateway text, a URL, the token or a key.
import { BackupError, BACKUP_FILE_RE, BACKUP_MAX_FILE_BYTES, utf8Bytes } from "./backup-crypto";
import type { BackupFileInfo, BackupTarget } from "./backup-targets";
import { isBucketProvider, isLoopbackGateway, normalizeGatewayUrl } from "./private-api";
import type { ProviderLink, ProviderProfile } from "./private-api";

const MAX_LIST = 20;
const LIST_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 5 * 60_000;

type Fetcher = typeof fetch;

/** The caller's signal and a deadline, as one signal (AbortSignal.any where the runtime has it). */
function withDeadline(signal: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void } {
  const timer = new AbortController();
  const id = setTimeout(() => timer.abort(), ms);
  const parts = signal ? [signal, timer.signal] : [timer.signal];
  let combined: AbortSignal;
  if (typeof AbortSignal.any === "function") combined = AbortSignal.any(parts);
  else {
    const c = new AbortController();
    for (const s of parts) {
      if (s.aborted) c.abort();
      else s.addEventListener("abort", () => c.abort(), { once: true });
    }
    combined = c.signal;
  }
  return { signal: combined, done: () => clearTimeout(id) };
}

function mapStatus(status: number): BackupError {
  if (status === 401) return new BackupError("gateway");
  if (status === 409) return new BackupError("needs-gateway");
  if (status === 413) return new BackupError("too-large-file");
  if (status === 400) return new BackupError("format");
  return new BackupError("http", { status });
}

function toInfo(value: unknown): BackupFileInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || !BACKUP_FILE_RE.test(v.name)) return null;
  if (typeof v.size !== "number" || !Number.isFinite(v.size) || v.size < 0 || v.size > BACKUP_MAX_FILE_BYTES) return null;
  const t = typeof v.modifiedAt === "string" && v.modifiedAt.length <= 64 ? Date.parse(v.modifiedAt) : NaN;
  if (!Number.isFinite(t)) return null;
  return { id: v.name, name: v.name, size: Math.floor(v.size), modifiedAt: t };
}

/** The body as text, never more than the file cap: Content-Length first, then the stream (cancelled at the cap). */
async function readCappedText(response: Response): Promise<string> {
  const declared = Number(response.headers?.get("content-length"));
  if (Number.isFinite(declared) && declared > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (text.length > BACKUP_MAX_FILE_BYTES || utf8Bytes(text) > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
    return text;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > BACKUP_MAX_FILE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new BackupError("too-large-file");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return new TextDecoder().decode(all);
}

export function gatewayBackupTarget(link: ProviderLink, profile: ProviderProfile, fetcher: Fetcher = fetch): BackupTarget {
  const base = normalizeGatewayUrl(link.session.url);
  const token = link.session.token.trim();
  if (!isLoopbackGateway(base) || !token) throw new BackupError("gateway");
  if (!isBucketProvider(profile.provider)) throw new BackupError("unsupported");
  const provider = profile.provider;
  const query = (name?: string): string => `?profile=${encodeURIComponent(profile.id)}${name ? `&name=${encodeURIComponent(name)}` : ""}`;

  async function call(path: string, init: RequestInit, ms: number, signal?: AbortSignal): Promise<Response> {
    const deadline = withDeadline(signal, ms);
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, { ...init, cache: "no-store", headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) }, signal: deadline.signal });
    } catch {
      deadline.done();
      throw new BackupError(signal?.aborted ? "cancelled" : deadline.signal.aborted ? "timeout" : "network"); // the original message is dropped on purpose
    }
    deadline.done();
    if (!response.ok) throw mapStatus(response.status);
    return response;
  }

  return {
    provider,
    async upload(name, text, signal) {
      if (typeof name !== "string" || !BACKUP_FILE_RE.test(name) || typeof text !== "string") throw new BackupError("format");
      if (text.length > BACKUP_MAX_FILE_BYTES || utf8Bytes(text) > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
      const response = await call(`/backup/upload${query(name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: text }, TRANSFER_TIMEOUT_MS, signal);
      const info = toInfo(await response.json().catch(() => null));
      if (!info || info.name !== name) throw new BackupError("http", { status: response.status });
      return info;
    },
    async list(signal) {
      const response = await call(`/backup/list${query()}`, {}, LIST_TIMEOUT_MS, signal);
      const payload = (await response.json().catch(() => null)) as { files?: unknown } | null;
      if (!payload || !Array.isArray(payload.files)) throw new BackupError("http", { status: response.status });
      const out: BackupFileInfo[] = [];
      for (const f of payload.files) {
        const info = toInfo(f);
        if (info) out.push(info);
      }
      return out.sort((a, b) => b.modifiedAt - a.modifiedAt || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0)).slice(0, MAX_LIST);
    },
    async download(f, signal) {
      if (!f || typeof f.name !== "string" || !BACKUP_FILE_RE.test(f.name)) throw new BackupError("format");
      if (typeof f.size !== "number" || !Number.isFinite(f.size) || f.size < 0) throw new BackupError("format");
      if (f.size > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
      const response = await call(`/backup/download${query(f.name)}`, {}, TRANSFER_TIMEOUT_MS, signal);
      return readCappedText(response);
    },
  };
}
