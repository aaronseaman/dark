// Screen stack with history integration and an interactive edge-swipe back gesture
// (standalone iOS web apps have no system back gesture, so we provide one).

import { onAnimEnd, reducedMotion } from '../core/dom.js';

const stack = [];
let app = null;
let swiping = false;
let suppressAnim = false;
let ignorePop = 0;

export function init(root) {
  app = root;
  history.replaceState({ d: 0 }, '');
  addEventListener('popstate', onPop);
  edgeSwipe();
}

export const top = () => stack[stack.length - 1];
export const depth = () => stack.length;
export const rootScreen = () => stack[0];
export const find = (pred) => stack.find(pred);
let afterPop = null;

function show(screen) {
  document.body.classList.toggle('has-fab', !!screen.hasFab);
  document.body.style.setProperty('--toast-lift', screen.toastLift || (screen.hasFab ? '88px' : '0px'));
  screen.el.inert = false;
  screen.el.removeAttribute('aria-hidden');
  screen.onShow && screen.onShow();
}

function hide(screen) {
  screen.el.inert = true;
  screen.el.setAttribute('aria-hidden', 'true');
  screen.onHide && screen.onHide();
}

export function setRoot(screen) {
  while (stack.length) { const s = stack.pop(); s.el.remove(); s.destroy && s.destroy(); }
  app.append(screen.el);
  stack.push(screen);
  show(screen);
}

export function push(screen, { modal = false } = {}) {
  const prev = top();
  screen.modal = modal;
  app.append(screen.el);
  stack.push(screen);
  history.pushState({ d: stack.length - 1 }, '');
  if (prev) hide(prev);
  screen.el.classList.add(modal ? 'enter-modal' : 'enter-push');
  if (prev && !modal) prev.el.classList.add('under-out');
  onAnimEnd(screen.el, () => {
    screen.el.classList.remove('enter-modal', 'enter-push');
    if (prev && !modal) { prev.el.classList.remove('under-out'); prev.el.style.visibility = 'hidden'; }
  });
  show(screen);
}

// Swap the top screen without touching history.
export function replace(screen, { modal } = {}) {
  const old = stack.pop();
  screen.modal = modal ?? old?.modal ?? false;
  app.append(screen.el);
  stack.push(screen);
  screen.el.classList.add('enter-modal');
  onAnimEnd(screen.el, () => screen.el.classList.remove('enter-modal'));
  if (old) {
    hide(old);
    old.el.style.zIndex = '0';
    setTimeout(() => { old.el.remove(); old.destroy && old.destroy(); }, 320);
  }
  show(screen);
}

export async function back() {
  const t = top();
  if (stack.length < 2) return;
  if (t.beforeLeave && !(await t.beforeLeave())) return;
  t._leaveOk = true;
  history.back();
}

// Pop several screens at once (e.g. Review "Done" back to a document), then run `then`.
export function popTo(screen, then) {
  const i = stack.indexOf(screen);
  if (i < 0) return;
  if (i === stack.length - 1) { then && then(); return; }
  for (let k = i + 1; k < stack.length; k++) stack[k]._leaveOk = true;
  afterPop = then ? { depth: i, fn: then } : null;
  history.go(-(stack.length - 1 - i));
}

async function onPop(e) {
  if (ignorePop) { ignorePop--; return; }
  const d = e.state && typeof e.state.d === 'number' ? e.state.d : 0;
  while (stack.length - 1 > d && stack.length > 1) {
    const t = top();
    if (!t._leaveOk && t.beforeLeave && !(await t.beforeLeave())) {
      ignorePop = 0;
      history.pushState({ d: stack.length - 1 }, '');
      return;
    }
    popOne(stack.length - 1 === d + 1);
  }
  if (afterPop && stack.length - 1 === afterPop.depth) { const f = afterPop.fn; afterPop = null; f(); }
}

function popOne(animate) {
  const t = stack.pop();
  const prev = top();
  hide(t);
  if (prev) {
    prev.el.style.visibility = '';
    if (animate && !suppressAnim && !t.modal) prev.el.classList.add('under-in');
    onAnimEnd(prev.el, () => prev.el.classList.remove('under-in'));
  }
  const done = () => { t.el.remove(); t.destroy && t.destroy(); };
  if (animate && !suppressAnim) {
    t.el.classList.add(t.modal ? 'leave-modal' : 'leave-push');
    onAnimEnd(t.el, done);
  } else done();
  suppressAnim = false;
  if (prev) show(prev);
}

function edgeSwipe() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!standalone) return; // Safari's own swipe-back handles the browser case
  let sx = 0, sy = 0, cur = null, prev = null, w = 0, lastX = 0, lastT = 0, v = 0, active = false;
  addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || stack.length < 2) return;
    const t = top();
    if (t.modal || t.noSwipe) return;
    const x = e.touches[0].clientX;
    if (x > 22) return;
    sx = x; sy = e.touches[0].clientY; cur = t; prev = stack[stack.length - 2]; w = innerWidth;
    active = true; swiping = false; lastX = x; lastT = e.timeStamp; v = 0;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (!active) return;
    const x = e.touches[0].clientX, y = e.touches[0].clientY;
    if (!swiping) {
      if (Math.abs(y - sy) > 12 && Math.abs(y - sy) > Math.abs(x - sx)) { active = false; return; }
      if (x - sx < 8) return;
      swiping = true;
      prev.el.style.visibility = '';
      prev.el.style.transition = cur.el.style.transition = 'none';
    }
    e.preventDefault();
    const dx = Math.max(0, x - sx);
    cur.el.style.transform = `translateX(${dx}px)`;
    prev.el.style.transform = `translateX(${-28 + (dx / w) * 28}%)`;
    v = (x - lastX) / Math.max(1, e.timeStamp - lastT);
    lastX = x; lastT = e.timeStamp;
  }, { passive: false });
  const end = async () => {
    if (!active) return;
    active = false;
    if (!swiping) return;
    swiping = false;
    const dx = lastX - sx;
    const commit = dx > w * 0.35 || v > 0.5;
    const ease = reducedMotion() ? '0ms' : '220ms';
    cur.el.style.transition = prev.el.style.transition = `transform ${ease} cubic-bezier(0.2,0,0,1)`;
    if (commit && (!cur.beforeLeave || (await cur.beforeLeave()))) {
      cur.el.style.transform = 'translateX(100%)';
      prev.el.style.transform = 'translateX(0)';
      const c = cur, p = prev;
      setTimeout(() => {
        p.el.style.transition = p.el.style.transform = '';
        c._leaveOk = true;
        suppressAnim = true;
        history.back();
      }, reducedMotion() ? 0 : 220);
    } else {
      cur.el.style.transform = '';
      prev.el.style.transform = 'translateX(-28%)';
      const p = prev, c = cur;
      setTimeout(() => { p.el.style.transition = p.el.style.transform = ''; c.el.style.transition = ''; if (top() === c) p.el.style.visibility = 'hidden'; }, 240);
    }
  };
  addEventListener('touchend', end);
  addEventListener('touchcancel', end);
}
