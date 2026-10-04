// CAPTURE (modal). The live feed is dimmed to 45% everywhere except the detected
// page, which stays at 100%: the document lights up. Auto-capture fires when the
// quad holds still for 400 ms. Hold the shutter for burst.

import { h, clear, blobUrl, reducedMotion } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import * as settings from '../core/settings.js';
import * as ocr from '../engine/ocr.js';
import { haptic } from '../core/haptics.js';
import { pgs } from '../core/format.js';
import { addCapturedPage, isBusy, onRendered, decodeFile, detectOnCanvas, SRC_MAX } from '../engine/process.js';
import { fullQuad } from '../engine/geometry.js';
import { go } from '../ui/nav.js';
import { confirm } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import * as router from '../ui/router.js';

const DETECT_MAX = 480;
const STABLE_PX = 2.5; // corner movement between detections, at detection scale
const STABLE_MS = 400;
const AUTO_MIN_AREA = 0.3;
const BURST_MS = 500;

export class Capture {
  constructor({ docId } = {}) {
    this.docId = docId || null;
    this.noSwipe = true;
    this.toastLift = '200px';
    this.session = 0; // pages captured in this visit
    this.rotation = 0;
    this.target = null; // detected quad, normalized to video [0..1]
    this.disp = null; // smoothed quad for drawing
    this.alpha = 0;
    this.raw = null; // last raw quad (detection px)
    this.rawW = 0; this.rawH = 0;
    this.lastSeen = 0;
    this.stableSince = 0;
    this.armed = true;
    this.capSig = null; this.capQuad = null;
    this.busy = false;
    this.slots = new Map();
    this.build();
    this.offs = [
      store.on('page', ({ id }) => this.refreshSlot(id)),
      onRendered((id) => this.refreshSlot(id)),
      settings.subscribe(() => this.syncTools()),
    ];
    this.onVis = () => { if (document.hidden) this.stop(); else if (router.top() === this) this.start(); };
    document.addEventListener('visibilitychange', this.onVis);
    if (this.docId) this.loadExisting();
  }

