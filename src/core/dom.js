// Tiny DOM helpers. No framework: the app has five screens and a few sheets.

export function h(tag, props, ...children) {
  const el = tag === 'svg' || tag === 'path' ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'ref') v(el);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
export const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function onAnimEnd(el, fn) {
  let done = false;
  const f = () => { if (!done) { done = true; fn(); } };
  el.addEventListener('animationend', f, { once: true });
  setTimeout(f, 450);
}

// Long-press helper that keeps taps working. Returns a disposer.
export function longPress(el, { onLong, onTap, ms = 420, moveTol = 10 }) {
  let timer = 0, sx = 0, sy = 0, fired = false, active = false;
  const down = (e) => {
    if (e.button > 0) return;
    active = true; fired = false; sx = e.clientX; sy = e.clientY;
    timer = setTimeout(() => { fired = true; onLong && onLong(e); }, ms);
  };
  const move = (e) => {
    if (!active) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > moveTol) { clearTimeout(timer); active = false; }
  };
  const up = (e) => {
    clearTimeout(timer);
    if (active && !fired && onTap) onTap(e);
    active = false;
  };
  const cancel = () => { clearTimeout(timer); active = false; };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel); };
}

// Object URL cache keyed by blob path so thumbnails don't leak.
const urls = new Map();
export function blobUrl(key, blob) {
  const old = urls.get(key);
  if (old && old.blob === blob) return old.url;
  if (old) URL.revokeObjectURL(old.url);
  const url = URL.createObjectURL(blob);
  urls.set(key, { blob, url });
  return url;
}
export function revokeUrl(key) {
  const old = urls.get(key);
  if (old) { URL.revokeObjectURL(old.url); urls.delete(key); }
}
