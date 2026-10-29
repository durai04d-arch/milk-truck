const CACHE_NAME = "milk-truck-live-v2";
const APP_SHELL = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png"];
self.addEventListener("install", event => { event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(req).then(cached => cached || fetch(req).then(res => {
    if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then(cache => cache.put(req, copy)); }
    return res;
  }).catch(() => caches.match("./index.html"))));
});