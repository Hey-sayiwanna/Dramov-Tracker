const CACHE_NAME = "dramov-pwa-v42";
// 海报 / 剧照 / 平台图标的本机缓存：跨版本保留；看过的图下次直接从手机里读。
// 最多 1500 张（海报一张几十 KB，满了大约一两百 MB，远低于 500MB），满了先删最早存的
const IMG_CACHE = "dramov-img-v2";
const IMG_MAX = 1500;
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== IMG_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // 外站图片：先读本机缓存，没有再下载并存下（取色用的 cors 请求不经过这里）
  if (req.destination === "image" && req.mode === "no-cors" && url.origin !== self.location.origin && /^https?:$/.test(url.protocol)) {
    event.respondWith(cachedImage(req));
    return;
  }

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

let imgPuts = 0;
const noCorsHosts = new Set();
async function cachedImage(req) {
  let cache = null;
  try {
    cache = await caches.open(IMG_CACHE);
    const hit = await cache.match(req.url);
    if (hit) return hit;
  } catch (e) {}
  const host = new URL(req.url).host;
  if (noCorsHosts.has(host)) return fetch(req);
  let res = null;
  try {
    // 先试 cors（能存成普通响应，占空间小）；图片站不支持 cors 就按原样请求，并记住这个站以后不再试
    res = await fetch(req.url, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    noCorsHosts.add(host);
    return fetch(req);
  }
  // 只存确认成功的图片
  if (cache && res && res.ok && res.type !== "opaque") {
    cache.put(req.url, res.clone()).then(() => {
      if (++imgPuts % 40 === 0) trimImageCache(cache);
    }).catch(() => {});
  }
  return res;
}
async function trimImageCache(cache) {
  try {
    const keys = await cache.keys();
    if (keys.length <= IMG_MAX) return;
    await Promise.all(keys.slice(0, keys.length - IMG_MAX).map((k) => cache.delete(k)));
  } catch (e) {}
}
