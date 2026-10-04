// First run: a single honest screen while the offline engine downloads.

import { h, clear } from '../core/dom.js';
import { fmtBytes } from '../core/format.js';
import * as settings from '../core/settings.js';
import * as ocr from '../engine/ocr.js';
import { installEngine, engineBytes } from '../engine/install.js';

export class FirstRun {
  constructor(onDone) {
    this.onDone = onDone;
    this.noSwipe = true;
    this.bar = h('i');
    this.pct = h('div', { class: 'pct t-mono' }, '0%');
    this.bytes = h('div', { class: 'bytes t-label' });
    this.note = h('div', { class: 'note t-body' }, 'Download once. Then it works in airplane mode, forever.');
    this.act = h('div', { class: 'act' });
    this.skip = h('button', { class: 'textbtn', style: 'color:var(--text-faint);margin-left:-12px', onclick: () => this.finish() }, 'Skip for now');
    this.el = h('section', { class: 'screen firstrun' },
      h('div', { class: 't-title' }, 'Preparing offline engine'),
      h('div', { class: 'bar' }, h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.bar), this.pct),
      this.bytes, this.note, this.act);
    this.total = engineBytes();
    this.paint(0, this.total);
    setTimeout(() => { if (!this.finished) this.act.append(this.skip); }, 2500);
    this.run();
  }

  paint(d, t) {
    const p = t ? Math.min(100, Math.floor((d / t) * 100)) : 0;
    this.bar.style.width = `${p}%`;
    this.bar.parentElement.setAttribute('aria-valuenow', p);
    this.pct.textContent = `${p}%`;
    this.bytes.textContent = `${fmtBytes(d)} of ${fmtBytes(t)}`;
  }

  async run() {
    try {
      await installEngine((d, t) => this.paint(d, t));
      await settings.set('engine', true);
      ocr.setReady(true);
      this.paint(this.total, this.total);
      setTimeout(() => this.finish(), 350);
    } catch (e) {
      console.warn('engine download', e);
      this.note.textContent = navigator.onLine === false ? 'You’re offline. Scanning works now; text recognition installs next time you’re online.' : 'Download interrupted. Scanning works now; text recognition will retry.';
      clear(this.act).append(
        h('button', { class: 'btn primary', onclick: () => { clear(this.act); this.note.textContent = 'Download once. Then it works in airplane mode, forever.'; this.run(); } }, 'Retry'),
        h('button', { class: 'btn', onclick: () => this.finish() }, 'Continue'));
    }
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.onDone && this.onDone();
  }
}
