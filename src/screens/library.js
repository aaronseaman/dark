// LIBRARY (root): large title, aggregate stats, 2-up grid, OCR-backed search, capture FAB.

import { h, clear, longPress, blobUrl } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as store from '../core/store.js';
import * as blobs from '../core/blobstore.js';
import { fmtBytes, pgs, pages as pagesLabel, fmtDate } from '../core/format.js';
import { haptic } from '../core/haptics.js';
import { go } from '../ui/nav.js';
import { menu } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';
import { importFiles } from '../engine/process.js';
import * as settings from '../core/settings.js';

const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class Library {
  constructor() {
    this.hasFab = true;
    this.query = '';
    this.searching = false;
    this.selecting = false;
    this.sel = new Set();
    this.cards = new Map();
    this.build();
    this.offs = [
      store.on('docs', () => this.schedule()),
      store.on('doc', () => this.schedule()),
      store.on('page', () => this.schedule()),
      store.on('ocr', () => { if (this.query) this.schedule(); }),
    ];
    this.render();
  }

  build() {
    this.titleSm = h('div', { class: 'title-sm' }, 'Documents');
    this.searchBtn = h('button', { class: 'iconbtn', 'aria-label': 'Search', onclick: () => this.toggleSearch(true) }, icon('search'));
    this.moreBtn = h('button', { class: 'iconbtn', 'aria-label': 'More', onclick: () => this.more() }, icon('more'));
    this.doneBtn = h('button', { class: 'textbtn', style: 'display:none', onclick: () => this.setSelecting(false) }, 'Done');
    this.bar = h('div', { class: 'topbar float' }, h('div', { class: 'spacer' }), this.titleSm, this.searchBtn, this.moreBtn, this.doneBtn);
    this.meta = h('div', { class: 'meta t-label' });
    this.input = h('input', { class: 'field', type: 'search', placeholder: 'Search text in every page', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, enterkeyhint: 'search', oninput: () => { this.query = this.input.value.trim(); this.render(); } });
    this.searchRow = h('div', { class: 'searchrow', style: 'display:none' }, this.input, h('button', { class: 'textbtn', onclick: () => this.toggleSearch(false) }, 'Cancel'));
    this.banner = h('div');
    this.grid = h('div', { class: 'grid' });
    this.empty = h('div', { class: 'empty', style: 'display:none' }, h('div', { class: 't-label' }, 'No documents'));
    this.scroll = h('div', { class: 'scroll', style: 'display:flex;flex-direction:column', onscroll: () => this.bar.classList.toggle('solid', this.scroll.scrollTop > 46) },
      h('div', { style: 'height:calc(44px + var(--safe-t));flex:none' }),
      h('div', { class: 'lhead' }, h('h1', { class: 't-display' }, 'Documents'), this.meta),
      this.searchRow, this.banner, this.grid, this.empty);
    this.fab = h('button', { class: 'fab', 'aria-label': 'Scan. Long-press to import' }, icon('capture', 28));
    longPress(this.fab, { onTap: () => { haptic(4); go('capture', {}); }, onLong: (e) => this.radial(e), ms: 380 });
    this.selbar = h('div', { class: 'selbar' },
      h('button', { class: 'btn', onclick: () => this.exportSel() }, icon('share', 20), 'Export'),
      h('button', { class: 'btn danger', onclick: () => this.deleteSel() }, icon('trash', 20), 'Delete'));
    this.fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => this.imported() });
    this.el = h('section', { class: 'screen library' }, this.bar, this.scroll, h('div', { class: 'fab-scrim' }), this.fab, this.selbar, this.fileInput);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.render(); });
  }

  onShow() { this.render(); }

  render() {
    const st = store.stats();
    this.meta.textContent = `${st.docs} ${st.docs === 1 ? 'DOC' : 'DOCS'} · ${st.pages} ${st.pages === 1 ? 'PAGE' : 'PAGES'} · ${fmtBytes(st.bytes)}`;
    this.renderBanner();
    let docs = store.listDocs();
    const q = fold(this.query);
    const snippets = new Map();
    if (q) {
      docs = docs.filter((d) => {
        if (fold(d.name).includes(q)) return true;
        const text = store.docText(d.id);
        const i = fold(text).indexOf(q);
        if (i < 0) return false;
        snippets.set(d.id, { text, i, n: this.query.length });
        return true;
      });
    }
    this.empty.style.display = docs.length ? 'none' : '';
    this.empty.firstChild.textContent = q ? 'No matches' : 'No documents';
    const keep = new Set();
    docs.forEach((d, idx) => {
      keep.add(d.id);
      let c = this.cards.get(d.id);
      if (!c) { c = this.card(d); this.cards.set(d.id, c); }
      this.fillCard(c, d, snippets.get(d.id));
      if (this.grid.children[idx] !== c.el) this.grid.insertBefore(c.el, this.grid.children[idx] || null);
    });
    for (const [id, c] of this.cards) if (!keep.has(id)) { c.el.remove(); this.cards.delete(id); }
    this.el.classList.toggle('selecting', this.selecting);
  }

  renderBanner() {
    clear(this.banner);
    const draft = store.latestDraft();
    if (!draft || this.selecting) return;
    const n = draft.pageIds.length;
    this.banner.append(h('div', { class: 'banner' },
      h('div', { class: 'grow' }, h('div', null, 'Unfinished scan'), h('div', { class: 't-label dim', style: 'margin-top:2px' }, pagesLabel(n))),
      h('button', { class: 'textbtn', onclick: () => go('capture', { docId: draft.id }) }, 'Resume'),
      h('button', { class: 'iconbtn', 'aria-label': 'Discard unfinished scan', onclick: () => this.discardDraft(draft) }, icon('close', 20))));
  }

  async discardDraft(d) {
    const undo = await store.trashDoc(d.id);
    let undone = false;
    toast(`Discarded ${pagesLabel(d.pageIds.length).toLowerCase()}`, {
      actions: [{ label: 'Undo', run: async () => { undone = true; await undo(); } }],
      onExpire: () => { if (!undone) store.finalizeDoc(d.id); },
    });
  }

  card(d) {
    const img = h('img', { alt: '', decoding: 'async', onload: () => img.classList.add('ready') });
    const c = {
      img,
      name: h('div', { class: 'name ellipsis' }),
      meta: h('div', { class: 'meta t-label' }),
      snip: h('div', { class: 'snippet' }),
      thumbPath: null,
    };
    c.el = h('button', { class: 'card', 'data-id': d.id },
      h('div', { class: 'thumb' }, img, h('div', { class: 'check' }, icon('check', 16))),
      c.name, c.meta, c.snip);
    longPress(c.el, {
      onTap: () => this.tapCard(d.id),
      onLong: () => { haptic(8); if (!this.selecting) this.setSelecting(true); this.toggleSel(d.id, true); },
    });
    return c;
  }

  async fillCard(c, d, snip) {
    const ps = store.pagesOf(d.id);
    c.name.textContent = d.name;
    const prog = store.ocrProgress(d.id);
    const tag = d.lastExport ? d.lastExport.format.toUpperCase() : prog.total && prog.done === prog.total ? 'OCR' : fmtDate(d.updated).slice(5).replace('-', '·');
    c.meta.textContent = `${pgs(ps.length)} · ${tag}`;
    c.el.classList.toggle('sel', this.sel.has(d.id));
    c.el.setAttribute('aria-label', `${d.name}, ${ps.length} pages`);
    if (snip) {
      const a = Math.max(0, snip.i - 28), b = Math.min(snip.text.length, snip.i + snip.n + 40);
      c.snip.replaceChildren(a > 0 ? '…' : '', snip.text.slice(a, snip.i).replace(/\s+/g, ' '), h('mark', null, snip.text.slice(snip.i, snip.i + snip.n)), snip.text.slice(snip.i + snip.n, b).replace(/\s+/g, ' '), b < snip.text.length ? '…' : '');
      c.snip.style.display = '';
    } else c.snip.style.display = 'none';
    const th = ps[0]?.thumb?.path;
    if (th && th !== c.thumbPath) {
      c.thumbPath = th;
      const blob = await blobs.getBlob(th);
      if (blob && c.thumbPath === th) c.img.src = blobUrl('card:' + d.id, blob);
    } else if (!th) { c.img.removeAttribute('src'); c.img.classList.remove('ready'); c.thumbPath = null; }
  }

  tapCard(id) {
    if (this.selecting) return this.toggleSel(id);
    go('document', id);
  }

  toggleSel(id, force) {
    const on = force ?? !this.sel.has(id);
    on ? this.sel.add(id) : this.sel.delete(id);
    if (this.selecting && !this.sel.size && force === undefined) { /* stay in select mode */ }
    this.titleSm.textContent = `${this.sel.size} selected`;
    this.render();
  }

  setSelecting(on) {
    this.selecting = on;
    this.sel.clear();
    this.titleSm.textContent = on ? '0 selected' : 'Documents';
    this.bar.classList.toggle('solid', on || this.scroll.scrollTop > 46);
    this.searchBtn.style.display = this.moreBtn.style.display = on ? 'none' : '';
    this.doneBtn.style.display = on ? '' : 'none';
    this.selbar.classList.toggle('show', on);
    this.fab.style.display = on ? 'none' : '';
    this.render();
  }

  toggleSearch(on) {
    this.searching = on;
    this.searchRow.style.display = on ? '' : 'none';
    if (on) { this.input.focus(); } else { this.input.value = ''; this.query = ''; this.input.blur(); this.render(); }
  }

  more() {
    menu({
      items: [
        { label: 'Select', icon: icon('select'), run: () => this.setSelecting(true) },
        { label: 'Import images', icon: icon('photos'), run: () => this.fileInput.click() },
        { label: 'Settings', icon: icon('settings'), run: () => go('settings') },
      ],
    });
  }

  radial(e) {
    haptic(8);
    const r = this.fab.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const opts = [
      { key: 'scan', label: 'Scan', icon: 'scan', a: 180 },
      { key: 'photos', label: 'Photos', icon: 'photos', a: 225 },
      { key: 'files', label: 'Files', icon: 'files', a: 270 },
    ];
    const R = 104;
    const els = opts.map((o) => {
      const x = cx + Math.cos((o.a * Math.PI) / 180) * R - 28, y = cy + Math.sin((o.a * Math.PI) / 180) * R - 28;
      const b = h('button', { class: 'opt', style: { left: `${cx - 28}px`, top: `${cy - 28}px` }, 'aria-label': o.label }, icon(o.icon), h('span', { class: 't-label' }, o.label));
      b._to = [x - (cx - 28), y - (cy - 28)];
      b._key = o.key;
      return b;
    });
    const veil = h('div', { class: 'veil' });
    const wrap = h('div', { class: 'radial' }, veil, els);
    this.el.append(wrap);
    requestAnimationFrame(() => { wrap.classList.add('open'); for (const b of els) b.style.transform = `translate(${b._to[0]}px, ${b._to[1]}px) scale(1)`; });
    let hot = null;
    const pick = (key) => {
      close();
      if (key === 'scan') go('capture', {});
      else if (key) { this.fileInput.accept = key === 'files' ? 'image/*,.heic,.heif' : 'image/*'; this.fileInput.click(); }
    };
    const close = () => {
      wrap.classList.remove('open');
      for (const b of els) b.style.transform = '';
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      setTimeout(() => wrap.remove(), 200);
    };
    const hit = (x, y) => els.find((b) => { const q = b.getBoundingClientRect(); return x >= q.left - 8 && x <= q.right + 8 && y >= q.top - 8 && y <= q.bottom + 8; });
    const mv = (ev) => { const b = hit(ev.clientX, ev.clientY); if (b !== hot) { hot && hot.classList.remove('hot'); hot = b; if (b) { b.classList.add('hot'); haptic(4); } } };
    let armed = false;
    const up = (ev) => {
      const b = hit(ev.clientX, ev.clientY);
      if (b) return pick(b._key);
      if (!armed) { armed = true; return; } // first release after long-press keeps the menu open
    };
    addEventListener('pointermove', mv);
    addEventListener('pointerup', up);
    veil.addEventListener('click', () => close());
    for (const b of els) b.addEventListener('click', () => pick(b._key));
  }

  async imported() {
    const files = Array.from(this.fileInput.files || []);
    this.fileInput.value = '';
    if (!files.length) return;
    const d = await store.createDoc({ status: 'draft' });
    const t = toast(`Importing ${files.length} ${files.length === 1 ? 'image' : 'images'}…`, { duration: 60000 });
    const added = await importFiles(d.id, files, { filter: settings.get('filter') });
    t.dismiss(false);
    if (!added.length) { await store.finalizeDoc(d.id, true); toast('Nothing imported'); return; }
    go('review', d.id, { fromCapture: false, fromImport: true });
  }

  exportSel() {
    const ids = [...this.sel];
    if (!ids.length) return;
    const ordered = store.listDocs().filter((d) => ids.includes(d.id)).reverse();
    go('export', { docs: ordered });
  }

  async deleteSel() {
    const ids = [...this.sel];
    if (!ids.length) return;
    const undos = [];
    for (const id of ids) undos.push(await store.trashDoc(id));
    this.setSelecting(false);
    let undone = false;
    toast(`Deleted ${ids.length} ${ids.length === 1 ? 'document' : 'documents'}`, {
      actions: [{ label: 'Undo', run: async () => { undone = true; for (const u of undos) await u(); } }],
      onExpire: () => { if (!undone) for (const id of ids) store.finalizeDoc(id); },
    });
  }

  destroy() { this.offs.forEach((f) => f()); }
}
