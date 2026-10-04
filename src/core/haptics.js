// Haptics. Android: navigator.vibrate. iOS Safari 18+: toggling a native
// <input type=checkbox switch> fires the system selection haptic, which is the
// only haptic a web app can reach on iPhone. It is subtle by design.

function iosSwitch() {
  const label = document.createElement('label');
  label.ariaHidden = 'true';
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.append(input);
  document.head.append(label);
  label.click();
  label.remove();
}

let enabled = true;
export function setHaptics(on) { enabled = on; }

export function haptic(ms = 8) {
  if (!enabled) return;
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(ms);
    else iosSwitch();
  } catch { /* never throw from feedback */ }
}
