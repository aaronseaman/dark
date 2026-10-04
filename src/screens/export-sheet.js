// EXPORT sheet (~62% height). Format chips, quality, text layer, password, range, name.
// Size estimate updates live. Format is remembered per document, never per app.

import { h } from '../core/dom.js';
import * as store from '../core/store.js';
import * as ocr from '../engine/ocr.js';
import { haptic } from '../core/haptics.js';
import { fmtBytes, pages as pagesLabel, parseRange } from '../core/format.js';
import { FORMATS, QUALITIES, estimate, build, save, saveLabel, saveMode, awaitOCR } from '../export/index.js';
import { sheet } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';

export function openExport({ docs, pageIndex } = {}) {
  docs = (docs || []).filter(Boolean);
  if (!docs.length) return;
  const allPages = docs.flatMap((d) => store.pagesOf(d.id));
  if (!allPages.length) { toast('No pages to export'); return; }
  const first = docs[0];
  const last = first.lastExport || {};
  const st = {
    format: last.format || 'pdf',
    quality: last.quality || 'std',
    searchable: last.searchable ?? true,
    password: '',
    range: pageIndex != null ? 'range' : 'all',
    rangeText: pageIndex != null ? String(pageIndex + 1) : '',
    name: suggestName(docs),
  };

  const sel = () => {
    if (st.range === 'all') return allPages;
    const idx = parseRange(st.rangeText, allPages.length);
    return idx.map((i) => allPages[i]);
  };

  // --- controls
  const fmtBtns = FORMATS.map((f) => h('button', { class: 'chip', role: 'radio', onclick: () => { st.format = f.key; haptic(4); paint(); } }, f.label));
  const qBtns = QUALITIES.map((q) => h('button', { role: 'radio', onclick: () => { st.quality = q.key; paint(); } }, q.label));
  const sw = h('button', { class: 'switch', role: 'switch', 'aria-label': 'Searchable', onclick: () => { st.searchable = !st.searchable; paint(); } });
  const swLabel = h('span', { class: 't-mono' });
  const pw = h('input', { class: 'field', type: 'password', placeholder: 'Optional', autocomplete: 'new-password', 'aria-label': 'Password', style: 'width:180px;height:40px', oninput: () => { st.password = pw.value; } });
  const rangeBtns = [
    h('button', { role: 'radio', onclick: () => { st.range = 'all'; paint(); } }, 'All'),
    h('button', { role: 'radio', onclick: () => { st.range = 'range'; paint(); setTimeout(() => rangeIn.focus(), 30); } }, 'Range'),
  ];
  const rangeIn = h('input', { class: 'field', value: st.rangeText, placeholder: `1-${allPages.length}`, inputmode: 'text', 'aria-label': 'Page range', style: 'width:120px;height:40px', oninput: () => { st.rangeText = rangeIn.value; paint(); } });
  let nameEdited = false;
  const nameIn = h('input', { class: 'field', value: st.name, 'aria-label': 'File name', autocapitalize: 'sentences', enterkeyhint: 'done', oninput: () => { st.name = nameIn.value; nameEdited = true; } });
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameIn.blur(); });

  const row = (k, ...v) => h('div', { class: 'srow' }, h('span', { class: 't-label k' }, k), h('div', { class: 'v' }, ...v));
  const rowSearch = row('Searchable', sw, swLabel);
  const rowQuality = row('Quality', h('div', { class: 'seg' }, qBtns));
  const rowPw = row('Password', pw);
  const rowPages = row('Pages', h('div', { class: 'seg' }, rangeBtns), rangeIn);

  const body = h('div', null,
    h('div', { class: 'sgroup', style: 'margin-top:4px' }, h('span', { class: 't-label' }, 'Format'), h('div', { class: 'formats', role: 'radiogroup' }, fmtBtns)),
    h('div', { class: 'sgroup' }, rowQuality, rowSearch, rowPw, rowPages),
    h('div', { class: 'sgroup' }, h('span', { class: 't-label' }, 'Name'), nameIn));

  const btn = h('button', { class: 'btn primary block', onclick: () => go() }, saveLabel());
  // Smart name arrives with OCR of page 1; adopt it unless the user typed their own.
  const offOcr = store.on('ocr', () => {
    if (nameEdited) return;
    const n = suggestName(docs);
    if (n !== st.name) { st.name = n; nameIn.value = n; }
    paint();
  });
  const s = sheet({ title: 'Export', sub: '', body, foot: btn, label: 'Export', onClose: () => offOcr() });

  function paint() {
    fmtBtns.forEach((b, i) => { const on = FORMATS[i].key === st.format; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
    qBtns.forEach((b, i) => { const on = QUALITIES[i].key === st.quality; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
    rangeBtns.forEach((b, i) => { const on = (i === 0) === (st.range === 'all'); b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
    sw.setAttribute('aria-checked', String(st.searchable));
    swLabel.textContent = st.format === 'docx' ? 'editable text' : 'text layer';
    rowSearch.style.display = st.format === 'pdf' || st.format === 'docx' ? '' : 'none';
    rowQuality.style.display = st.format === 'txt' ? 'none' : '';
    rowPw.style.display = st.format === 'pdf' ? '' : 'none';
    rangeIn.style.display = st.range === 'range' ? '' : 'none';
    const ps = sel();
    s.setSub(`${pagesLabel(ps.length)} · ${fmtBytes(estimate(ps, st))} EST.`);
    if (!busy) { btn.disabled = !ps.length; btn.textContent = ready ? 'Tap to save' : saveLabel(); }
  }

  let busy = false, ready = null;
  async function go() {
    if (busy) return;
    if (ready) { const files = ready; ready = null; return finish(files, await save(files)); }
    const ps = sel();
    if (!ps.length) return;
    busy = true;
    btn.disabled = true;
    try {
      const needText = st.format === 'txt' || (st.searchable && st.format !== 'img');
      if (needText && ps.some((p) => !store.ocrFor(p.id))) {
        if (!ocr.isReady()) {
          if (st.format === 'txt') { toast('Text engine not installed — see Settings'); return; }
        } else {
          await awaitOCR(ps, (d, n) => { btn.textContent = `Reading text ${d}/${n}`; });
        }
      }
      btn.textContent = 'Preparing…';
      const files = await build(ps, st, (d, n) => { if (n > 3) btn.textContent = `Preparing ${d}/${n}`; });
      const r = await save(files);
      if (r === 'needs-tap') { ready = files; busy = false; paint(); btn.disabled = false; return; }
      finish(files, r);
    } catch (e) {
      console.error(e);
      toast(`Export failed: ${e.message || e}`);
    } finally {
      busy = false;
      if (!ready) { btn.disabled = false; paint(); }
    }
  }

  function finish(files, r) {
    if (r !== 'saved') return;
    haptic(12);
    for (const d of docs) store.updateDoc(d.id, { lastExport: { format: st.format, quality: st.quality, searchable: st.searchable, at: Date.now() } }, { touch: false });
    s.close('saved');
    const f = files[0];
    const actions = [];
    if (saveMode() !== 'share' && navigator.canShare && navigator.canShare({ files })) actions.push({ label: 'Share', run: () => save(files, { mode: 'share' }) });
    else if (saveMode() === 'share') actions.push({ label: 'Share', run: () => save(files, { mode: 'share' }) });
    if (files.length === 1 && f.type !== 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      actions.push({ label: 'Open', run: () => { const u = URL.createObjectURL(f); window.open(u, '_blank'); setTimeout(() => URL.revokeObjectURL(u), 120000); } });
    }
    toast(files.length > 1 ? `Saved ${files.length} files` : `Saved ${f.name}`, { actions, duration: 5000 });
  }

  paint();
  return s;
}

function suggestName(docs) {
  const d = docs[0];
  let name = d.named ? d.name : ocr.smartTitle(d.id) || d.name;
  if (docs.length > 1) name += ` + ${docs.length - 1} more`;
  return name;
}
