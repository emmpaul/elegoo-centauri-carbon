// Service worker: makes the dashboard installable and lets its shell open
// without the service. Shell files go to the network first, so a running
// service always serves the current page, and fall back to the cached copy
// when it can't be reached. API and camera requests are not touched: live
// data never comes from a cache. The fonts are optional (the operator may not
// have fetched them), so they are never pre-cached: each is stored the first
// time it loads and served from the cache after that.
// A classic script (no import or export), so every browser can register it.

const sw = self as unknown as ServiceWorkerGlobalScope;

/** Bump to drop the old cached shell on the next activation. */
const CACHE = "dashboard-v2";
const SHELL = [
  "/",
  "/app.js",
  "/mjpeg.js",
  "/theme.js",
  "/view.js",
  "/stop-slide.js",
  "/commands.js",
  "/src/control-rules.ts",
  "/style.css",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
];
const FONTS = ["/fonts/satoshi-400.woff2", "/fonts/satoshi-500.woff2", "/fonts/satoshi-700.woff2", "/fonts/cabinet-grotesk-800.woff2"];

sw.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => sw.skipWaiting()),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => sw.clients.claim()),
  );
});

sw.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== sw.location.origin) return;
  if (FONTS.includes(url.pathname)) {
    event.respondWith(
      caches.match(url.pathname).then(
        (cached) =>
          cached ??
          fetch(event.request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              void caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
            }
            return response;
          }),
      ),
    );
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
        }
        return response;
      })
      .catch(async () => (await caches.match(url.pathname)) ?? Response.error()),
  );
});
