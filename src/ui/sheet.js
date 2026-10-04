// Bottom sheets: slide 24px + fade, drag-to-dismiss, never full height, never lose state
// (callers keep their own state; a sheet is just a view onto it).

import { h, $ } from '../core/dom.js';
import { dismissToast } from './toast.js';

const open = [];

export function sheet({ title, sub, body, foot, onClose, label } = {}) {
  const layer = $('#layer-sheets');
  dismissToast();
  const backdrop = h('div', { class: 'backdrop' });
  const head = title ? h('div', { class: 'shead' }, h('div', { class: 't-title' }, title), sub ? h('div', { class: 't-label dim', style: 'margin-top:4px' }, sub) : null) : null;
  const bodyEl = h('div', { class: 'sbody' }, body);
  const footEl = foot ? h('div', { class: 'sfoot' }, foot) : null;
  const grab = h('div', { class: 'grab' });
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label || title || 'Sheet' }, grab, head, bodyEl, footEl);
  layer.append(backdrop, el);
  layer.style.pointerEvents = 'auto';
  requestAnimationFrame(() => { backdrop.classList.add('show'); el.classList.add('show'); });

  let closed = false;
  const api = {
    el, body: bodyEl, head, foot: footEl,
    setSub(t) { const s = head && head.querySelector('.t-label'); if (s) s.textContent = t; },
    close(reason) {
      if (closed) return;
      closed = true;
      el.classList.remove('show');
      el.style.transform = '';
      backdrop.classList.remove('show');
      const i = open.indexOf(api);
      if (i >= 0) open.splice(i, 1);
      setTimeout(() => { el.remove(); backdrop.remove(); if (!open.length) layer.style.pointerEvents = 'none'; }, 220);
      onClose && onClose(reason);
    },
  };
  open.push(api);
  backdrop.addEventListener('click', () => api.close('backdrop'));

  // Drag to dismiss from the grabber/header, or from the body when scrolled to top.
  let sy = 0, dy = 0, dragging = false, startT = 0, fromBody = false;
  const start = (e, body) => {
    if (e.touches && e.touches.length > 1) return;
    const p = e.touches ? e.touches[0] : e;
    if (body && bodyEl.scrollTop > 0) return;
    if (body && e.target.closest('input, textarea, .seg, .switch, button, .formats')) return;
    sy = p.clientY; dy = 0; dragging = true; startT = performance.now(); fromBody = body;
  };
  const move = (e) => {
    if (!dragging) return;
    const p = e.touches ? e.touches[0] : e;
    dy = Math.max(0, p.clientY - sy);
    if (fromBody && dy < 6) return;
    if (dy > 0) { el.classList.add('dragging'); el.style.transform = `translateY(${dy}px)`; if (e.cancelable && e.touches) e.preventDefault(); }
  };
  const end = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove('dragging');
    const v = dy / Math.max(1, performance.now() - startT);
    if (dy > Math.min(140, el.offsetHeight * 0.3) || v > 0.6) api.close('swipe');
    else el.style.transform = '';
  };
  for (const t of [grab, head].filter(Boolean)) {
    t.addEventListener('touchstart', (e) => start(e, false), { passive: true });
    t.addEventListener('mousedown', (e) => { start(e, false); const mm = (ev) => move(ev); const mu = () => { end(); removeEventListener('mousemove', mm); removeEventListener('mouseup', mu); }; addEventListener('mousemove', mm); addEventListener('mouseup', mu); });
  }
  bodyEl.addEventListener('touchstart', (e) => start(e, true), { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  return api;
}

export function closeAllSheets() { for (const s of open.slice()) s.close('route'); }

addEventListener('keydown', (e) => { if (e.key === 'Escape' && open.length) open[open.length - 1].close('escape'); });

// Simple action list sheet.
export function menu({ title, sub, items }) {
  const s = sheet({
    title, sub,
    body: h('div', { class: 'menu' }, items.filter(Boolean).map((it) => h('button', {
      class: it.danger ? 'danger' : '',
      onclick: () => { s.close('action'); it.run(); },
    }, it.icon || null, h('span', null, it.label), it.hint ? h('span', { class: 't-label' }, it.hint) : null))),
  });
  return s;
}

export function confirm({ title, sub, ok = 'OK', danger = false, cancel = 'Cancel', alt }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); s.close('action'); } };
    const s = sheet({
      title, sub,
      body: h('div', { style: 'display:flex;flex-direction:column;gap:8px;padding-top:8px' },
        h('button', { class: `btn block ${danger ? 'danger' : 'primary'}`, onclick: () => finish(true) }, ok),
        alt ? h('button', { class: 'btn block', onclick: () => finish('alt') }, alt) : null,
        h('button', { class: 'btn block ghost', onclick: () => finish(false) }, cancel)),
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}
