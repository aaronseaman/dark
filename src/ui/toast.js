// One toast at a time. Destructive actions pass `onExpire` to finalize after the UNDO window.

import { h, $ } from '../core/dom.js';

let current = null;

export function toast(msg, { actions = [], duration = 4000, onExpire } = {}) {
  if (current) current.dismiss(true);
  const layer = $('#layer-toast');
  const el = h('div', { class: 'toast', role: 'status' },
    h('div', { class: 'msg' }, msg),
    actions.map((a) => h('button', { onclick: () => { api.dismiss(false); a.run(); } }, a.label)));
  layer.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  let timer = setTimeout(() => api.dismiss(true), duration);
  let gone = false;
  const api = {
    el,
    dismiss(expire) {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      el.classList.remove('show');
      setTimeout(() => el.remove(), 220);
      if (current === api) current = null;
      if (expire && onExpire) onExpire();
    },
    update(text) { el.querySelector('.msg').textContent = text; },
    hold() { clearTimeout(timer); },
    release(ms = duration) { clearTimeout(timer); timer = setTimeout(() => api.dismiss(true), ms); },
  };
  current = api;
  return api;
}

export function dismissToast() { if (current) current.dismiss(true); }

// Undo pattern: perform `act` (returns an undo fn), show toast; finalize on expiry.
export async function undoable(msg, act, finalize) {
  const undo = await act();
  let undone = false;
  toast(msg, {
    actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); } }],
    onExpire: () => { if (!undone && finalize) finalize(); },
  });
}

// If the app is backgrounded with a toast up, finalize now (iOS may kill us).
document.addEventListener('visibilitychange', () => { if (document.hidden && current) current.dismiss(true); });
