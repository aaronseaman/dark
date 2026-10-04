// SETTINGS: appearance, capture defaults, on-device text recognition, storage, privacy.

import { h, clear } from '../core/dom.js';
import { icon } from '../core/icons.js';
import * as settings from '../core/settings.js';
import * as store from '../core/store.js';
import * as ocr from '../engine/ocr.js';
import { setHaptics, haptic } from '../core/haptics.js';
import { fmtBytes } from '../core/format.js';
import { FILTER_KEYS } from '../engine/gl.js';
import { LANGS, langInstalled, installLang, engineInstalled, installEngine, engineBytes } from '../engine/install.js';
import { BUILD } from '../engine-manifest.js';
import * as router from '../ui/router.js';
import { confirm } from '../ui/sheet.js';
import { toast } from '../ui/toast.js';

const FILTER_LABEL = { original: 'Original', enhance: 'Enhance', bw: 'B&W', gray: 'Gray', ink: 'Ink' };

export class Settings {
  constructor() {
    this.body = h('div');
    this.bar = h('div', { class: 'topbar float' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back', onclick: () => router.back() }, icon('back')),
      h('div', { class: 'title-sm' }, 'Settings'));
    this.scroll = h('div', { class: 'scroll', onscroll: () => this.bar.classList.toggle('solid', this.scroll.scrollTop > 40) },
      h('div', { style: 'height:calc(44px + var(--safe-t))' }),
      h('div', { class: 'lhead' }, h('h1', { class: 't-display' }, 'Settings')),
      this.body);
    this.el = h('section', { class: 'screen settings' }, this.bar, this.scroll);
    this.render();
  }

  sw(key, after) {
    const b = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(!!settings.get(key)), onclick: async () => {
      const v = !settings.get(key);
      await settings.set(key, v);
      b.setAttribute('aria-checked', String(v));
      haptic(4);
      after && after(v);
    } });
    return b;
  }

  seg(key, opts) {
    const wrap = h('div', { class: 'seg', role: 'radiogroup' });
    const paint = () => [...wrap.children].forEach((b) => { const on = b.dataset.k === settings.get(key); b.classList.toggle('sel', on); b.setAttribute('aria-checked', on); });
    for (const [k, label] of opts) wrap.append(h('button', { role: 'radio', 'data-k': k, onclick: async () => { await settings.set(key, k); paint(); haptic(4); } }, label));
    paint();
    return wrap;
  }

  row(k, sub, v) {
    return h('div', { class: 'row' }, h('div', { class: 'k' }, h('div', null, k), sub ? h('div', { class: 'sub t-label' }, sub) : null), v);
  }

  group(label, ...rows) { return h('div', { class: 'group' }, h('span', { class: 't-label' }, label), h('div', { class: 'box' }, ...rows)); }

  async render() {
    clear(this.body);
    const st = store.stats();
    let est = null;
    try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { /* no */ }
    let persisted = false;
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch { /* no */ }
    const engineOk = await engineInstalled();

    const filterChips = h('div', { class: 'langs' }, FILTER_KEYS.map((k) => {
      const b = h('button', { class: 'chip' + (settings.get('filter') === k ? ' sel' : ''), onclick: async () => { await settings.set('filter', k); this.render(); } }, FILTER_LABEL[k]);
      return b;
    }));

    const engineRow = engineOk
      ? this.row('Engine', 'Installed · works offline', h('span', { class: 't-mono dim' }, fmtBytes(engineBytes())))
      : this.row('Engine', 'Not installed', h('button', { class: 'chip', onclick: (e) => this.install(e.currentTarget) }, `Install ${fmtBytes(engineBytes())}`));

    const langWrap = h('div', { class: 'langs' });
    for (const [code, name] of LANGS) {
      const on = settings.get('ocrLangs').includes(code);
      const b = h('button', { class: 'chip' + (on ? ' sel' : ''), 'aria-pressed': on, onclick: () => this.toggleLang(code, b) }, name);
      langWrap.append(b);
    }

    this.body.append(
      this.group('Appearance', this.row('Theme', 'Dark is the default; Black for OLED', this.seg('theme', [['dark', 'Dark'], ['black', 'Black'], ['light', 'Light']]))),
      this.group('Capture',
        this.row('Auto-capture', 'Fires when the page holds still', this.sw('auto')),
        this.row('Lock to paper size', 'Snap output to A4 / Letter', this.sw('aspectLock')),
        this.row('Haptics', null, this.sw('haptics', (v) => setHaptics(v))),
        h('div', { class: 'row', style: 'display:block' }, h('div', null, 'Default filter'), filterChips)),
      this.group('Text recognition',
        this.row('Recognize text', 'On device. Powers search and searchable PDFs', this.sw('ocr', (v) => { ocr.setReady(v && engineOk); if (v) ocr.enqueueMissing(); })),
        engineRow,
        h('div', { class: 'row', style: 'display:block' }, h('div', null, 'Languages'), h('div', { class: 'sub t-label' }, 'Extra languages download once, on demand'), langWrap)),
      this.group('Storage',
        this.row('Documents', null, h('span', { class: 't-mono dim' }, `${st.docs} · ${st.pages} PG · ${fmtBytes(st.bytes)}`)),
        est ? this.row('On this device', persisted ? 'Persistent storage granted' : 'May be cleared if space runs low', h('span', { class: 't-mono dim' }, `${fmtBytes(est.usage || 0)}`)) : null,
        h('div', { class: 'row' }, h('button', { class: 'textbtn', style: 'color:var(--danger);padding:0;height:auto', onclick: () => this.wipe() }, 'Delete all documents'))),
      h('div', { class: 'group' }, h('span', { class: 't-label' }, 'Privacy'), h('div', { class: 'box privacy' }, 'Everything stays on this device. There is no server.')),
      h('div', { class: 'group t-label faint', style: 'text-align:center;padding-bottom:calc(24px + var(--safe-b))' }, `dark · build ${BUILD}`),
    );
  }

  async install(btn) {
    btn.disabled = true;
    try {
      await installEngine((d, t) => { btn.textContent = `${Math.floor((d / t) * 100)}%`; });
      await settings.set('engine', true);
      ocr.setReady(settings.get('ocr'));
      ocr.enqueueMissing();
      haptic(12);
      this.render();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      toast('Download failed — check your connection');
    }
  }

  async toggleLang(code, b) {
    const list = settings.get('ocrLangs').slice();
    const on = list.includes(code);
    if (on) {
      if (list.length === 1) { toast('Keep at least one language'); return; }
      list.splice(list.indexOf(code), 1);
    } else {
      if (!(await langInstalled(code))) {
        b.disabled = true;
        const label = b.textContent;
        try {
          await installLang(code, (d, t) => { b.textContent = t ? `${Math.floor((d / t) * 100)}%` : fmtBytes(d); });
        } catch {
          b.disabled = false; b.textContent = label;
          toast('Language download failed');
          return;
        }
        b.disabled = false; b.textContent = label;
      }
      list.push(code);
    }
    await settings.set('ocrLangs', list);
    ocr.setLangs(list);
    b.classList.toggle('sel', !on);
    b.setAttribute('aria-pressed', !on);
    haptic(4);
  }

  async wipe() {
    const ok = await confirm({ title: 'Delete all documents?', sub: 'This cannot be undone', ok: 'Delete everything', danger: true });
    if (!ok) return;
    await store.wipeAll();
    toast('All documents deleted');
    this.render();
  }
}
