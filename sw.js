/* Hiwar (حوار) — Service Worker
   يخزّن هيكل التطبيق كي يعمل حتى عند انقطاع الخادم مؤقتاً (network-first مع مخبأ احتياطي) */
'use strict';

const CACHE = 'hiwar-shell-v19';
const SHELL = ['./', './index.html', './styles.css', './app.js', './bg_alpine.jpg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // لا نخزّن طلبات API أو TTS (ديناميكية)
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        // حدّث المخبأ بنسخة طازجة عند نجاح الجلب
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
  );
});
