// DOCUMENT: editable title, mono metadata, 3-up page grid (long-press to reorder),
// capture FAB to add pages, export via the share icon.

import { h, blobUrl } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import * as settings from '../core/settings.js';
import * as ocr from '../engine/ocr.js';
import { fmtBytes, pages as pagesLabel, fmtDateTime, pad2 } from '../core/format.js';
import { haptic } from '../core/haptics.js';
import { onRendered, isBusy, importFiles } from '../engine/process.js';
import * as router from '../ui/router.js';
import { go } from '../ui/nav.js';
import { sheet, menu } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';

export class DocumentScreen {
  constructor(docId) {
    this.docId = docId;
    this.isDocument = true;
    this.hasFab = true;
    this.cells = new Map();
    this.build();
    this.offs = [
      store.on('doc', ({ id }) => { if (id === docId) this.schedule(); }),
      store.on('page', ({ docId: d }) => { if (d === docId) this.schedule(); }),
      store.on('ocr', ({ docId: d }) => { if (d === docId) this.renderMeta(); }),
      onRendered(() => this.schedule()),
    ];
    this.render();
  }

  build() {
    this.titleSm = h('div', { class: 'title-sm ellipsis' });
    this.bar = h('div', { class: 'topbar float' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => router.back() }, icon('back')),
      this.titleSm, h('div', { class: 'spacer' }),
      h('button', { class: 'iconbtn', 'aria-label': 'Export', onclick: () => this.export() }, icon('share')),
      h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: () => this.more() }, icon('more')));
    this.title = h('h1', { class: 'doc-title', onclick: () => this.rename() });
    this.meta = h('div', { class: 'meta t-label', style: 'margin-top:8px;color:var(--text-dim)' });
    this.grid = h('div', { class: 'pgrid', role: 'list' });
    this.scroll = h('div', { class: 'scroll', onscroll: () => this.bar.classList.toggle('solid', this.scroll.scrollTop > 40) },
      h('div', { style: 'height:calc(44px + var(--safe-t))' }),
      h('div', { class: 'lhead' }, this.title, this.meta),
      this.grid);
    this.fab = h('button', { class: 'fab', 'aria-label': 'Add pages', onclick: () => { haptic(4); go('capture', { docId: this.docId }); } }, icon('capture', 28));
    this.fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => this.imported() });
    this.el = h('section', { class: 'screen document' }, this.bar, this.scroll, h('div', { class: 'fab-scrim' }), this.fab, this.fileInput);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  onShow() { this.render(); }

  render() {
    const d = store.doc(this.docId);
    if (!d) return;
    if (this.dragging) return;
    this.title.textContent = d.name;
    this.titleSm.textContent = d.name;
    this.renderMeta();
    const ps = store.pagesOf(d.id);
    const keep = new Set();
    ps.forEach((p, i) => {
      keep.add(p.id);
      let c = this.cells.get(p.id);
      if (!c) { c = this.cell(p.id); this.cells.set(p.id, c); }
      c.num.textContent = pad2(i + 1);
      c.el.setAttribute('aria-label', `Page ${i + 1}`);
      this.fill(c, p);
      if (this.grid.children[i] !== c.el) this.grid.insertBefore(c.el, this.grid.children[i] || null);
    });
    for (const [id, c] of this.cells) if (!keep.has(id)) { c.el.remove(); this.cells.delete(id); }
  }

  renderMeta() {
    const d = store.doc(this.docId);
    if (!d) return;
    const pr = store.ocrProgress(d.id);
    const text = pr.total ? (pr.done === pr.total ? 'TEXT' : `TEXT ${pr.done}/${pr.total}`) : '';
    this.meta.textContent = [pagesLabel(d.pageIds.length), fmtBytes(store.docBytes(d)), fmtDateTime(d.created), settings.get('ocr') ? text : ''].filter(Boolean).join(' · ');
  }

  cell(id) {
    const img = h('img', { alt: '', decoding: 'async' });
    const c = { img, num: h('div', { class: 'num t-label' }), path: null };
    c.thumb = h('div', { class: 'thumb' }, img);
    c.el = h('div', { class: 'pcell', role: 'listitem', tabindex: '0' }, c.thumb, c.num);
    c.el.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.open(id); });
    this.bindDrag(c, id);
    return c;
  }

  async fill(c, p) {
    c.thumb.classList.toggle('fthumb-busy', isBusy(p.id));
    if (p.thumb && p.thumb.path !== c.path) {
      c.path = p.thumb.path;
      const b = await blobs.getBlob(p.thumb.path);
      if (b && c.path === p.thumb.path) c.img.src = blobUrl('pg:' + p.id, b);
    }
  }

  open(id) {
    const idx = store.doc(this.docId).pageIds.indexOf(id);
    if (idx >= 0) go('reader', this.docId, idx);
  }

  // Tap opens; long-press lifts the page and lets you drop it elsewhere.
  bindDrag(c, id) {
    let timer = 0, sx = 0, sy = 0, lifted = false, down = false, rects = null, from = 0, to = 0, order = null, lastY = 0, scrollRaf = 0;
    const el = c.el;
    const start = (e) => {
      if (e.button > 0) return;
      down = true; lifted = false; sx = e.clientX; sy = e.clientY;
      timer = setTimeout(() => lift(e), 400);
    };
    const lift = () => {
      if (!down) return;
      lifted = true; this.dragging = true;
      haptic(8);
      order = store.doc(this.docId).pageIds.slice();
      from = to = order.indexOf(id);
      rects = order.map((pid) => this.cells.get(pid).el.getBoundingClientRect());
      el.classList.add('dragging');
      for (const pid of order) if (pid !== id) this.cells.get(pid).el.classList.add('shift');
      el.setPointerCapture && el.setPointerCapture(this._pid);
      autoScroll();
    };
    const autoScroll = () => {
      if (!lifted) return;
      const r = this.scroll.getBoundingClientRect();
      const v = lastY < r.top + 80 ? -8 : lastY > r.bottom - 120 ? 8 : 0;
      if (v) { this.scroll.scrollTop += v; sy -= v; rects = rects.map((q) => ({ left: q.left, top: q.top - v, width: q.width, height: q.height })); }
      scrollRaf = requestAnimationFrame(autoScroll);
    };
    const move = (e) => {
      lastY = e.clientY;
      if (!down) return;
      if (!lifted) { if (Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); down = false; } return; }
      e.preventDefault();
      const dx = e.clientX - sx, dy = e.clientY - sy;
      el.style.transform = `translate(${dx}px, ${dy}px) scale(1.04)`;
      // nearest slot to the pointer
      let best = from, bd = Infinity;
      rects.forEach((q, i) => { const d = Math.hypot(q.left + q.width / 2 - e.clientX, q.top + q.height / 2 - e.clientY); if (d < bd) { bd = d; best = i; } });
      if (best !== to) {
        to = best;
        haptic(4);
        const next = order.filter((x) => x !== id);
        next.splice(to, 0, id);
        next.forEach((pid, i) => {
          if (pid === id) return;
          const j = order.indexOf(pid);
          const a = rects[j], b = rects[i];
          this.cells.get(pid).el.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px)`;
        });
      }
    };
    const end = async () => {
      clearTimeout(timer);
      cancelAnimationFrame(scrollRaf);
      if (!down) return;
      down = false;
      if (!lifted) { this.open(id); return; }
      lifted = false;
      const next = order.filter((x) => x !== id);
      next.splice(to, 0, id);
      for (const pid of order) { const ce = this.cells.get(pid).el; ce.classList.remove('shift', 'dragging'); ce.style.transform = ''; }
      this.dragging = false;
      if (to !== from) {
        const before = order;
        await store.reorder(this.docId, next);
        toast(`Moved to page ${to + 1}`, { actions: [{ label: 'Undo', run: () => store.reorder(this.docId, before) }] });
      } else this.render();
    };
    el.addEventListener('pointerdown', (e) => { this._pid = e.pointerId; start(e); });
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('touchmove', (e) => { if (lifted) e.preventDefault(); }, { passive: false });
  }

  export() { go('export', { docs: [store.doc(this.docId)] }); }

  more() {
    const d = store.doc(this.docId);
    menu({
      title: d.name,
      items: [
        { label: 'Rename', icon: icon('rename'), run: () => this.rename() },
        { label: 'Add pages', icon: icon('addpage'), run: () => go('capture', { docId: this.docId }) },
        { label: 'Import images', icon: icon('photos'), run: () => this.fileInput.click() },
        { label: 'Edit pages', icon: icon('edit'), run: () => go('review', this.docId, { index: 0 }) },
        { label: 'Delete document', icon: icon('trash'), danger: true, run: () => this.del() },
      ],
    });
  }

  rename() {
    const d = store.doc(this.docId);
    const input = h('input', { class: 'field', value: d.name, autocapitalize: 'sentences', enterkeyhint: 'done', 'aria-label': 'Document name' });
    const save = async () => {
      const v = input.value.trim();
      if (v && v !== d.name) await store.updateDoc(d.id, { name: v, named: true });
      s.close('save');
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const s = sheet({ title: 'Rename', body: h('div', { style: 'padding-top:4px' }, input), foot: h('button', { class: 'btn primary block', onclick: save }, 'Save') });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  }

  async imported() {
    const files = Array.from(this.fileInput.files || []);
    this.fileInput.value = '';
    if (!files.length) return;
    const t = toast(`Importing ${files.length}…`, { duration: 60000 });
    await importFiles(this.docId, files, { filter: settings.get('filter') });
    t.dismiss(false);
    ocr.enqueueMissing();
  }

  async del() {
    const d = store.doc(this.docId);
    const undo = await store.trashDoc(d.id);
    let undone = false;
    router.back();
    toast(`Deleted “${d.name}”`, {
      actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); } }],
      onExpire: () => { if (!undone) store.finalizeDoc(d.id); },
    });
  }

  destroy() { this.offs.forEach((f) => f()); }
}
