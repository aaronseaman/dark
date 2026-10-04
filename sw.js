// dark service worker. Cache-first for the shell and the engine; no network strategy at all.
// VERSION and SHELL are stamped by tools/stamp.mjs.

const VERSION = '742f5c440c';
const SHELL = [
  "./",
  "assets/fonts/plex-mono-400.woff2",
  "assets/fonts/plex-mono-500.woff2",
  "assets/fonts/plex-sans-400.woff2",
  "assets/fonts/plex-sans-500.woff2",
  "assets/fonts/plex-sans-600.woff2",
  "assets/icons/apple-touch-icon.png",
  "assets/icons/icon-192.png",
  "assets/icons/icon-512.png",
  "assets/icons/icon.svg",
  "assets/icons/maskable-512.png",
  "index.html",
  "manifest.webmanifest",
  "src/core/blobstore.js",
  "src/core/db.js",
  "src/core/dom.js",
  "src/core/format.js",
  "src/core/haptics.js",
  "src/core/icons.js",
  "src/core/opfs-worker.js",
  "src/core/settings.js",
  "src/core/store.js",
  "src/engine-manifest.js",
  "src/engine/detect-worker.js",
  "src/engine/detect.js",
  "src/engine/geometry.js",
  "src/engine/gl.js",
  "src/engine/install.js",
  "src/engine/ocr.js",
  "src/engine/process.js",
  "src/export/bytes.js",
  "src/export/docx.js",
  "src/export/index.js",
  "src/export/pdf.js",
  "src/export/pdfcrypt.js",
  "src/export/png1.js",
  "src/export/zip.js",
  "src/main.js",
  "src/screens/capture.js",
  "src/screens/crop.js",
  "src/screens/document.js",
  "src/screens/export-sheet.js",
  "src/screens/firstrun.js",
  "src/screens/library.js",
  "src/screens/reader.js",
  "src/screens/review.js",
  "src/screens/settings.js",
  "src/styles.css",
  "src/ui/nav.js",
  "src/ui/router.js",
  "src/ui/sheet.js",
  "src/ui/toast.js"
];

const SHELL_CACHE = 'dark-shell-' + VERSION;
const ENGINE_CACHE = 'dark-engine-v1';
const CDN = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    await c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('dark-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    if (req.mode === 'navigate') {
      const shell = await caches.match(new URL('./index.html', self.registration.scope).href, { ignoreSearch: true });
      if (shell) return shell;
    }
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    // Extra OCR languages are fetched once from the CDN and kept under our own URL.
    const m = url.pathname.match(/\/engine\/lang\/([a-z_]+)\.traineddata\.gz$/);
    if (m && m[1] !== 'eng') {
      const res = await fetch(`${CDN}/${m[1]}/4.0.0_best_int/${m[1]}.traineddata.gz`);
      if (res.ok) {
        const body = await res.arrayBuffer();
        const out = new Response(body, { headers: { 'Content-Type': 'application/gzip' } });
        (await caches.open(ENGINE_CACHE)).put(req.url, out.clone());
        return out;
      }
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        const name = url.pathname.includes('/engine/') ? ENGINE_CACHE : SHELL_CACHE;
        caches.open(name).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await caches.match(new URL('./', self.registration.scope).href);
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
