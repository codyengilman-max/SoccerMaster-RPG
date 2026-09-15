/* global self, caches, fetch, Response */
// Service worker template. `vite build` fills VERSION (a hash of the built asset list) and
// PRECACHE (the files to cache up front) via the placeholders below; see vite.config.ts.
// The app is a static shell with all game content bundled, so once installed it plays offline;
// saves live in localStorage and never touch the network.
const VERSION = "__VERSION__";
const CACHE = `soccermaster-rpg-${VERSION}`;
const PRECACHE = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const sameOrigin = (url) => url.origin === self.location.origin;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return;

  // Navigations: try the network for a fresh shell, fall back to the cached one offline.
  // Only a successful shell is cached: an error page from a mid-deploy host would otherwise
  // become the offline fallback and every later offline start would show it.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((hit) => hit || Response.error()))
    );
    return;
  }

  // Everything else is content-hashed or static: cache first, fill the cache on a miss.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
    )
  );
});
