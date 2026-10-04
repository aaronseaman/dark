// On-device OCR: Tesseract (LSTM, tessdata_fast) in a worker, one page at a time.
// Results are stored as normalized word boxes so they survive any re-render that
// keeps geometry (filters, quality) and are discarded when geometry changes.

import * as store from '../core/store.js';
import { renderForOCR } from './process.js';

const ROOT = new URL('../../', import.meta.url).href;
const queue = [];
const active = new Set();
const bus = new EventTarget();
let worker = null, workerLang = '', idleTimer = 0, running = false, paused = false, ready = false;
let langs = ['eng'];
let scriptP = null;

export function on(fn) { const f = (e) => fn(e.detail); bus.addEventListener('s', f); return () => bus.removeEventListener('s', f); }
function emit(pageId) { bus.dispatchEvent(new CustomEvent('s', { detail: { pageId } })); }

export function setReady(v) { ready = v; if (v) pump(); }
export function isReady() { return ready; }
export function setLangs(list) { langs = list && list.length ? list : ['eng']; }
export function pause(v) { paused = v; if (!v) pump(); }

export function status(pageId) {
  if (store.ocrFor(pageId)) return 'done';
  if (active.has(pageId)) return 'running';
  if (queue.includes(pageId)) return ready ? 'queued' : 'waiting';
  return 'none';
}

export function enqueue(pageId, front = false) {
  if (queue.includes(pageId) || active.has(pageId)) return;
  front ? queue.unshift(pageId) : queue.push(pageId);
  emit(pageId);
  pump();
}

export function enqueueMissing() {
  for (const d of [...store.listDocs(), store.latestDraft()].filter(Boolean)) {
    for (const p of store.pagesOf(d.id)) if (p.out && !store.ocrFor(p.id)) enqueue(p.id);
  }
}

function loadScript() {
  if (window.Tesseract) return Promise.resolve();
  if (scriptP) return scriptP;
  scriptP = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ROOT + 'engine/tesseract/tesseract.min.js';
    s.onload = resolve;
    s.onerror = () => { scriptP = null; reject(new Error('OCR engine missing')); };
    document.head.append(s);
  });
  return scriptP;
}

const SIMD = (() => {
  try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch { return false; }
})();

export function coreFile() { return SIMD ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'; }

async function getWorker() {
  const lang = langs.join('+');
  if (worker && workerLang === lang) return worker;
  if (worker) { try { await worker.terminate(); } catch { /* gone */ } worker = null; }
  await loadScript();
  worker = await window.Tesseract.createWorker(lang, 1, {
    workerPath: ROOT + 'engine/tesseract/worker.min.js',
    corePath: ROOT + 'engine/tesseract/' + coreFile(),
    langPath: ROOT + 'engine/lang',
    workerBlobURL: false,
    gzip: true,
  });
  // tesseract.js defaults to PSM 6 (one uniform block), which drops headings; 3 = full auto layout.
  await worker.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
  workerLang = lang;
  return worker;
}

async function pump() {
  if (running || paused || !ready || !queue.length) return;
  running = true;
  clearTimeout(idleTimer);
  try {
    while (queue.length && !paused) {
      const id = queue.shift();
      const page = store.page(id);
      if (!page || page.trashed || !page.out || store.ocrFor(id)) continue;
      active.add(id); emit(id);
      try {
        await recognize(page);
      } catch (e) {
        console.warn('OCR failed', e);
        if (String(e).includes('engine missing')) { ready = false; queue.unshift(id); active.delete(id); emit(id); break; }
      }
      active.delete(id); emit(id);
    }
  } finally {
    running = false;
    idleTimer = setTimeout(async () => {
      if (queue.length || running || !worker) return;
      try { await worker.terminate(); } catch { /* ignore */ }
      worker = null; workerLang = '';
    }, 45000);
  }
}

async function recognize(page) {
  const geom = page.geom;
  const img = await renderForOCR(page);
  const w = await getWorker();
  const { data } = await w.recognize(img.blob, {}, { text: true, blocks: true });
  const cur = store.page(page.id);
  if (!cur || cur.trashed) return;
  if (cur.geom !== geom) { queue.push(page.id); return; } // re-cropped while we worked
  const W = img.w, H = img.h;
  const words = [];
  const paras = [];
  let lineNo = 0;
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      const lines = [];
      for (const l of p.lines || []) {
        const lb = l.bbox, bl = l.baseline;
        lineNo++;
        const parts = [];
        for (const wd of l.words || []) {
          const t = (wd.text || '').trim();
          if (!t || wd.confidence < 25) continue;
          const cx = (wd.bbox.x0 + wd.bbox.x1) / 2;
          const by = bl && bl.x1 !== bl.x0 ? bl.y0 + ((bl.y1 - bl.y0) * (cx - bl.x0)) / (bl.x1 - bl.x0) : lb.y1;
          words.push({ t, l: lineNo, x: wd.bbox.x0 / W, w: (wd.bbox.x1 - wd.bbox.x0) / W, y: lb.y0 / H, h: (lb.y1 - lb.y0) / H, b: Math.min(lb.y1, Math.max(lb.y0, by)) / H });
          parts.push(t);
        }
        if (parts.length) lines.push(parts.join(' '));
      }
      if (lines.length) paras.push(lines.join('\n'));
    }
  }
  await store.setOCR({ pageId: page.id, docId: page.docId, geom, text: paras.join('\n\n'), words, lang: workerLang, at: Date.now() });
}

// Best title candidate from page 1: tall-ish line near the top with real words.
export function smartTitle(docId) {
  const first = store.pagesOf(docId)[0];
  const r = first && store.ocrFor(first.id);
  if (!r || !r.words.length) return null;
  const lines = new Map();
  for (const w of r.words) {
    const k = Math.round(w.y * 200);
    if (!lines.has(k)) lines.set(k, { y: w.y, h: w.h, words: [] });
    lines.get(k).words.push(w);
  }
  const cands = [...lines.values()].filter((l) => l.y < 0.35).map((l) => {
    const text = l.words.sort((a, b) => a.x - b.x).map((w) => w.t).join(' ').replace(/\s+/g, ' ').trim();
    const letters = (text.match(/\p{L}/gu) || []).length;
    return { text, score: l.h * (1.2 - l.y), letters, len: text.length };
  }).filter((c) => c.len >= 3 && c.len <= 60 && c.letters >= 3 && c.letters / c.len > 0.55);
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  let t = cands[0].text.replace(/[^\p{L}\p{N}\s&'.,()-]/gu, '').trim();
  // "INVOICE" -> "Invoice": shouting headings make poor file names.
  if (t && t === t.toUpperCase() && /\p{L}{3}/u.test(t)) t = t.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  return t || null;
}
