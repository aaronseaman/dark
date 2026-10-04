// Export orchestration: gather page bytes at the requested quality, assemble the
// format, hand the file to the platform (share sheet / save picker / download).

import * as blobs from '../core/blobstore.js';
import * as store from '../core/store.js';
import * as ocr from '../engine/ocr.js';
import { renderPage, whenIdle, toBlob } from '../engine/process.js';
import { writePDF } from './pdf.js';
import { writeDOCX } from './docx.js';
import { zip } from './zip.js';
import { safeFilename, pad2 } from '../core/format.js';

export const FORMATS = [
  { key: 'pdf', label: 'PDF' },
  { key: 'docx', label: 'DOCX' },
  { key: 'txt', label: 'TXT' },
  { key: 'img', label: 'IMG' },
];
export const QUALITIES = [
  { key: 'light', label: 'Light' },
  { key: 'std', label: 'Std' },
  { key: 'max', label: 'Max' },
];

const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };

export function estimate(pages, { format, quality, searchable }) {
  if (format === 'txt') return pages.reduce((s, p) => s + (store.ocrFor(p.id)?.text.length || 1500), 0);
  let img = 0;
  for (const p of pages) {
    const b = p.out?.bytes || 400000;
    const bitonal = p.out?.type === 'image/png';
    img += quality === 'light' ? (bitonal ? b : b * 0.36) : quality === 'max' ? (bitonal ? b * 1.3 : b * 2.3) : b;
  }
  let text = 0;
  if (searchable && format !== 'img') for (const p of pages) text += (store.ocrFor(p.id)?.words.length || 250) * (format === 'pdf' ? 18 : 9);
  return Math.round(img + text + pages.length * 600 + 2000);
}

async function pageBytes(p, quality) {
  if (quality === 'max') {
    const r = await renderPage(p, { maxEdge: 3000, quality: 0.95 });
    return { bytes: new Uint8Array(await r.blob.arrayBuffer()), type: r.type, w: r.w, h: r.h };
  }
  const blob = await blobs.getBlob(p.out.path);
  if (!blob) throw new Error('page image missing');
  if (quality === 'light' && p.out.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    const b = await toBlob(c, 'image/jpeg', 0.6);
    const out = { bytes: new Uint8Array(await b.arrayBuffer()), type: 'image/jpeg', w: c.width, h: c.height };
    c.width = c.height = 0;
    return out;
  }
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: p.out.type, w: p.out.w, h: p.out.h };
}

// Wait for OCR on these pages (prioritised), reporting progress. Resolves early if the engine is off.
export async function awaitOCR(pages, onProgress, signal) {
  const need = () => pages.filter((p) => !store.ocrFor(p.id));
  if (!ocr.isReady()) return need().length === 0;
  for (const p of need().reverse()) ocr.enqueue(p.id, true);
  while (need().length) {
    if (signal && signal.aborted) return false;
    onProgress && onProgress(pages.length - need().length, pages.length);
    await new Promise((r) => setTimeout(r, 250));
    if (!ocr.isReady()) return false;
  }
  onProgress && onProgress(pages.length, pages.length);
  return true;
}

export async function build(pages, opts, onProgress = () => {}) {
  const { format, quality = 'std', searchable = true, password = '', name } = opts;
  const base = safeFilename(name);
  await whenIdle(pages.map((p) => p.id));
  pages = pages.map((p) => store.page(p.id)).filter((p) => p && p.out);
  if (!pages.length) throw new Error('No pages');

  if (format === 'txt') {
    const parts = pages.map((p, i) => `--- page ${i + 1} ---\n${(store.ocrFor(p.id)?.text || '').trim()}\n`);
    return [new File([parts.join('\f')], `${base}.txt`, { type: MIME.txt })];
  }

  const items = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress(i, pages.length);
    const pb = await pageBytes(pages[i], quality);
    const o = store.ocrFor(pages[i].id);
    items.push({ ...pb, words: o?.words || null, text: o?.text || '' });
  }
  onProgress(pages.length, pages.length);

  if (format === 'pdf') {
    const bytes = await writePDF({ pages: items, title: base, password, searchable });
    return [new File([bytes], `${base}.pdf`, { type: MIME.pdf })];
  }
  if (format === 'docx') {
    const bytes = writeDOCX({ pages: items, title: base, includeText: searchable });
    return [new File([bytes], `${base}.docx`, { type: MIME.docx })];
  }
  // IMG
  return items.map((it, i) => {
    const ext = it.type === 'image/png' ? 'png' : 'jpg';
    return new File([it.bytes], items.length > 1 ? `${base} ${pad2(i + 1)}.${ext}` : `${base}.${ext}`, { type: it.type });
  });
}

// ---------- platform save ----------
const isTouch = () => matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;

export function saveMode() {
  if (isTouch() && navigator.canShare) {
    try { if (navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })) return 'share'; } catch { /* no */ }
  }
  if (typeof window.showSaveFilePicker === 'function') return 'picker';
  return 'download';
}

export function saveLabel() {
  const m = saveMode();
  return m === 'share' ? 'Save to Files' : m === 'picker' ? 'Save to…' : 'Download';
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// Returns 'saved' | 'cancelled' | 'needs-tap' (share lost its user activation)
export async function save(files, { mode = saveMode() } = {}) {
  if (mode === 'share') {
    const data = { files };
    if (navigator.canShare && !navigator.canShare(data)) {
      if (files.length > 1) return save([new File([zip(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))))], files[0].name.replace(/ \d+\.\w+$/, '') + '.zip', { type: 'application/zip' })], { mode });
      download(files[0]);
      return 'saved';
    }
    try { await navigator.share(data); return 'saved'; } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      if (e.name === 'NotAllowedError') return 'needs-tap';
      throw e;
    }
  }
  if (mode === 'picker' && files.length === 1) {
    const f = files[0];
    const ext = f.name.split('.').pop();
    try {
      const h = await window.showSaveFilePicker({ suggestedName: f.name, types: [{ description: ext.toUpperCase(), accept: { [f.type || 'application/octet-stream']: ['.' + ext] } }] });
      const w = await h.createWritable();
      await w.write(f); await w.close();
      return 'saved';
    } catch (e) {
      if (e.name === 'AbortError') return 'cancelled';
      download(f);
      return 'saved';
    }
  }
  if (files.length > 1) {
    const z = zip(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    download(new File([z], files[0].name.replace(/ \d+\.\w+$/, '') + '.zip', { type: 'application/zip' }));
    return 'saved';
  }
  download(files[0]);
  return 'saved';
}
