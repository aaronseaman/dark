// Free-form crop on the original frame. Drag corners; a 90px loupe shows the pixels
// under your finger at 3x so placement is precise even with a fat finger.

import { h } from '../core/dom.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import { haptic } from '../core/haptics.js';
import { isConvex, fullQuad } from '../engine/geometry.js';
import { detectOnCanvas } from '../engine/process.js';
import * as router from '../ui/router.js';

const LOUPE = 90, ZOOM = 3, HIT = 30;

export class Crop {
  constructor(pageId, onApply) {
    this.page = store.page(pageId);
    this.onApply = onApply;
    this.quad = this.page.quad.map((p) => p.slice());
    this.noSwipe = true;
    this.build();
    this.load();
  }

  build() {
    this.canvas = h('canvas');
    this.loupeCanvas = h('canvas', { width: LOUPE * 3, height: LOUPE * 3 });
    this.loupe = h('div', { class: 'loupe' }, this.loupeCanvas);
    this.stage = h('div', { class: 'cstage' }, this.canvas, this.loupe);
    const bar = h('div', { class: 'cbar' },
      h('button', { class: 'textbtn', style: 'color:#E8E6E1', onclick: () => router.back() }, 'Cancel'),
      h('div', { class: 'mid' },
        h('button', { class: 'chip', onclick: () => this.auto() }, 'Auto'),
        h('button', { class: 'chip', onclick: () => this.full() }, 'Full')),
      h('button', { class: 'textbtn', style: 'color:#E8E6E1', onclick: () => this.apply() }, 'Apply'));
    const top = h('div', { class: 'topbar' }, h('div', { class: 'title-sm', style: 'opacity:1;color:#E8E6E1' }, 'Crop'));
    this.el = h('section', { class: 'screen crop dark-only' }, top, this.stage, bar);
    this.stage.addEventListener('pointerdown', (e) => this.down(e));
    this.stage.addEventListener('pointermove', (e) => this.move(e));
    this.stage.addEventListener('pointerup', (e) => this.up(e));
    this.stage.addEventListener('pointercancel', (e) => this.up(e));
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.stage);
  }

  async load() {
    const blob = await blobs.getBlob(this.page.src.path);
    if (!blob) return;
    this.bmp = await createImageBitmap(blob);
    this.layout();
  }

  layout() {
    if (!this.bmp) return;
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const dpr = Math.min(3, devicePixelRatio || 1);
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    const s = Math.min(W / this.bmp.width, H / this.bmp.height);
    this.view = { s, x: (W - this.bmp.width * s) / 2, y: (H - this.bmp.height * s) / 2, dpr };
    this.draw();
  }

  toScreen([x, y]) { const v = this.view; return [v.x + x * v.s, v.y + y * v.s]; }
  toImage([x, y]) { const v = this.view; return [(x - v.x) / v.s, (y - v.y) / v.s]; }

  draw() {
    const { dpr } = this.view;
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.canvas.width / dpr, H = this.canvas.height / dpr;
    ctx.clearRect(0, 0, W, H);
    const v = this.view;
    ctx.drawImage(this.bmp, v.x, v.y, this.bmp.width * v.s, this.bmp.height * v.s);
    const pts = this.quad.map((p) => this.toScreen(p));
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.rect(v.x, v.y, this.bmp.width * v.s, this.bmp.height * v.s);
    ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#4CC9F0'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.stroke();
    for (let i = 0; i < 4; i++) {
      const [x, y] = pts[i];
      ctx.beginPath(); ctx.arc(x, y, this.drag === i ? 9 : 7, 0, Math.PI * 2);
      ctx.fillStyle = '#4CC9F0'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = '#0B0C0D'; ctx.stroke();
    }
  }

  local(e) { const r = this.stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  down(e) {
    if (!this.view) return;
    const p = this.local(e);
    let best = -1, bd = HIT;
    this.quad.forEach((q, i) => { const s = this.toScreen(q); const d = Math.hypot(s[0] - p[0], s[1] - p[1]); if (d < bd) { bd = d; best = i; } });
    if (best < 0) return;
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    this.drag = best;
    const s = this.toScreen(this.quad[best]);
    this.offset = [s[0] - p[0], s[1] - p[1]];
    haptic(4);
    this.showLoupe(s);
    this.draw();
  }

  move(e) {
    if (this.drag == null) return;
    const p = this.local(e);
    const s = [p[0] + this.offset[0], p[1] + this.offset[1]];
    let ip = this.toImage(s);
    ip = [Math.max(0, Math.min(this.bmp.width, ip[0])), Math.max(0, Math.min(this.bmp.height, ip[1]))];
    // snap to the image corner when close (4 ms tick)
    const near = fullQuad(this.bmp.width, this.bmp.height).find((c) => Math.hypot(c[0] - ip[0], c[1] - ip[1]) * this.view.s < 10);
    if (near) { if (!this.snapped) haptic(4); this.snapped = true; ip = near.slice(); } else this.snapped = false;
    const next = this.quad.slice();
    next[this.drag] = ip;
    if (isConvex(next)) this.quad = next;
    this.showLoupe(this.toScreen(this.quad[this.drag]));
    this.draw();
  }

  up() {
    if (this.drag == null) return;
    this.drag = null;
    this.loupe.style.display = 'none';
    this.draw();
  }

  showLoupe([sx, sy]) {
    const W = this.stage.clientWidth;
    let lx = sx - LOUPE / 2, ly = sy - LOUPE - 44;
    if (ly < 0) ly = sy + 44;
    lx = Math.max(0, Math.min(W - LOUPE, lx));
    Object.assign(this.loupe.style, { display: 'block', left: `${lx}px`, top: `${ly}px` });
    const c = this.loupeCanvas, ctx = c.getContext('2d');
    const k = c.width / LOUPE; // canvas px per css px
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, c.width, c.height);
    // region of the image (in image px) that maps to the loupe at ZOOM x screen scale
    const [ix, iy] = this.toImage([sx, sy]);
    const span = LOUPE / (ZOOM * this.view.s);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bmp, ix - span / 2, iy - span / 2, span, span, 0, 0, c.width, c.height);
    // quad edges in loupe space
    const toL = ([x, y]) => [((x - (ix - span / 2)) / span) * c.width, ((y - (iy - span / 2)) / span) * c.height];
    const pts = this.quad.map(toL);
    ctx.strokeStyle = '#4CC9F0'; ctx.lineWidth = 2 * k;
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = 'rgba(232,230,225,0.9)'; ctx.lineWidth = 1 * k;
    const m = c.width / 2;
    ctx.beginPath(); ctx.moveTo(m - 10 * k, m); ctx.lineTo(m + 10 * k, m); ctx.moveTo(m, m - 10 * k); ctx.lineTo(m, m + 10 * k); ctx.stroke();
  }

  auto() {
    if (!this.bmp) return;
    const c = document.createElement('canvas');
    c.width = this.bmp.width; c.height = this.bmp.height;
    c.getContext('2d').drawImage(this.bmp, 0, 0);
    this.quad = detectOnCanvas(c);
    c.width = c.height = 0;
    haptic(4);
    this.draw();
  }

  full() { if (!this.bmp) return; this.quad = fullQuad(this.bmp.width, this.bmp.height); haptic(4); this.draw(); }

  apply() {
    const q = this.quad;
    this.onApply && this.onApply(q);
    router.back();
  }

  destroy() { this.ro.disconnect(); this.bmp && this.bmp.close && this.bmp.close(); }
}
