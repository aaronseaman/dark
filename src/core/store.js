// Domain store: documents and pages in memory, persisted to IndexedDB on every change.
// Destructive actions are soft (trashed + timestamp) so every one can be undone.

import * as db from './db.js';
import * as blobs from './blobstore.js';
import { uid, defaultName } from './format.js';

const docs = new Map();
const pages = new Map();
const ocr = new Map(); // pageId -> { pageId, docId, geom, text, words, lang }
const bus = new EventTarget();

export function on(type, fn) {
  const f = (e) => fn(e.detail);
  bus.addEventListener(type, f);
  return () => bus.removeEventListener(type, f);
}
function emit(type, detail) { bus.dispatchEvent(new CustomEvent(type, { detail })); }

export async function load() {
  const [d, p, o] = await Promise.all([db.all('docs'), db.all('pages'), db.all('ocr')]);
  for (const x of d) docs.set(x.id, x);
  for (const x of p) pages.set(x.id, x);
  for (const x of o) ocr.set(x.pageId, x);
  // Finish deletions that were interrupted (app killed while an UNDO toast was up).
  for (const x of d) if (x.trashed) await finalizeDoc(x.id, true);
  for (const x of p) if (x.trashed || !docs.has(x.docId)) await finalizePage(x.id);
  for (const doc of docs.values()) {
    const before = doc.pageIds.length;
    doc.pageIds = doc.pageIds.filter((id) => pages.has(id));
    if (doc.pageIds.length !== before) await db.put('docs', doc);
  }
  // Empty drafts are noise.
  for (const doc of [...docs.values()]) if (doc.status === 'draft' && !doc.pageIds.length) await finalizeDoc(doc.id, true);
}

// ---------- reads ----------
export function doc(id) { return docs.get(id); }
export function page(id) { return pages.get(id); }
export function pagesOf(docId) {
  const d = docs.get(docId);
  return d ? d.pageIds.map((id) => pages.get(id)).filter(Boolean) : [];
}
export function listDocs() {
  return [...docs.values()].filter((d) => !d.trashed && d.status === 'done').sort((a, b) => b.updated - a.updated);
}
export function latestDraft() {
  return [...docs.values()].filter((d) => !d.trashed && d.status === 'draft' && d.pageIds.length).sort((a, b) => b.updated - a.updated)[0] || null;
}
export function pageBytes(p) {
  return (p.src?.bytes || 0) + (p.out?.bytes || 0) + (p.thumb?.bytes || 0);
}
export function docBytes(d) { return pagesOf(d.id).reduce((s, p) => s + pageBytes(p), 0); }
export function stats() {
  const list = listDocs();
  let n = 0, bytes = 0;
  for (const d of list) for (const p of pagesOf(d.id)) { n++; bytes += pageBytes(p); }
  return { docs: list.length, pages: n, bytes };
}
export function ocrFor(pageId) {
  const p = pages.get(pageId);
  const r = ocr.get(pageId);
  return r && p && r.geom === p.geom ? r : null;
}
export function docText(docId) {
  return pagesOf(docId).map((p) => ocrFor(p.id)?.text || '').join('\n');
}
export function ocrProgress(docId) {
  const ps = pagesOf(docId);
  return { done: ps.filter((p) => ocrFor(p.id)).length, total: ps.length };
}

// ---------- docs ----------
export async function createDoc({ status = 'draft', name } = {}) {
  const now = Date.now();
  const d = { id: uid(), name: name || defaultName(now), named: !!name, created: now, updated: now, status, pageIds: [], lastExport: null };
  docs.set(d.id, d);
  await db.put('docs', d);
  emit('docs', {});
  return d;
}

export async function updateDoc(id, patch, { touch = true } = {}) {
  const d = docs.get(id);
  if (!d) return null;
  Object.assign(d, patch);
  if (touch) d.updated = Date.now();
  await db.put('docs', d);
  emit('doc', { id });
  emit('docs', {});
  return d;
}

export async function trashDoc(id) {
  const d = docs.get(id);
  if (!d) return () => {};
  d.trashed = Date.now();
  await db.put('docs', d);
  emit('docs', {});
  return async () => {
    if (!docs.has(id)) return;
    delete d.trashed;
    await db.put('docs', d);
    emit('docs', {});
  };
}

export async function finalizeDoc(id, force = false) {
  const d = docs.get(id);
  if (!force && d && !d.trashed) return; // restored by undo
  for (const pid of d ? d.pageIds : []) await finalizePage(pid, true);
  docs.delete(id);
  await db.del('docs', id);
  await blobs.delDir(`docs/${id}`);
  emit('docs', {});
}

