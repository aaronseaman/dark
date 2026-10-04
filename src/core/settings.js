// App settings (IndexedDB meta). Small, synchronous reads after load().

import { meta } from './db.js';

const DEFAULTS = {
  theme: 'dark', // dark | black | light
  auto: true, // auto-capture
  grid: false,
  aspectLock: false,
  filter: 'enhance',
  ocr: true,
  ocrLangs: ['eng'],
  haptics: true,
  engine: false, // offline engine downloaded at least once
};

let s = { ...DEFAULTS };
const subs = new Set();

export async function load() {
  try { s = { ...DEFAULTS, ...((await meta.get('settings')) || {}) }; } catch { s = { ...DEFAULTS }; }
  applyTheme();
  return s;
}

export function get(k) { return s[k]; }

export async function set(k, v) {
  s[k] = v;
  if (k === 'theme') applyTheme();
  for (const fn of subs) fn(k, v);
  try { await meta.set('settings', s); } catch { /* storage full or private mode */ }
}

export function subscribe(fn) { subs.add(fn); return () => subs.delete(fn); }

export function applyTheme() {
  const t = s.theme;
  document.documentElement.dataset.theme = t;
  const color = t === 'light' ? '#F3F2EE' : t === 'black' ? '#000000' : '#0B0C0D';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}