  build() {
    const tool = (name, label, fn) => h('button', { class: 'iconbtn', 'aria-label': label, onclick: fn }, icon(name));
    this.autoBtn = h('button', { class: 'iconbtn autobtn', 'aria-label': 'Auto capture', onclick: () => { settings.set('auto', !settings.get('auto')); haptic(4); } }, 'AUTO');
    this.gridBtn = tool('grid', 'Grid overlay', () => settings.set('grid', !settings.get('grid')));
    this.torchBtn = tool('torch', 'Torch', () => this.toggleTorch());
    this.aspectBtn = tool('aspect', 'Lock to paper size', () => { settings.set('aspectLock', !settings.get('aspectLock')); haptic(4); toast(settings.get('aspectLock') ? 'Snapping to A4 / Letter' : 'Measured size', { duration: 1600 }); });
    this.counter = h('div', { class: 'counter t-label' }, '');
    const chrome = h('div', { class: 'chrome' },
      h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: () => router.back() }, icon('close')),
      h('div', { class: 'tools' }, this.autoBtn, this.gridBtn, this.torchBtn, this.aspectBtn),
      this.counter);

    this.video = h('video', { playsinline: true, muted: true, autoplay: true, 'aria-label': 'Camera' });
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.muted = true;
    this.overlay = h('canvas', { class: 'overlay' });
    this.grid = h('div', { class: 'gridlines' }, h('i'), h('i'), h('i'), h('i'));
    this.flashEl = h('div', { class: 'flash' });
    this.msg = h('div', { class: 'msg', style: 'display:none' });
    this.hint = h('div', { class: 'hint t-label' });
    this.rotBadge = h('div', { class: 'rotbadge t-label' });
    this.vf = h('div', { class: 'viewfinder' },
      this.video, this.overlay, this.grid, this.flashEl, this.rotBadge, this.hint, this.msg);

    this.strip = h('div', { class: 'filmstrip', role: 'list' });
    const rotBtn = h('button', { class: 'iconbtn', 'aria-label': 'Rotate output 90°', onclick: () => this.rotate() }, icon('rotateSession'));
    this.shutter = h('button', { class: 'shutter', 'aria-label': 'Capture page. Hold for burst' }, h('div', { class: 'core' }));
    this.shutter.insertAdjacentHTML('afterbegin', '<svg class="ring" viewBox="0 0 78 78" aria-hidden="true"><circle cx="39" cy="39" r="37" fill="none" stroke="#E8E6E1" stroke-opacity=".9" stroke-width="2"/><circle class="prog" cx="39" cy="39" r="37" fill="none" stroke="#F0B429" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="232.5" stroke-dashoffset="232.5" transform="rotate(-90 39 39)"/></svg>');
    this.prog = this.shutter.querySelector('.prog');
    this.bindShutter();
    this.doneBtn = h('button', { class: 'donebtn', onclick: () => this.done() }, 'Done');
    this.importInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => this.importPicked() });
    this.cameraInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none', onchange: () => this.importPicked(this.cameraInput) });
    const importBtn = h('button', { class: 'iconbtn', style: 'justify-self:start', 'aria-label': 'Import from Photos', onclick: () => this.importInput.click() }, icon('photos'));
    this.label = h('div', { class: 'shutter-label t-label' }, 'Hold for burst');
    const bottom = h('div', { class: 'bottom' },
      h('div', { class: 'strip-row' }, this.strip, rotBtn),
      h('div', { class: 'shutter-row' }, importBtn, this.shutter, this.doneBtn),
      this.label);
    this.el = h('section', { class: 'screen capture dark-only' }, chrome, this.vf, bottom, this.importInput, this.cameraInput);
    this.syncTools();
  }

  syncTools() {
    const auto = settings.get('auto');
    this.autoBtn.classList.toggle('on', auto);
    this.autoBtn.setAttribute('aria-pressed', auto);
    this.gridBtn.classList.toggle('on', settings.get('grid'));
    this.grid.classList.toggle('on', settings.get('grid'));
    this.aspectBtn.classList.toggle('on', settings.get('aspectLock'));
    this.torchBtn.classList.toggle('on', !!this.torch);
    this.torchBtn.style.display = this.torchCap ? '' : 'none';
    if (!auto) this.setProg(0);
  }

  // ---------- lifecycle ----------
  onShow() {
    ocr.pause(true);
    this.start();
  }
  onHide() { this.stop(); ocr.pause(false); }
  destroy() {
    this.stop();
    ocr.pause(false);
    this.offs.forEach((f) => f());
    document.removeEventListener('visibilitychange', this.onVis);
    if (this.worker) this.worker.terminate();
  }

  async start() {
    if (this.stream || this.starting) return;
    this.starting = true;
    this.msg.style.display = 'none';
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('nocam'), { name: 'NotSupportedError' });
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 }, aspectRatio: { ideal: 4 / 3 }, frameRate: { ideal: 30 } } });
      } catch (e) {
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw e;
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'environment' } });
      }
      if (router.top() !== this || document.hidden) { stream.getTracks().forEach((t) => t.stop()); this.starting = false; return; }
      this.stream = stream;
      this.track = stream.getVideoTracks()[0];
      this.video.srcObject = stream;
      await this.video.play().catch(() => {});
      const caps = this.track.getCapabilities ? this.track.getCapabilities() : {};
      this.torchCap = !!caps.torch;
      if (caps.focusMode && caps.focusMode.includes('continuous')) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      this.torch = false;
      this.syncTools();
      this.noCamera = false;
      this.wake();
      this.startDetect();
    } catch (e) {
      console.warn('camera', e);
      this.noCamera = true;
      this.showNoCamera(e);
    } finally {
      this.starting = false;
    }
  }

  stop() {
    this.running = false;
    if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; this.track = null; }
    this.video.srcObject = null;
    if (this.lock) { this.lock.release().catch(() => {}); this.lock = null; }
    this.endBurst();
  }

  async wake() {
    try { if (navigator.wakeLock) this.lock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
  }

  showNoCamera(e) {
    clear(this.msg);
    const denied = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    this.msg.append(
      h('div', { class: 't-label', style: 'color:#8B8F94' }, denied ? 'Camera access is off' : 'Live camera unavailable'),
      h('div', { class: 't-body', style: 'margin-top:8px;color:#8B8F94' }, denied ? 'Allow camera for this app in Settings, or take a photo instead.' : 'Take a photo instead. Edges are still detected.'),
      h('div', { style: 'display:flex;gap:8px;justify-content:center' },
        h('button', { class: 'btn primary', style: 'margin-top:16px', onclick: () => this.cameraInput.click() }, 'Take photo'),
        denied ? h('button', { class: 'btn', style: 'margin-top:16px', onclick: () => this.start() }, 'Retry') : null));
    this.msg.style.display = '';
  }

  // ---------- detection ----------
  startDetect() {
    if (!this.worker) {
      this.worker = new Worker(new URL('../engine/detect-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onDetect(e.data);
      this.small = document.createElement('canvas');
      this.sctx = this.small.getContext('2d', { willReadFrequently: true });
      this.seq = 0;
    }
    this.running = true;
    this.inflight = false;
    const tick = () => {
      if (!this.running) return;
      this.feed();
      this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  feed() {
    const v = this.video;
    if (this.inflight || v.readyState < 2 || !v.videoWidth) return;
    // ~20 detections/s is plenty for a smoothed overlay and spares the battery.
    const now = performance.now();
    if (now - (this.lastFeed || 0) < 48) return;
    this.lastFeed = now;
    const s = DETECT_MAX / Math.max(v.videoWidth, v.videoHeight);
    const w = Math.round(v.videoWidth * s), hh = Math.round(v.videoHeight * s);
    if (this.small.width !== w || this.small.height !== hh) { this.small.width = w; this.small.height = hh; }
    this.sctx.drawImage(v, 0, 0, w, hh);
    const data = this.sctx.getImageData(0, 0, w, hh);
    this.inflight = true;
    this.worker.postMessage({ id: ++this.seq, buf: data.data.buffer, w, h: hh }, [data.data.buffer]);
  }

  onDetect(r) {
    this.inflight = false;
    const now = performance.now();
    const w = this.small.width, hh = this.small.height;
    this.sig = r.sig;
    if (r.quad) {
      let moved = Infinity;
      if (this.raw && this.rawW === w) moved = Math.max(...r.quad.map((p, i) => Math.hypot(p[0] - this.raw[i][0], p[1] - this.raw[i][1])));
      if (moved > STABLE_PX || !this.stableSince) this.stableSince = now;
      this.raw = r.quad; this.rawW = w; this.rawH = hh;
      this.lastSeen = now;
      this.target = r.quad.map(([x, y]) => [x / w, y / hh]);
      this.area = r.area;
    } else if (now - this.lastSeen > 260) {
      this.target = null; this.raw = null; this.stableSince = 0;
    }
    this.rearm(now);
    this.autoCheck(now);
    this.hintCheck(now);
  }

  rearm(now) {
    if (this.armed) return;
    if (!this.target && now - this.lastSeen > 400) { this.armed = true; return; }
    if (this.target && this.capQuad) {
      const d = Math.max(...this.target.map((p, i) => Math.hypot(p[0] - this.capQuad[i][0], p[1] - this.capQuad[i][1])));
      if (d > 0.06) { this.armed = true; return; }
    }
    if (this.sig && this.capSig) {
      let s = 0;
      for (let i = 0; i < 64; i++) s += Math.abs(this.sig[i] - this.capSig[i]);
      if (s / 64 > 14) this.armed = true;
    }
  }

  autoCheck(now) {
    if (!settings.get('auto') || this.burst || this.busy) { if (!this.burst) this.setProg(0); return; }
    const cool = !this.lastCap || now - this.lastCap > 900;
    const ok = this.armed && this.target && this.area >= AUTO_MIN_AREA && cool;
    if (!ok) { this.setProg(0); return; }
    const t = (now - this.stableSince) / STABLE_MS;
    this.setProg(Math.min(1, t));
    if (t >= 1) this.capture({ auto: true });
  }

  hintCheck(now) {
    let t = '';
    if (this.burst) t = 'Burst';
    else if (!this.target && now - this.lastSeen > 1500) t = 'Looking for a page';
    else if (this.target && settings.get('auto') && this.area < AUTO_MIN_AREA) t = 'Move closer';
    else if (this.target && settings.get('auto') && !this.armed) t = 'Next page';
    if (t !== this.hintText) { this.hintText = t; if (t) this.hint.textContent = t; this.hint.classList.toggle('show', !!t); }
  }

  setProg(p) {
    if (p === this.lastProg) return;
    this.lastProg = p;
    this.prog.setAttribute('stroke-dashoffset', String(232.5 * (1 - p)));
  }

  videoRect() {
    const W = this.vf.clientWidth, H = this.vf.clientHeight;
    const vw = this.video.videoWidth || 3, vh = this.video.videoHeight || 4;
    const s = Math.min(W / vw, H / vh);
    return { x: (W - vw * s) / 2, y: (H - vh * s) / 2, w: vw * s, h: vh * s, W, H };
  }

  draw() {
    const c = this.overlay;
    const dpr = Math.min(3, devicePixelRatio || 1);
    const r = this.videoRect();
    if (c.width !== Math.round(r.W * dpr) || c.height !== Math.round(r.H * dpr)) {
      c.width = Math.round(r.W * dpr); c.height = Math.round(r.H * dpr);
      this.layoutGrid(r);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.W, r.H);
    if (!this.video.videoWidth) return;
    // ease quad + visibility
    const k = reducedMotion() ? 1 : 0.38;
    if (this.target) {
      if (!this.disp) this.disp = this.target.map((p) => p.slice());
      else this.disp = this.disp.map((p, i) => [p[0] + (this.target[i][0] - p[0]) * k, p[1] + (this.target[i][1] - p[1]) * k]);
      this.alpha = Math.min(1, this.alpha + 0.16);
    } else {
      this.alpha = Math.max(0, this.alpha - 0.12);
      if (!this.alpha) this.disp = null;
    }
    const a = this.alpha;
    const pts = this.disp ? this.disp.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]) : null;
    // dim: 80% brightness with no page, 45% outside a found page, 100% inside
    ctx.fillStyle = `rgba(0,0,0,${0.2 + 0.35 * a})`;
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    if (pts) { ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 3; i >= 1; i--) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }
    ctx.fill('evenodd');
    if (pts) {
      ctx.fillStyle = `rgba(0,0,0,${0.2 * (1 - a)})`;
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = `rgba(76,201,240,${a})`;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.fillStyle = `rgba(76,201,240,${a})`;
      for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  layoutGrid(r) {
    Object.assign(this.grid.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const [a, b, c, d] = this.grid.children;
    Object.assign(a.style, { left: '33.333%', top: 0, bottom: 0, width: '1px' });
    Object.assign(b.style, { left: '66.666%', top: 0, bottom: 0, width: '1px' });
    Object.assign(c.style, { top: '33.333%', left: 0, right: 0, height: '1px' });
    Object.assign(d.style, { top: '66.666%', left: 0, right: 0, height: '1px' });
  }

  // ---------- shutter ----------
  bindShutter() {
    let timer = 0;
    const down = (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      this.shutter.setPointerCapture && this.shutter.setPointerCapture(e.pointerId);
      this.shutter.classList.add('press');
      this.pressed = true;
      timer = setTimeout(() => { if (this.pressed) this.startBurst(); }, 380);
    };
    const up = () => {
      if (!this.pressed) return;
      this.pressed = false;
      clearTimeout(timer);
      this.shutter.classList.remove('press');
      if (this.burst) this.endBurst();
      else if (this.noCamera) this.cameraInput.click();
      else this.capture();
    };
    this.shutter.addEventListener('pointerdown', down);
    this.shutter.addEventListener('pointerup', up);
    this.shutter.addEventListener('pointercancel', () => { this.pressed = false; clearTimeout(timer); this.shutter.classList.remove('press'); this.endBurst(); });
    this.shutter.addEventListener('contextmenu', (e) => e.preventDefault());
    this.shutter.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.capture(); } });
  }

  startBurst() {
    if (this.noCamera) return;
    this.burst = true;
    this.shutter.classList.add('burst');
    this.label.textContent = 'Burst';
    haptic(8);
    const shoot = () => {
      if (!this.burst) return;
      const stable = !this.target || performance.now() - this.stableSince > 120;
      if (stable) this.capture({ burst: true });
      this.burstTimer = setTimeout(shoot, BURST_MS);
    };
    shoot();
  }

  endBurst() {
    if (!this.burst) return;
    this.burst = false;
    clearTimeout(this.burstTimer);
    this.shutter.classList.remove('burst');
    this.label.textContent = 'Hold for burst';
  }

  async ensureDoc() {
    if (this.docId && store.doc(this.docId)) return this.docId;
    const d = await store.createDoc({ status: 'draft' });
    this.docId = d.id;
    navigator.storage && navigator.storage.persist && navigator.storage.persist().catch(() => {});
    return d.id;
  }

  async capture({ auto = false } = {}) {
    const v = this.video;
    if (this.busy || !v.videoWidth || this.noCamera) return;
    this.busy = true;
    try {
      const vw = v.videoWidth, vh = v.videoHeight;
      const s = Math.min(1, SRC_MAX / Math.max(vw, vh));
      const frame = document.createElement('canvas');
      frame.width = Math.round(vw * s); frame.height = Math.round(vh * s);
      frame.getContext('2d').drawImage(v, 0, 0, frame.width, frame.height);
      const q = this.target && this.raw ? this.raw.map(([x, y]) => [(x / this.rawW) * frame.width, (y / this.rawH) * frame.height]) : fullQuad(frame.width, frame.height);
      this.lastCap = performance.now();
      this.armed = false;
      this.capQuad = this.target ? this.target.map((p) => p.slice()) : null;
      this.capSig = this.sig ? this.sig.slice() : null;
      this.stableSince = 0;
      this.setProg(0);
      this.flash();
      haptic(auto ? 8 : 6);
      const docId = await this.ensureDoc();
      const slot = this.addSlot(null, frame, q);
      this.fly(frame, q, slot);
      this.session++;
      const pagePromise = addCapturedPage(docId, frame, q, {
        rotation: this.rotation, filter: settings.get('filter'), aspectLock: settings.get('aspectLock'),
      });
      this.busy = false;
      const page = await pagePromise;
      this.bindSlot(slot, page.id);
      frame.width = frame.height = 0;
    } catch (e) {
      console.error('capture failed', e);
      toast('Capture failed');
    } finally {
      this.busy = false;
      this.updateCount();
    }
  }

  flash() {
    if (reducedMotion()) return;
    this.flashEl.animate([{ opacity: 0.15 }, { opacity: 0 }], { duration: 60, easing: 'linear' });
  }

  // Placeholder thumbnail cut from the frame's quad bbox, then the real render replaces it.
  addSlot(pageId, frame, q) {
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const x0 = Math.max(0, Math.min(...xs)), y0 = Math.max(0, Math.min(...ys)), x1 = Math.min(frame.width, Math.max(...xs)), y1 = Math.min(frame.height, Math.max(...ys));
    const ph = h('canvas', { width: 112, height: Math.max(16, Math.round((112 * (y1 - y0)) / Math.max(1, x1 - x0))) });
    ph.getContext('2d').drawImage(frame, x0, y0, x1 - x0, y1 - y0, 0, 0, ph.width, ph.height);
    const el = h('button', { class: 'fthumb busy', role: 'listitem', 'aria-label': 'Captured page', onclick: () => this.openReview(el._pageId) }, ph);
    this.strip.append(el);
    this.strip.scrollLeft = this.strip.scrollWidth;
    if (pageId) this.bindSlot(el, pageId);
    return el;
  }

  bindSlot(el, pageId) {
    el._pageId = pageId;
    this.slots.set(pageId, el);
    this.refreshSlot(pageId);
  }

  async refreshSlot(id) {
    const el = this.slots.get(id);
    if (!el) return;
    const p = store.page(id);
    if (!p || p.trashed) { el.remove(); this.slots.delete(id); this.updateCount(); return; }
    const busy = isBusy(id) || !p.thumb;
    el.classList.toggle('busy', busy);
    if (p.thumb && el._thumb !== p.thumb.path) {
      el._thumb = p.thumb.path;
      const b = await blobs.getBlob(p.thumb.path);
      if (b) {
        const img = h('img', { alt: '', src: blobUrl('slot:' + id, b) });
        el.replaceChildren(img, p.blank ? h('i', { class: 'blank', title: 'Looks blank' }) : null);
      }
    }
  }

  fly(frame, q, slot) {
    if (reducedMotion()) return;
    const r = this.videoRect();
    const vfr = this.vf.getBoundingClientRect();
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const sx = r.w / frame.width, sy = r.h / frame.height;
    const x0 = vfr.left + r.x + Math.min(...xs) * sx, y0 = vfr.top + r.y + Math.min(...ys) * sy;
    const w0 = (Math.max(...xs) - Math.min(...xs)) * sx, h0 = (Math.max(...ys) - Math.min(...ys)) * sy;
    const t = slot.getBoundingClientRect();
    const g = h('canvas', { class: 'ghost-fly', width: Math.round(w0), height: Math.round(h0), style: { left: '0px', top: '0px', width: `${w0}px`, height: `${h0}px` } });
    g.getContext('2d').drawImage(frame, Math.min(...xs), Math.min(...ys), w0 / sx, h0 / sy, 0, 0, g.width, g.height);
    document.body.append(g);
    slot.style.visibility = 'hidden';
    const s1 = Math.min(t.width / Math.max(1, w0), t.height / Math.max(1, h0));
    const anim = g.animate([
      { transform: `translate(${x0}px, ${y0}px) scale(1)`, opacity: 1 },
      { transform: `translate(${t.left + (t.width - w0 * s1) / 2}px, ${t.top + (t.height - h0 * s1) / 2}px) scale(${s1})`, opacity: 1 },
    ], { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
    anim.onfinish = () => { g.remove(); slot.style.visibility = ''; };
  }

  updateCount() {
    const n = this.docId ? store.pagesOf(this.docId).length : 0;
    this.counter.textContent = n ? pgs(n) : '';
    this.doneBtn.classList.toggle('show', n > 0);
  }

  loadExisting() {
    for (const p of store.pagesOf(this.docId)) {
      const el = h('button', { class: 'fthumb', role: 'listitem', onclick: () => this.openReview(p.id) });
      this.strip.append(el);
      this.bindSlot(el, p.id);
    }
    requestAnimationFrame(() => { this.strip.scrollLeft = this.strip.scrollWidth; });
    this.updateCount();
  }

  rotate() {
    this.rotation = (this.rotation + 90) % 360;
    haptic(4);
    this.rotBadge.textContent = `Rotate ${this.rotation}°`;
    this.rotBadge.classList.toggle('show', this.rotation !== 0);
  }

  async toggleTorch() {
    if (!this.track) return;
    this.torch = !this.torch;
    try { await this.track.applyConstraints({ advanced: [{ torch: this.torch }] }); } catch { this.torch = false; }
    this.syncTools();
  }

  async importPicked(input = this.importInput) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const docId = await this.ensureDoc();
    for (const f of files) {
      try {
        const c = await decodeFile(f);
        const q = detectOnCanvas(c);
        const slot = this.addSlot(null, c, q);
        const page = await addCapturedPage(docId, c, q, { rotation: this.rotation, filter: settings.get('filter'), aspectLock: settings.get('aspectLock') });
        this.bindSlot(slot, page.id);
        this.session++;
        c.width = c.height = 0;
      } catch (e) { console.warn(e); }
    }
    this.updateCount();
  }

  openReview(pageId) {
    if (!this.docId) return;
    const idx = Math.max(0, store.doc(this.docId).pageIds.indexOf(pageId));
    go('review', this.docId, { fromCapture: true, index: idx });
  }

  done() {
    if (!this.docId || !store.pagesOf(this.docId).length) return;
    haptic(4);
    go('review', this.docId, { fromCapture: true });
  }

  async beforeLeave() {
    const d = this.docId && store.doc(this.docId);
    if (!d || d.status !== 'draft' || !d.pageIds.length) {
      if (d && d.status === 'draft' && !d.pageIds.length) store.finalizeDoc(d.id, true);
      return true;
    }
    const n = d.pageIds.length;
    const r = await confirm({ title: `Keep ${n} ${n === 1 ? 'page' : 'pages'}?`, sub: 'Saved scans resume from the library', ok: 'Save for later', alt: 'Discard', cancel: 'Keep scanning' });
    if (r === true) return true;
    if (r === 'alt') {
      const undo = await store.trashDoc(d.id);
      let undone = false;
      toast(`Discarded ${n} ${n === 1 ? 'page' : 'pages'}`, { actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); } }], onExpire: () => { if (!undone) store.finalizeDoc(d.id); } });
      return true;
    }
    return false;
  }
}

