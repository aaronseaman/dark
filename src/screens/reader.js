// READER: swipe between full pages, double-tap to zoom, OCR text sheet,
// and Night Reading (inverts the view, never the file; badge says so).

import { h, clear, blobUrl } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import * as ocr from '../engine/ocr.js';
import { haptic } from '../core/haptics.js';
import { onRendered } from '../engine/process.js';
import * as router from '../ui/router.js';
import { go } from '../ui/nav.js';
import { sheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';

let night = false; // remembered for the session

export class Reader {
  constructor(docId, index = 0) {
    this.docId = docId;
    this.index = index;
    this.slides = [];
    this.toastLift = '78px';
    this.build();
    this.offs = [
      store.on('doc', ({ id }) => { if (id === docId && store.doc(docId)?.pageIds.join() !== this.ids.join()) this.rebuild(); }),
      onRendered((id) => { const i = this.ids.indexOf(id); if (i >= 0) this.load(i, true); }),
    ];
    this.rebuild();
    requestAnimationFrame(() => { this.pager.scrollLeft = this.index * this.pager.clientWidth; this.loadAround(); });
  }

  build() {
    this.counter = h('div', { class: 'title-sm t-mono', style: 'opacity:1' });
    const bar = h('div', { class: 'topbar' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => router.back() }, icon('back')),
      this.counter, h('div', { class: 'spacer' }),
      h('button', { class: 'iconbtn', 'aria-label': 'Export', onclick: () => go('export', { docs: [store.doc(this.docId)], pageIndex: this.index }) }, icon('share')));
    this.pager = h('div', { class: 'pager', onscroll: () => this.onScroll() });
    const act = (ic, label, fn) => h('button', { class: 'action', 'aria-label': label, onclick: fn }, icon(ic), h('span', { class: 't-label' }, label));
    this.nightBtn = act('night', 'Night', () => this.toggleNight());
    const actions = h('div', { class: 'actions' },
      act('edit', 'Edit', () => go('review', this.docId, { index: this.index })),
      act('text', 'Text', () => this.text()),
      this.nightBtn,
      act('trash', 'Del', () => this.del()));
    this.badge = h('div', { class: 'viewonly t-label' }, '◐ View only');
    this.el = h('section', { class: 'screen reader' + (night ? ' night' : '') }, bar, this.pager, this.badge, actions);
    this.nightBtn.classList.toggle('on', night);
  }

  rebuild() {
    const d = store.doc(this.docId);
    if (!d) return;
    this.ids = d.pageIds.slice();
    if (!this.ids.length) { router.back(); return; }
    clear(this.pager);
    this.slides = this.ids.map((id, i) => {
      const img = h('img', { alt: `Page ${i + 1}` });
      const pg = h('div', { class: 'pg' }, img);
      const s = h('div', { class: 'slide' }, pg);
      const obj = { el: s, img, loaded: null };
      let lastTap = 0;
      s.addEventListener('click', (e) => {
        const now = Date.now();
        if (now - lastTap < 300) this.zoom(obj, e);
        lastTap = now;
      });
      this.pager.append(s);
      return obj;
    });
    this.index = Math.min(this.index, this.ids.length - 1);
    this.pager.scrollLeft = this.index * this.pager.clientWidth;
    this.updateCounter();
    this.loadAround();
  }

  onScroll() {
    const i = Math.round(this.pager.scrollLeft / Math.max(1, this.pager.clientWidth));
    if (i !== this.index && i >= 0 && i < this.ids.length) {
      const prev = this.slides[this.index];
      if (prev && prev.el.classList.contains('zoom')) prev.el.classList.remove('zoom');
      this.index = i;
      this.updateCounter();
      this.loadAround();
    }
  }

  updateCounter() { this.counter.textContent = `${this.index + 1} / ${this.ids.length}`; }

  loadAround() {
    this.slides.forEach((s, i) => {
      if (Math.abs(i - this.index) <= 1) this.load(i);
      else if (s.loaded) { s.img.removeAttribute('src'); s.loaded = null; }
    });
  }

  async load(i, force) {
    const s = this.slides[i];
    const p = store.page(this.ids[i]);
    if (!s || !p || !p.out) return;
    if (!force && s.loaded === p.out.path) return;
    s.loaded = p.out.path;
    const b = await blobs.getBlob(p.out.path);
    if (b && s.loaded === p.out.path) s.img.src = blobUrl('rd:' + p.id, b);
  }

  zoom(s, e) {
    haptic(4);
    const on = !s.el.classList.contains('zoom');
    const r = s.img.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    s.el.classList.toggle('zoom', on);
    this.pager.style.scrollSnapType = on ? 'none' : '';
    this.pager.style.overflowX = on ? 'hidden' : '';
    if (on) requestAnimationFrame(() => { s.el.scrollLeft = fx * s.el.scrollWidth - s.el.clientWidth / 2; s.el.scrollTop = fy * s.el.scrollHeight - s.el.clientHeight / 2; });
  }

  toggleNight() {
    night = !night;
    haptic(4);
    this.el.classList.toggle('night', night);
    this.nightBtn.classList.toggle('on', night);
  }

  text() {
    const id = this.ids[this.index];
    const body = h('div');
    const copy = h('button', { class: 'btn block', disabled: true, onclick: async () => {
      const r = store.ocrFor(id);
      if (!r) return;
      try { await navigator.clipboard.writeText(r.text); haptic(8); toast('Copied'); } catch { toast('Copy blocked — select the text instead'); }
    } }, icon('copy', 20), 'Copy text');
    const s = sheet({ title: 'Text', sub: `Page ${this.index + 1}`, body, foot: copy });
    const paint = () => {
      const r = store.ocrFor(id);
      clear(body);
      if (r) {
        const n = r.words.length;
        s.setSub(`Page ${this.index + 1} · ${n} ${n === 1 ? 'word' : 'words'}`);
        body.append(r.text ? h('div', { class: 'ocrtext' }, r.text) : h('div', { class: 't-label dim', style: 'padding:16px 0' }, 'No text found'));
        copy.disabled = !r.text;
        return;
      }
      const st = ocr.status(id);
      body.append(h('div', { class: 't-label dim', style: 'padding:16px 0' },
        st === 'running' ? 'Recognizing…' : st === 'waiting' || !ocr.isReady() ? 'Text engine not installed yet' : 'Queued'));
      if (st === 'none' && ocr.isReady()) ocr.enqueue(id, true);
    };
    paint();
    const off1 = store.on('ocr', ({ pageId }) => { if (pageId === id) paint(); });
    const off2 = ocr.on(({ pageId }) => { if (pageId === id) paint(); });
    const close = s.close;
    s.close = (r) => { off1(); off2(); close(r); };
  }

  async del() {
    const id = this.ids[this.index];
    haptic(6);
    const undo = await store.trashPages([id]);
    let undone = false;
    toast('Page deleted', {
      actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); } }],
      onExpire: () => { if (!undone) store.finalizePage(id); },
    });
  }

  destroy() { this.offs.forEach((f) => f()); }
}
