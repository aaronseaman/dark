// Formatting helpers. Numbers are always rendered in mono, so keep them compact and stable.

export function fmtBytes(n) {
  if (!n || n < 0) return '0 KB';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function pad2(n) { return String(n).padStart(2, '0'); }

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  return `${fmtDate(ts)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function defaultName(ts = Date.now()) {
  const d = new Date(ts);
  return `Scan ${fmtDate(ts)} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function pgs(n) { return `${n} ${n === 1 ? 'PG' : 'PGS'}`; }
export function pages(n) { return `${n} ${n === 1 ? 'PAGE' : 'PAGES'}`; }

export function safeFilename(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (s || 'Scan').slice(0, 120);
}

// "1-3, 5, 8-" -> [0,1,2,4,7,...] (zero-based, clamped, de-duplicated, ordered as typed)
export function parseRange(str, count) {
  const out = [];
  const seen = new Set();
  for (const part of String(str || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d*)\s*[-–]\s*(\d*)$/);
    let a, b;
    if (m) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : count; }
    else if (/^\d+$/.test(part)) { a = b = +part; }
    else continue;
    if (a > b) [a, b] = [b, a];
    for (let i = Math.max(1, a); i <= Math.min(count, b); i++) {
      if (!seen.has(i)) { seen.add(i); out.push(i - 1); }
    }
  }
  return out;
}

export function uid() {
  const b = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
}
