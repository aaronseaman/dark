// REVIEW / PAGE EDITOR: a light table. Filmstrip on top, one large page, five filters,
// rotate / crop / shadow / delete. Every change is undoable and re-rendered in the background.

import { h, clear, blobUrl } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import { haptic } from '../core/haptics.js';
import { renderPreview, editPage, onRendered, isBusy } from '../engine/process.js';
import { FILTER_KEYS } from '../engine/gl.js';
import * as router from '../ui/router.js';
import { go } from '../ui/nav.js';
import { toast } from '../ui/toast.js';

const LABELS = { original: 'Original', enhance: 'Enhance', bw: 'B&W', gray: 'Gray', ink: 'Ink' };

export class Review {
  constructor(docId, { fromCapture = false, fromImport = false, index = 0 } = {}) {
    this.docId = docId;
    this.fromCapture = fromCapture;
    this.fromImport = fromImport;
    this.toastLift = '118px';
    this.index = index;
    this.seq = 0;
    this.thumbs = new Map();
    this.build();
    this.offs = [
      store.on('doc', ({ id }) => { if (id === this.docId) this.sync(); }),
      store.on('page', ({ id }) => this.refreshThumb(id)),
      onRendered((id) => this.refreshThumb(id)),
    ];
    this.sync();
    requestAnimationFrame(() => this.select(Math.min(this.index, this.pages().length - 1), true));
  }

  pages() { return store.pagesOf(this.docId); }
  cur() { return this.pages()[this.index]; }

