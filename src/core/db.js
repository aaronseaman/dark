// IndexedDB: documents, pages, OCR results, settings. Image bytes live in blobstore (OPFS).

const NAME = 'dark';
const VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'id' }).createIndex('docId', 'docId');
      if (!db.objectStoreNames.contains('ocr')) db.createObjectStore('ocr', { keyPath: 'pageId' }).createIndex('docId', 'docId');
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function get(name, key) { return wrap((await store(name)).get(key)); }
export async function all(name) { return wrap((await store(name)).getAll()); }
export async function put(name, value, key) {
  const s = await store(name, 'readwrite');
  return wrap(key === undefined ? s.put(value) : s.put(value, key));
}
export async function del(name, key) { return wrap((await store(name, 'readwrite')).delete(key)); }
export async function keys(name) { return wrap((await store(name)).getAllKeys()); }
export async function byIndex(name, index, value) { return wrap((await store(name)).index(index).getAll(value)); }

export async function putMany(name, values) {
  if (!values.length) return;
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  for (const v of values) s.put(v);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}

export async function clearAll() {
  const db = await open();
  const names = ['docs', 'pages', 'ocr', 'blobs'];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}

export const meta = {
  get: (k) => get('meta', k),
  set: (k, v) => put('meta', v, k),
};
