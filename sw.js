/* Offline cache for Face Tag. Models and the engine are cached after first use. */
var VERSION = 'facetag-v9';
var CORE = ['./', 'index.html', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'lib/human.js', 'air-guitar.html', 'guitar.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  var heavy = /\/(models|lib|samples)\//.test(url.pathname);
  if (heavy) {                                   // cache first: these never change for a version
    e.respondWith(caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (r) { var c = r.clone(); caches.open(VERSION).then(function (ch) { ch.put(req, c); }); return r; });
    }));
  } else {                                       // network first, fall back to cache when offline
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (r) { var c = r.clone(); caches.open(VERSION).then(function (ch) { ch.put(req, c); }); return r; })   // always check the server for newer code
      .catch(function () { return caches.match(req).then(function (h) { return h || caches.match('index.html'); }); }));
  }
});
