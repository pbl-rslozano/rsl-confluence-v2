/**
 * cache.ts — tiny TTL cache for server-side market data.
 * Avoids re-hitting Binance on every client refresh; the indicator-heavy
 * 100-symbol universe only needs to be re-fetched when the cache expires.
 */

interface Entry<T> {
  value: T;
  expires: number;
}

export class TtlCache<T> {
  private store = new Map<string, Entry<T>>();

  constructor(private defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, {
      value,
      expires: Date.now() + (ttlMs ?? this.defaultTtlMs),
    });
  }

  /** Run `fn` once per key even under concurrent callers (in-flight dedup). */
  private inflight = new Map<string, Promise<T>>();
  async getOrSet(key: string, fn: () => Promise<T>, ttlMs?: number): Promise<T> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = fn().then((v) => {
      this.set(key, v, ttlMs);
      this.inflight.delete(key);
      return v;
    }).catch((e) => {
      this.inflight.delete(key);
      throw e;
    });
    this.inflight.set(key, p);
    return p;
  }
}