  build() {
    this.doneBtn = h('button', { class: 'textbtn', onclick: () => this.done() }, 'Done');
    const bar = h('div', { class: 'topbar' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => router.back() }, icon('back')),
      h('div', { class: 'title-sm', style: 'opacity:1' }, 'Review'),
      h('div', { class: 'spacer' }), this.doneBtn);
    this.blankChip = h('button', { class: 'chip blankchip', style: 'display:none', onclick: () => this.discardBlanks() });
    this.strip = h('div', { class: 'rstrip', role: 'list' });
    this.layerA = h('div', { class: 'layer' });
    this.layerB = h('div', { class: 'layer', style: 'opacity:0' });
    this.busy = h('div', { class: 'busy t-label' }, 'Rendering');
    this.stage = h('div', { class: 'stage' }, this.layerA, this.layerB, this.busy);
    this.filterBtns = FILTER_KEYS.map((k) => h('button', { class: 't-label', 'data-k': k, onclick: () => this.setFilter(k) }, LABELS[k]));
    const filters = h('div', { class: 'filters', role: 'radiogroup', 'aria-label': 'Filter' }, this.filterBtns);
    const act = (ic, label, fn) => h('button', { class: 'action', onclick: fn, 'aria-label': label }, icon(ic), h('span', { class: 't-label' }, label));
    this.shadowBtn = act('shadow', 'Shadow', () => this.toggleShadow());
    const actions = h('div', { class: 'actions' },
      act('rotate', 'Rot', () => this.rotate()),
      act('crop', 'Crop', () => this.crop()),
      this.shadowBtn,
      act('trash', 'Del', () => this.del()));
    this.el = h('section', { class: 'screen review' }, bar, this.blankChip, this.strip, this.stage, filters, actions);
  }

  onShow() { this.sync(); if (this.cur()) this.preview(); }

  sync() {
    const ps = this.pages();
    if (!ps.length) return;
    // filmstrip diff
    const keep = new Set(ps.map((p) => p.id));
    for (const [id, el] of this.thumbs) if (!keep.has(id)) { el.remove(); this.thumbs.delete(id); }
    ps.forEach((p, i) => {
      let el = this.thumbs.get(p.id);
      if (!el) {
        el = h('button', { class: 'fthumb', role: 'listitem', 'aria-label': `Page ${i + 1}`, onclick: () => this.select(this.pages().findIndex((x) => x.id === p.id)) });
        this.thumbs.set(p.id, el);
        this.refreshThumb(p.id);
      }
      if (this.strip.children[i] !== el) this.strip.insertBefore(el, this.strip.children[i] || null);
    });
    if (this.index >= ps.length) this.index = ps.length - 1;
    this.thumbs.forEach((el, id) => el.classList.toggle('sel', id === ps[this.index]?.id));
    const blanks = ps.filter((p) => p.blank);
    this.blankChip.style.display = blanks.length ? '' : 'none';
    this.blankChip.textContent = `Discard ${blanks.length} blank ${blanks.length === 1 ? 'page' : 'pages'}`;
    this.syncControls();
  }

  async refreshThumb(id) {
    const el = this.thumbs.get(id);
    const p = store.page(id);
    if (!el || !p) return;
    el.classList.toggle('busy', isBusy(id) || !p.thumb);
    if (p.thumb && el._path !== p.thumb.path) {
      el._path = p.thumb.path;
      const b = await blobs.getBlob(p.thumb.path);
      if (b) el.replaceChildren(h('img', { alt: '', src: blobUrl('r:' + id, b) }), p.blank ? h('i', { class: 'blank' }) : null);
    } else if (p.thumb) {
      const dot = el.querySelector('.blank');
      if (p.blank && !dot) el.append(h('i', { class: 'blank' }));
      if (!p.blank && dot) dot.remove();
    }
    // The first preview may have fallen back to the stored render; upgrade once the source exists.
    if (id === this.cur()?.id && this.fallback && !this.previewing && p.src?.bytes) { this.fallback = false; this.preview(true); }
  }

  syncControls() {
    const p = this.cur();
    if (!p) return;
    this.filterBtns.forEach((b) => { const on = b.dataset.k === p.filter; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); b.setAttribute('role', 'radio'); });
    const orig = p.filter === 'original';
    this.shadowBtn.disabled = orig;
    this.shadowBtn.classList.toggle('on', !orig && p.shadow);
    this.shadowBtn.classList.toggle('off', !orig && !p.shadow);
    this.shadowBtn.setAttribute('aria-pressed', !orig && p.shadow);
  }

  select(i, instant = false) {
    const ps = this.pages();
    if (i < 0 || i >= ps.length) return;
    this.index = i;
    this.thumbs.forEach((el, id) => el.classList.toggle('sel', id === ps[i].id));
    const el = this.thumbs.get(ps[i].id);
    el && el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: instant ? 'auto' : 'smooth' });
    this.syncControls();
    this.preview(instant);
  }

  previewSize() {
    const dpr = Math.min(3, devicePixelRatio || 1);
    return Math.min(2000, Math.ceil(Math.max(this.stage.clientWidth, this.stage.clientHeight) * dpr));
  }

  async preview(instant = false) {
    const p = this.cur();
    if (!p) return;
    const seq = ++this.seq;
    this.previewing = true;
    const t = setTimeout(() => this.busy.classList.add('show'), 250);
    let node = null;
    this.fallback = false;
    try {
      if (!p.src || !p.src.path) throw new Error('no source yet');
      node = await renderPreview(p, { maxEdge: this.previewSize() });
    } catch (e) {
      this.fallback = true;
      // Source not on disk yet (still encoding) or no WebGL: fall back to the stored render.
      const b = p.out && (await blobs.getBlob(p.out.path));
      if (b) node = h('img', { alt: '', src: blobUrl('rv:' + p.id, b) });
    } finally {
      clearTimeout(t);
      this.busy.classList.remove('show');
      this.previewing = false;
    }
    if (seq !== this.seq || !node) return;
    node.setAttribute('role', 'img');
    node.setAttribute('aria-label', `Page ${this.index + 1}, ${LABELS[p.filter]}`);
    // cross-fade 140ms
    const [front, back] = this.layerA.style.opacity === '0' ? [this.layerB, this.layerA] : [this.layerA, this.layerB];
    clear(back).append(node);
    if (instant) { back.style.transition = front.style.transition = 'none'; }
    back.style.opacity = '1';
    front.style.opacity = '0';
    if (instant) requestAnimationFrame(() => { back.style.transition = front.style.transition = ''; });
    setTimeout(() => { if (front.style.opacity === '0') clear(front); }, 200);
  }

  async setFilter(k) {
    const p = this.cur();
    if (!p || p.filter === k) return;
    haptic(4);
    editPage(p.id, { filter: k });
    this.syncControls();
    this.preview();
    const ps = this.pages();
    if (ps.length > 1) {
      toast(`${LABELS[k]}`, {
        duration: 3000,
        actions: [{
          label: 'Apply to all', run: async () => {
            const before = ps.map((x) => [x.id, x.filter]);
            for (const x of ps) if (x.filter !== k) editPage(x.id, { filter: k });
            this.sync();
            toast(`${LABELS[k]} on ${ps.length} pages`, { actions: [{ label: 'Undo', run: () => { for (const [id, f] of before) if (store.page(id)?.filter !== f) editPage(id, { filter: f }); this.sync(); this.preview(); } }] });
          },
        }],
      });
    }
  }

  rotate() {
    const p = this.cur();
    if (!p) return;
    haptic(4);
    const before = p.rotation;
    editPage(p.id, { rotation: (p.rotation + 90) % 360 });
    this.preview();
    this.undoToast('Rotated', () => { editPage(p.id, { rotation: before }); this.preview(); });
  }

  toggleShadow() {
    const p = this.cur();
    if (!p || p.filter === 'original') return;
    haptic(4);
    editPage(p.id, { shadow: !p.shadow });
    this.syncControls();
    this.preview();
  }

  crop() {
    const p = this.cur();
    if (!p || !p.src) return;
    go('crop', p.id, (quad) => {
      const before = p.quad;
      editPage(p.id, { quad });
      this.preview();
      this.undoToast('Cropped', () => { editPage(p.id, { quad: before }); this.preview(); });
    });
  }

  undoToast(msg, undo) {
    toast(msg, { actions: [{ label: 'Undo', run: undo }] });
  }

  async del() {
    const p = this.cur();
    if (!p) return;
    haptic(6);
    const undo = await store.trashPages([p.id]);
    let undone = false;
    const left = this.pages().length;
    toast('Page deleted', {
      actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); this.sync(); this.select(this.pages().findIndex((x) => x.id === p.id)); } }],
      onExpire: () => { if (!undone) store.finalizePage(p.id); },
    });
    if (!left) { this.leaveEmpty(); return; }
    this.sync();
    this.select(Math.min(this.index, left - 1));
  }

  async discardBlanks() {
    const ids = this.pages().filter((p) => p.blank).map((p) => p.id);
    if (!ids.length) return;
    haptic(6);
    const undo = await store.trashPages(ids);
    let undone = false;
    toast(`Discarded ${ids.length} blank ${ids.length === 1 ? 'page' : 'pages'}`, {
      actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); this.sync(); this.preview(); } }],
      onExpire: () => { if (!undone) for (const id of ids) store.finalizePage(id); },
    });
    if (!this.pages().length) { this.leaveEmpty(); return; }
    this.sync();
    this.select(Math.min(this.index, this.pages().length - 1));
  }

  leaveEmpty() {
    if (this.fromCapture) router.back();
    else router.popTo(router.rootScreen());
  }

  async done() {
    const d = store.doc(this.docId);
    if (!d) return;
    haptic(4);
    if (!this.fromCapture && !this.fromImport) { router.back(); return; }
    if (d.status === 'draft') await store.updateDoc(d.id, { status: 'done' });
    // Land on the document (reusing it if it's already in the stack), then offer export.
    const existing = router.find((s) => s.isDocument && s.docId === d.id);
    const open = () => go('export', { docs: [store.doc(d.id)] });
    if (existing) router.popTo(existing, open);
    else router.popTo(router.rootScreen(), () => { go('document', d.id); setTimeout(open, 340); });
  }

  destroy() { this.offs.forEach((f) => f()); }
}
