// One-time offline engine download (Tesseract core + English model) into Cache Storage,
// with byte-accurate progress. The service worker serves these cache-first forever after.

import { ENGINE } from '../engine-manifest.js';
import { coreFile } from './ocr.js';

export const ENGINE_CACHE = 'dark-engine-v1';
const ROOT = new URL('../../', import.meta.url).href;
const CDN = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';

export function engineFiles() {
  const core = coreFile();
  return ENGINE.files.filter((f) => !f.path.includes('tesseract-core') || f.path.endsWith(core));
}

export function engineBytes() { return engineFiles().reduce((s, f) => s + f.size, 0); }

export async function engineInstalled() {
  if (!('caches' in self)) return true; // nothing to precache into; rely on HTTP
  try {
    const c = await caches.open(ENGINE_CACHE);
    for (const f of engineFiles()) if (!(await c.match(ROOT + f.path))) return false;
    return true;
  } catch { return false; }
}

let running = null;
export function installEngine(onProgress = () => {}) {
  if (running) { running.listeners.add(onProgress); return running.p; }
  const listeners = new Set([onProgress]);
  const emit = (d, t) => { for (const fn of listeners) fn(d, t); };
  const p = (async () => {
    const files = engineFiles();
    const total = files.reduce((s, f) => s + f.size, 0);
    const c = await caches.open(ENGINE_CACHE);
    let done = 0;
    for (const f of files) {
      const url = ROOT + f.path;
      if (await c.match(url)) { done += f.size; emit(done, total); continue; }
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        chunks.push(value);
        got += value.length;
        emit(done + Math.min(got, f.size), total);
      }
      await c.put(url, new Response(new Blob(chunks), { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
      done += f.size;
      emit(done, total);
    }
    return true;
  })();
  running = { p, listeners };
  p.finally(() => { running = null; });
  return p;
}

// Extra OCR languages: fetched on demand from jsDelivr, stored under our own URL so
// the Tesseract worker finds them next to English.
export const LANGS = [
  ['eng', 'English'], ['spa', 'Español'], ['fra', 'Français'], ['deu', 'Deutsch'], ['ita', 'Italiano'],
  ['por', 'Português'], ['nld', 'Nederlands'], ['swe', 'Svenska'], ['pol', 'Polski'], ['tur', 'Türkçe'],
  ['ind', 'Indonesia'], ['vie', 'Tiếng Việt'], ['fil', 'Filipino'],
];

export async function langInstalled(code) {
  if (code === 'eng') return true;
  try { return !!(await (await caches.open(ENGINE_CACHE)).match(`${ROOT}engine/lang/${code}.traineddata.gz`)); } catch { return false; }
}

export async function installLang(code, onProgress = () => {}) {
  const res = await fetch(`${CDN}/${code}/4.0.0_best_int/${code}.traineddata.gz`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = +res.headers.get('Content-Length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, total);
  }
  const c = await caches.open(ENGINE_CACHE);
  await c.put(`${ROOT}engine/lang/${code}.traineddata.gz`, new Response(new Blob(chunks), { headers: { 'Content-Type': 'application/gzip' } }));
}
