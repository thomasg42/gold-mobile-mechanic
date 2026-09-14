const CACHE = "gold-mobile-mechanic-v30-paired";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./sync-auth.js",
  "./voice-config.js",
  "./voice.js",
  "./assistant.js",
  "./portal.html",
  "./portal.js",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // The application shell only. API responses were being written to the cache
  // too, which put every customer's name, phone and job history on disk in a
  // store nothing re-checks the pairing against — and served them back from
  // there. The app's own offline copy lives in localStorage and IndexedDB.
  if (new URL(event.request.url).pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html")))
  );
});
