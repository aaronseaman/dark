// Page images live in the Origin Private File System. Files are immutable: every
// re-render writes a new versioned path and deletes the old one, which avoids
// Safari's stale-File reads. Falls back to IndexedDB blobs if OPFS is missing.

import * as db from './db.js';

let rootp = null;
let mode = null; // 'opfs' | 'idb'
let writer = null; // worker for Safari builds without createWritable
let seq = 0;
const pending = new Map();

async function root() {
  if (rootp) return rootp;
  rootp = (async () => {
    try {
      if (navigator.storage && navigator.storage.getDirectory) {
        const r = await navigator.storage.getDirectory();
        // Probe a write so private-mode / broken OPFS falls back cleanly.
        await writeOPFS(r, '.probe', new Blob(['ok']));
        mode = 'opfs';
        return r;
      }
    } catch (e) { console.warn('OPFS unavailable, using IndexedDB', e); }
    mode = 'idb';
    return null;
  })();
  return rootp;
}

export async function storageMode() { await root(); return mode; }

async function dirFor(r, path, create) {
  const parts = path.split('/');
  const name = parts.pop();
  let d = r;
  for (const p of parts) d = await d.getDirectoryHandle(p, { create });
  return { dir: d, name };
}

async function writeOPFS(r, path, blob) {
  const { dir, name } = await dirFor(r, path, true);
  const fh = await dir.getFileHandle(name, { create: true });
  if (typeof fh.createWritable === 'function') {
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  await workerWrite(path, blob);
}

function workerWrite(path, blob) {
  if (!writer) {
    writer = new Worker(new URL('./opfs-worker.js', import.meta.url));
    writer.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve();
    };
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    writer.postMessage({ id, path, blob });
  });
}

export async function putBlob(path, blob) {
  const r = await root();
  if (mode === 'opfs') return writeOPFS(r, path, blob);
  return db.put('blobs', blob, path);
}

export async function getBlob(path) {
  if (!path) return null;
  const r = await root();
  if (mode === 'opfs') {
    try {
      const { dir, name } = await dirFor(r, path, false);
      const fh = await dir.getFileHandle(name);
      return await fh.getFile();
    } catch { return null; }
  }
  return (await db.get('blobs', path)) || null;
}

export async function delBlob(path) {
  if (!path) return;
  const r = await root();
  if (mode === 'opfs') {
    try {
      const { dir, name } = await dirFor(r, path, false);
      await dir.removeEntry(name);
    } catch { /* already gone */ }
    return;
  }
  return db.del('blobs', path);
}

export async function delDir(prefix) {
  const r = await root();
  if (mode === 'opfs') {
    try {
      const parts = prefix.split('/');
      const last = parts.pop();
      let d = r;
      for (const p of parts) d = await d.getDirectoryHandle(p);
      await d.removeEntry(last, { recursive: true });
    } catch { /* nothing there */ }
    return;
  }
  const keys = await db.keys('blobs');
  for (const k of keys) if (String(k).startsWith(prefix + '/')) await db.del('blobs', k);
}

export async function wipe() {
  const r = await root();
  if (mode === 'opfs') {
    try { await r.removeEntry('docs', { recursive: true }); } catch { /* empty */ }
  }
}