// ---------- pages ----------
export async function addPage(docId, data, index) {
  const d = docs.get(docId);
  const p = {
    id: uid(), docId, created: Date.now(),
    src: null, quad: null, rotation: 0, filter: 'enhance', shadow: true,
    out: null, thumb: null, blank: false, geom: 1, ver: 0,
    ...data,
  };
  pages.set(p.id, p);
  if (index == null || index > d.pageIds.length) d.pageIds.push(p.id);
  else d.pageIds.splice(index, 0, p.id);
  d.updated = Date.now();
  await db.putMany('pages', [p]);
  await db.put('docs', d);
  emit('page', { id: p.id, docId });
  emit('doc', { id: docId });
  emit('docs', {});
  return p;
}

export async function updatePage(id, patch, { silent = false } = {}) {
  const p = pages.get(id);
  if (!p) return null;
  Object.assign(p, patch);
  await db.put('pages', p);
  if (!silent) {
    emit('page', { id, docId: p.docId });
    emit('doc', { id: p.docId });
  }
  return p;
}

export async function reorder(docId, pageIds) {
  const d = docs.get(docId);
  d.pageIds = pageIds.slice();
  d.updated = Date.now();
  await db.put('docs', d);
  emit('doc', { id: docId });
  emit('docs', {});
}

// Soft-delete pages. Returns an undo function.
export async function trashPages(ids) {
  const byDoc = new Map();
  for (const id of ids) {
    const p = pages.get(id);
    if (!p) continue;
    const d = docs.get(p.docId);
    if (!byDoc.has(d.id)) byDoc.set(d.id, d.pageIds.slice());
    p.trashed = Date.now();
    d.pageIds = d.pageIds.filter((x) => x !== id);
    await db.put('pages', p);
  }
  for (const id of byDoc.keys()) {
    const d = docs.get(id);
    d.updated = Date.now();
    await db.put('docs', d);
    emit('doc', { id });
  }
  emit('docs', {});
  return async () => {
    for (const id of ids) {
      const p = pages.get(id);
      if (p) { delete p.trashed; await db.put('pages', p); }
    }
    for (const [docId, order] of byDoc) {
      const d = docs.get(docId);
      if (!d) continue;
      const added = d.pageIds.filter((x) => !order.includes(x));
      d.pageIds = order.filter((x) => pages.has(x) && !pages.get(x).trashed).concat(added);
      await db.put('docs', d);
      emit('doc', { id: docId });
    }
    emit('docs', {});
  };
}

export async function finalizePage(id, skipDoc = false) {
  const p = pages.get(id);
  if (p && !p.trashed && !skipDoc && docs.get(p.docId)?.pageIds.includes(id)) return; // restored
  if (p) {
    await blobs.delBlob(p.src?.path);
    await blobs.delBlob(p.out?.path);
    await blobs.delBlob(p.thumb?.path);
  }
  pages.delete(id);
  ocr.delete(id);
  await db.del('pages', id);
  await db.del('ocr', id);
}

export async function setOCR(rec) {
  ocr.set(rec.pageId, rec);
  await db.put('ocr', rec);
  emit('ocr', { pageId: rec.pageId, docId: rec.docId });
}

export async function wipeAll() {
  docs.clear(); pages.clear(); ocr.clear();
  await db.clearAll();
  await blobs.wipe();
  emit('docs', {});
}

// Remove page image versions that nothing references (crashes mid-render, old versions).
export async function gc() {
  if ((await blobs.storageMode()) !== 'opfs') return;
  try {
    const root = await navigator.storage.getDirectory();
    let docsDir;
    try { docsDir = await root.getDirectoryHandle('docs'); } catch { return; }
    const live = new Set();
    for (const p of pages.values()) for (const b of [p.src, p.out, p.thumb]) if (b?.path) live.add(b.path);
    for await (const [docId, dh] of docsDir.entries()) {
      if (dh.kind !== 'directory') continue;
      if (!docs.has(docId)) { await docsDir.removeEntry(docId, { recursive: true }); continue; }
      for await (const [sub, sh] of dh.entries()) {
        if (sh.kind !== 'directory') continue;
        for await (const [name] of sh.entries()) {
          const path = `docs/${docId}/${sub}/${name}`;
          if (!live.has(path)) await sh.removeEntry(name).catch(() => {});
        }
      }
    }
  } catch (e) { console.warn('gc', e); }
}
