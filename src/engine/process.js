// Page lifecycle on top of the GPU processor: capture/import -> source on disk ->
// rendered page + thumbnail on disk. Re-renders are coalesced per page.

import * as gl from './gl.js';
import * as blobs from '../core/blobstore.js';
import * as store from '../core/store.js';
import { encodePNG1 } from '../export/png1.js';
import { detectQuad, rgbaToGray } from './detect.js';
import { fullQuad, scaleQuad } from './geometry.js';

export const SRC_MAX = 3000;
export const OUT_MAX = 2400;
export const THUMB_MAX = 640;

export function toBlob(canvas, type, q) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, q));
}

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

async function thumbFrom(src, w, h) {
  const s = Math.min(1, THUMB_MAX / Math.max(w, h));
  const c = canvas2d(Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const b = await toBlob(c, 'image/jpeg', 0.8);
  c.width = c.height = 0;
  return b;
}

async function loadSource(p, page, image) {
  if (p.src && p.src.key === page.src.path) return;
  if (image) { p.setSource(page.src.path, image, page.src.w, page.src.h); return; }
  const blob = await blobs.getBlob(page.src.path);
  if (!blob) throw new Error('source missing');
  const bmp = await createImageBitmap(blob);
  try { p.setSource(page.src.path, bmp, bmp.width, bmp.height); } finally { bmp.close && bmp.close(); }
}

// Full-quality render. Returns encoded bytes; does not touch the store.
export function renderPage(page, { maxEdge = OUT_MAX, quality = 0.82, filter, image, keepWarp = false } = {}) {
  return gl.job(async (p) => {
    await loadSource(p, page, image);
    const r = p.render({ quad: page.quad, rotation: page.rotation, filter: filter || page.filter, shadow: page.shadow, aspectLock: page.aspectLock, maxEdge });
    let blob;
    if (r.bitonal) blob = await encodePNG1(p.readBits());
    else blob = await toBlob(p.canvas, 'image/jpeg', quality);
    const thumb = await thumbFrom(p.canvas, r.w, r.h);
    if (!keepWarp) p.releaseWarp();
    return { blob, type: blob.type, w: r.w, h: r.h, thumb, blank: r.blank };
  });
}

// Screen-resolution render for live filter previews. Returns a 2D canvas copy.
export function renderPreview(page, { filter, maxEdge = 1400, quad, rotation } = {}) {
  return gl.job(async (p) => {
    await loadSource(p, page);
    const r = p.render({ quad: quad || page.quad, rotation: rotation ?? page.rotation, filter: filter || page.filter, shadow: page.shadow, aspectLock: page.aspectLock, maxEdge });
    const c = canvas2d(r.w, r.h);
    c.getContext('2d').drawImage(p.canvas, 0, 0);
    return c;
  });
}

// OCR wants clean gray, not whatever the user picked.
export function renderForOCR(page) {
  return gl.job(async (p) => {
    await loadSource(p, page);
    const r = p.render({ quad: page.quad, rotation: page.rotation, filter: 'gray', shadow: true, aspectLock: page.aspectLock, maxEdge: 2200 });
    const b = await toBlob(p.canvas, 'image/jpeg', 0.9);
    p.releaseWarp();
    return { blob: b, w: r.w, h: r.h };
  });
}

// ---------- render scheduling ----------
const running = new Map(); // pageId -> promise
const dirty = new Set();
const listeners = new Set();
export function onRendered(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function isBusy(pageId) { return running.has(pageId); }

export function scheduleRender(pageId, opts = {}) {
  if (running.has(pageId)) { dirty.add(pageId); return running.get(pageId); }
  const run = (async () => {
    try {
      do {
        dirty.delete(pageId);
        await renderAndStore(pageId, opts);
        opts = {};
      } while (dirty.has(pageId));
    } catch (e) {
      console.error('render failed', e);
    } finally {
      running.delete(pageId);
      for (const fn of listeners) fn(pageId);
    }
  })();
  running.set(pageId, run);
  return run;
}

export function whenIdle(pageIds) { return Promise.all(pageIds.map((id) => running.get(id)).filter(Boolean)); }

async function renderAndStore(pageId, { image } = {}) {
  const page = store.page(pageId);
  if (!page || page.trashed) return;
  const rev = page.rev || 0;
  const res = await renderPage(page, { image });
  const cur = store.page(pageId);
  if (!cur || cur.trashed) return;
  if ((cur.rev || 0) !== rev) { dirty.add(pageId); return; } // params changed mid-render
  const ver = (cur.ver || 0) + 1;
  const ext = res.type === 'image/png' ? 'png' : 'jpg';
  const outPath = `docs/${cur.docId}/pages/${cur.id}-${ver}.${ext}`;
  const thPath = `docs/${cur.docId}/thumbs/${cur.id}-${ver}.jpg`;
  await blobs.putBlob(outPath, res.blob);
  await blobs.putBlob(thPath, res.thumb);
  const old = [cur.out?.path, cur.thumb?.path];
  await store.updatePage(pageId, {
    ver,
    out: { path: outPath, w: res.w, h: res.h, type: res.type, bytes: res.blob.size },
    thumb: { path: thPath, bytes: res.thumb.size },
    blank: res.blank,
  });
  for (const o of old) if (o) blobs.delBlob(o);
}

// Bump the page's parameter revision and queue a re-render.
export async function editPage(pageId, patch) {
  const p = store.page(pageId);
  if (!p) return;
  const geomChanged = 'quad' in patch || 'rotation' in patch || 'aspectLock' in patch;
  await store.updatePage(pageId, { ...patch, rev: (p.rev || 0) + 1, geom: geomChanged ? (p.geom || 1) + 1 : p.geom });
  return scheduleRender(pageId);
}

// ---------- sources ----------
// Captured frame (canvas) -> stored source, page record, first render straight from the canvas.
export async function addCapturedPage(docId, frame, quad, { rotation = 0, filter = 'enhance', aspectLock = false, index } = {}) {
  const page = await store.addPage(docId, {
    src: null, quad, rotation, filter, aspectLock, shadow: true, rev: 0,
  }, index);
  const srcPath = `docs/${docId}/src/${page.id}.jpg`;
  // The render reads the canvas directly; encoding the source runs alongside it.
  page.src = { path: srcPath, w: frame.width, h: frame.height, bytes: 0 };
  const enc = toBlob(frame, 'image/jpeg', 0.92).then(async (b) => {
    await blobs.putBlob(srcPath, b);
    await store.updatePage(page.id, { src: { path: srcPath, w: frame.width, h: frame.height, bytes: b.size } }, { silent: true });
  });
  const render = scheduleRender(page.id, { image: frame });
  await Promise.all([enc, render]);
  return store.page(page.id);
}

// Photos / Files import: honour EXIF orientation by decoding through <img>, then normalise.
export async function decodeFile(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight;
    const s = Math.min(1, SRC_MAX / Math.max(w, h));
    const c = canvas2d(Math.round(w * s), Math.round(h * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function detectOnCanvas(c) {
  const s = Math.min(1, 480 / Math.max(c.width, c.height));
  const w = Math.max(8, Math.round(c.width * s)), h = Math.max(8, Math.round(c.height * s));
  const t = canvas2d(w, h);
  const ctx = t.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(c, 0, 0, w, h);
  const gray = rgbaToGray(ctx.getImageData(0, 0, w, h).data, w, h);
  const r = detectQuad(gray, w, h);
  return r ? scaleQuad(r.quad, c.width / w, c.height / h) : fullQuad(c.width, c.height);
}

export async function importFiles(docId, files, defaults = {}) {
  const added = [];
  for (const f of files) {
    if (!f.type.startsWith('image/') && !/\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i.test(f.name)) continue;
    try {
      const c = await decodeFile(f);
      const quad = detectOnCanvas(c);
      added.push(await addCapturedPage(docId, c, quad, defaults));
      c.width = c.height = 0;
    } catch (e) { console.warn('import failed', f.name, e); }
  }
  return added;
}
