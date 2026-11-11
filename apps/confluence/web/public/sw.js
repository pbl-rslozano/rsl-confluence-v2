/**
 * sw.js — Service Worker for the Confluence Terminal PWA.
 *
 * Caching strategy:
 *   - App shell (HTML/JS/CSS/fonts): stale-while-revalidate, so the app
 *     opens instantly even offline. The dashboard UI renders from cache;
 *     live market data still requires network (Binance).
 *   - Static assets (icons, manifest): cache-first.
 *   - API + external (Binance) + same-origin market-data rewrites (/x/…,
 *     Coins.ph since v2.6): network-only (always fresh, never cached —
 *     market data must be live).
 *
 * On Android, when installed as a PWA, this lets the app boot offline and
 * show the last-known UI while waiting for fresh data to arrive.
 */

// Stamped per release (release check R15: v<APP.version>-<APP.build>); a new value is what makes browsers
// see a new service worker, so the "Reload to update" notice can appear (ADR-0012).
const CACHE_VERSION = "v2.6.0-20261107";
const SHELL_CACHE = `confluence-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `confluence-assets-${CACHE_VERSION}`;

// Files that form the offline-capable app shell.
const SHELL_URLS = ["./", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS)),
    // v2.5.1: no automatic skipWaiting — a new version waits until the user chooses "Reload to update"
    // (or every tab closes), so a running session never switches code underneath the user.
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => !k.endsWith(CACHE_VERSION))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle GET.
  if (req.method !== "GET") return;

  // Never intercept API calls or external market data — must always be live.
  // v2.6: /x/ is the same-origin market-data rewrite (Coins.ph, ADR-0013); it is data, not app shell.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/x/") || url.hostname !== self.location.hostname) {
    return;
  }

  // The update manifest and APKs are never cached by the service worker (ADR-0012).
  if (url.pathname.startsWith("/updates/")) return;

  // Static assets (icons, manifest, fonts): cache-first.
  if (
    url.pathname.startsWith("/icon") ||
    url.pathname.startsWith("/favicon") ||
    url.pathname.startsWith("/apple-touch") ||
    url.pathname.endsWith(".webmanifest") ||
    url.pathname.endsWith(".woff2")
  ) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Navigations are network-first so a cached release never masks an update.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(async (response) => {
        if (response.ok) {
          try {
            const cache = await caches.open(SHELL_CACHE);
            await cache.put(req, response.clone());
          } catch {
            // A cache failure should never prevent an online navigation.
          }
        }
        return response;
      }).catch(async () => (await caches.match(req)) ?? caches.match("./")),
    );
    return;
  }

  // App shell (JS/CSS): stale-while-revalidate.
  event.respondWith(
    caches.open(SHELL_CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            // Only cache successful, same-origin responses.
            if (res.ok && res.type === "basic") {
              cache.put(req, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      }),
    ),
  );
});
