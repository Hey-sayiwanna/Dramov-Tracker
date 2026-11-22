const CACHE_NAME = "dramov-pwa-v31";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./apple-touch-icon.png?v=10",
  "./icon-192.png?v=10",
  "./icon-512.png?v=10",
  "./icon-maskable-512.png?v=10"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (
    url.pathname.endsWith("/sw.js") || // 版本检查：每次直连网络，不进缓存
    url.pathname.startsWith("/api/") ||
    url.hostname.includes("github.com") ||
    url.hostname.includes("justwatch.com") ||
    url.hostname.includes("tvmaze.com") ||
    url.hostname.includes("itunes.apple.com") ||
    url.hostname.includes("mzstatic.com") ||
    url.hostname.includes("themoviedb.org")
  ) {
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req.url, { cache: "no-cache" })
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html").then((c) => c || caches.match("./")))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
  }
});
