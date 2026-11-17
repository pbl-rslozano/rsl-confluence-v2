// WP28 Task 4: OAuth access tokens, in module memory only. Never written to localStorage, sessionStorage, IndexedDB,
// a backup, a log, an audit entry or a URL. A reload clears them. No refresh token is ever kept.
import type { OAuthProviderId } from "./backup-providers";

export interface ProviderSession {
  token: string;
  /** Epoch ms, or null when the provider's token carries no expiry (pCloud). */
  expiresAt: number | null;
  apiHost?: "api.pcloud.com" | "eapi.pcloud.com";
}

const sessions = new Map<OAuthProviderId, ProviderSession>();

/** An expired session is cleared and gives null. Callers get a copy. */
export function getSession(p: OAuthProviderId, now: number = Date.now()): ProviderSession | null {
  const s = sessions.get(p);
  if (!s) return null;
  if (s.expiresAt !== null && now >= s.expiresAt) {
    sessions.delete(p);
    return null;
  }
  return { ...s };
}

export function setSession(p: OAuthProviderId, s: ProviderSession): void {
  sessions.set(p, { token: s.token, expiresAt: s.expiresAt, ...(s.apiHost ? { apiHost: s.apiHost } : {}) });
}

export function clearSession(p: OAuthProviderId): void {
  sessions.delete(p);
}

export function clearAllSessions(): void {
  sessions.clear();
}
