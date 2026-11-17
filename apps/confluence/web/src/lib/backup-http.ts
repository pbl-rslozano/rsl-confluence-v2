// WP28 Task 4: the HTTP port of cloud backup. Every token and storage request goes through `isAllowedBackupUrl`
// before it leaves the app, on the web path and on the native path alike (native HTTP is not subject to the CSP).
// Errors carry a code only: never the original message, a URL, a header or a body.
import { BackupError, BACKUP_MAX_FILE_BYTES, utf8Bytes } from "./backup-crypto";
import { isAllowedBackupUrl } from "./public-hosts";

export interface BackupRequest {
  method: "GET" | "POST" | "PUT";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface BackupResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
}
export type BackupHttp = (r: BackupRequest) => Promise<BackupResponse>;

function gate(url: string): void {
  if (!isAllowedBackupUrl(url)) throw new BackupError("unavailable");
}

function checkTextSize(text: string): void {
  // Bytes are at least the length and at most three times it: only the middle band needs the exact count.
  if (text.length > BACKUP_MAX_FILE_BYTES || (text.length * 3 > BACKUP_MAX_FILE_BYTES && utf8Bytes(text) > BACKUP_MAX_FILE_BYTES)) {
    throw new BackupError("too-large-file");
  }
}

/**
 * Final review M-3: the web path gets the native shells' deadline. 15 s to the response headers (the native connect
 * timeout), plus the request body at the minimum rate; then the body, by its Content-Length (or the 20 MB file limit
 * when there is none) at the minimum rate, plus 15 s. A redirect is never followed and is the same error on every shell.
 */
export const BACKUP_HEADERS_TIMEOUT_MS = 15_000;
/** The slowest transfer rate the deadline allows for (64 KiB/s: a 20 MB file gets about 5½ minutes). */
export const BACKUP_MIN_BYTES_PER_SEC = 64 * 1024;
export interface BackupHttpTiming { headersMs: number; bytesPerSecond: number }

const transferMs = (t: BackupHttpTiming, bytes: number) => t.headersMs + Math.ceil((bytes / t.bytesPerSecond) * 1000);
/** A 3xx answer (or the opaque redirect fetch returns with redirect: "manual"): one code everywhere. */
const redirectError = () => new BackupError("http", { status: "3xx" });
const isRedirect = (status: number) => status >= 300 && status < 400;

/** The caller's signal plus a deadline that can be moved, as one signal (AbortSignal.any where the runtime has it). */
function deadlineSignal(signal: AbortSignal | undefined) {
  const timer = new AbortController();
  let fired = false;
  let id: ReturnType<typeof setTimeout> | undefined;
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
  return {
    signal: combined,
    arm(ms: number) { if (id !== undefined) clearTimeout(id); id = setTimeout(() => { fired = true; timer.abort(); }, ms); },
    done() { if (id !== undefined) clearTimeout(id); },
    timedOut: () => fired,
  };
}

/** fetch without credentials, referrer or redirects, with a deadline. A response above 20 MB is refused (header first, then text). */
export function webBackupHttpWith(timing: BackupHttpTiming): BackupHttp {
  return async (r) => {
    gate(r.url);
    const d = deadlineSignal(r.signal);
    const fail = () => new BackupError(r.signal?.aborted ? "cancelled" : d.timedOut() ? "timeout" : "network");
    try {
      let res: Response;
      d.arm(transferMs(timing, r.body ? utf8Bytes(r.body) : 0));
      try {
        res = await fetch(r.url, {
          method: r.method,
          headers: r.headers,
          body: r.body,
          signal: d.signal,
          credentials: "omit",
          redirect: "manual",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
      } catch {
        throw fail();
      }
      if (res.type === "opaqueredirect" || isRedirect(res.status)) throw redirectError();
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
      d.arm(transferMs(timing, res.headers.get("content-length") !== null && Number.isFinite(len) && len >= 0 ? len : BACKUP_MAX_FILE_BYTES));
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw fail();
      }
      checkTextSize(text);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
      return { status: res.status, headers, text };
    } finally {
      d.done();
    }
  };
}

export const webBackupHttp: BackupHttp = webBackupHttpWith({ headersMs: BACKUP_HEADERS_TIMEOUT_MS, bytesPerSecond: BACKUP_MIN_BYTES_PER_SEC });

let nativeRequest: BackupHttp | null = null;

/** The shell adapter (Tauri HTTP plugin, Capacitor native HTTP) installs its request function here. */
export function setBackupNativeRequest(fn: BackupHttp | null): void {
  nativeRequest = fn;
}

/** Native when installed, else the web fetch. The native function is gated and its failures are sanitised. */
export function backupHttp(): BackupHttp {
  const native = nativeRequest;
  if (!native) return webBackupHttp;
  return async (r) => {
    gate(r.url);
    let res: BackupResponse;
    try {
      res = await native(r);
    } catch (e) {
      if (e instanceof BackupError) throw e;
      if (e instanceof Error && e.message === "too-large-file") throw new BackupError("too-large-file");
      throw new BackupError(r.signal?.aborted ? "cancelled" : "network");
    }
    if (isRedirect(res.status)) throw redirectError();
    checkTextSize(res.text);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = v;
    return { status: res.status, headers, text: res.text };
  };
}

/**
 * The shell's sign-in broker: the desktop's loopback listener or the phone's app link. It resolves with the full
 * redirect URL (query and fragment kept) or rejects with Error("timeout" | "port-busy" | "cancelled").
 */
export interface ShellOAuth {
  kind: "loopback" | "applink";
  authorize(url: string, o: { redirectUri: string; relayFragment: boolean; timeoutMs: number; signal?: AbortSignal }): Promise<string>;
}

let shellBroker: ShellOAuth | null = null;
export function setShellOAuth(o: ShellOAuth | null): void {
  shellBroker = o;
}
export function shellOAuth(): ShellOAuth | null {
  return shellBroker;
}
