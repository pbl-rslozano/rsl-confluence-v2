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

/** fetch without credentials, referrer or redirects. A response above 20 MB is refused (header first, then text). */
export const webBackupHttp: BackupHttp = async (r) => {
  gate(r.url);
  let res: Response;
  try {
    res = await fetch(r.url, {
      method: r.method,
      headers: r.headers,
      body: r.body,
      signal: r.signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new BackupError(r.signal?.aborted ? "cancelled" : "network");
  }
  const len = Number(res.headers.get("content-length"));
  if (Number.isFinite(len) && len > BACKUP_MAX_FILE_BYTES) throw new BackupError("too-large-file");
  let text: string;
  try {
    text = await res.text();
  } catch {
    throw new BackupError(r.signal?.aborted ? "cancelled" : "network");
  }
  checkTextSize(text);
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return { status: res.status, headers, text };
};

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
    checkTextSize(res.text);
    return res;
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
