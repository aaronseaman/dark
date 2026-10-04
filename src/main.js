// dark — boot. Everything runs on this device; nothing here talks to a server
// except the one-time engine download (same origin) and optional extra OCR languages.

import * as settings from './core/settings.js';
import * as store from './core/store.js';
import { setHaptics } from './core/haptics.js';
import * as router from './ui/router.js';
import { register, go } from './ui/nav.js';
import { closeAllSheets } from './ui/sheet.js';
import * as ocr from './engine/ocr.js';
import { engineInstalled, installEngine } from './engine/install.js';
import { supported as glSupported } from './engine/gl.js';
import { Library } from './screens/library.js';
import { Capture } from './screens/capture.js';
import { Review } from './screens/review.js';
import { DocumentScreen } from './screens/document.js';
import { Reader } from './screens/reader.js';
import { Crop } from './screens/crop.js';
import { Settings } from './screens/settings.js';
import { FirstRun } from './screens/firstrun.js';
import { openExport } from './screens/export-sheet.js';
import { toast } from './ui/toast.js';

// iOS: block pinch-zoom of the shell and double-tap zoom outside the reader.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => { if (!e.target.closest('.slide')) e.preventDefault(); }, { passive: false });

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    // A new build activated while we were open: offer a reload instead of mixing versions.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      toast('Updated', { duration: 8000, actions: [{ label: 'Reload', run: () => location.reload() }] });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
  } catch (e) { console.warn('SW registration failed', e); }
}

async function boot() {
  registerSW();
  await settings.load();
  setHaptics(settings.get('haptics'));
  try { await store.load(); } catch (e) { console.error('store load', e); }
  router.init(document.getElementById('app'));

  register('capture', (opts = {}) => { closeAllSheets(); router.push(new Capture(opts), { modal: true }); });
  register('review', (docId, opts) => { closeAllSheets(); router.push(new Review(docId, opts)); });
  register('document', (id) => { closeAllSheets(); router.push(new DocumentScreen(id)); });
  register('reader', (id, index) => router.push(new Reader(id, index)));
  register('crop', (pageId, onApply) => router.push(new Crop(pageId, onApply), { modal: true }));
  register('settings', () => router.push(new Settings()));
  register('export', (opts) => openExport(opts));

  router.setRoot(new Library());

  if (!glSupported()) toast('This browser lacks WebGL2 — filters are unavailable', { duration: 6000 });

  ocr.setLangs(settings.get('ocrLangs'));
  const ready = await engineInstalled();
  if (settings.get('ocr')) {
    if (ready) ocr.setReady(true);
    else if (!settings.get('engine')) {
      router.push(new FirstRun(() => router.back()), { modal: true });
    } else if (navigator.onLine !== false) {
      // Cache was evicted: quietly fetch it again.
      installEngine().then(() => ocr.setReady(true)).catch(() => {});
    }
  }
  ocr.enqueueMissing();

  if (/[?&]scan\b/.test(location.search) && router.depth() === 1) go('capture', {});

  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 2000));
  idle(() => store.gc());
}

boot().catch((e) => {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:calc(env(safe-area-inset-top) + 40px) 24px;font:15px/22px system-ui;color:#E8E6E1">Something went wrong starting dark.<br><span style="color:#8B8F94">${String(e && e.message || e).replace(/[<>&]/g, '')}</span></div>`;
});
