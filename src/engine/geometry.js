// Quad + homography math shared by detection, rendering and the crop editor.

// Order 4 points as TL, TR, BR, BL (image coordinates, y down).
export function orderQuad(pts) {
  const cx = (pts[0][0] + pts[1][0] + pts[2][0] + pts[3][0]) / 4;
  const cy = (pts[0][1] + pts[1][1] + pts[2][1] + pts[3][1]) / 4;
  const s = pts.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  // atan2 order with y down is clockwise on screen. Start at the point with min x+y.
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [s[k], s[(k + 1) % 4], s[(k + 2) % 4], s[(k + 3) % 4]].map((p) => [p[0], p[1]]);
}

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function polyArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i], r = q[(i + 1) % q.length];
    a += p[0] * r[1] - r[0] * p[1];
  }
  return Math.abs(a) / 2;
}

export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const z = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    const s = Math.sign(z);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

// Interior angles in degrees.
export function angles(q) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = q[(i + 3) % 4], c = q[i], n = q[(i + 1) % 4];
    const ax = p[0] - c[0], ay = p[1] - c[1], bx = n[0] - c[0], by = n[1] - c[1];
    const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    out.push((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return out;
}

// Estimated rectified size of a perspective quad (in source pixels).
// Starts from the visible side lengths, then recovers the true aspect ratio with
// Zhang & He's whiteboard method (focal length estimated from the quad itself,
// principal point assumed at the image centre). Falls back when unstable.
export function quadSize(q, imgW, imgH) {
  const [tl, tr, br, bl] = q;
  const vw = Math.max(dist(tl, tr), dist(bl, br));
  const vh = Math.max(dist(tl, bl), dist(tr, br));
  const simple = { w: Math.max(1, vw), h: Math.max(1, vh) };
  if (!imgW || !imgH) return simple;
  const ar = trueAspect(tl, tr, bl, br, imgW / 2, imgH / 2);
  if (!ar || !isFinite(ar)) return simple;
  const vis = vw / vh;
  if (ar < 0.15 || ar > 7 || ar / vis > 1.8 || vis / ar > 1.8) return simple;
  return ar < vis ? { w: vw, h: vw / ar } : { w: vh * ar, h: vh };
}

function trueAspect(p1, p2, p3, p4, u0, v0) {
  const m1 = [p1[0], p1[1], 1], m2 = [p2[0], p2[1], 1], m3 = [p3[0], p3[1], 1], m4 = [p4[0], p4[1], 1];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
  if (!d2 || !d3) return null;
  const k2 = dot(cross(m1, m4), m3) / d2;
  const k3 = dot(cross(m1, m4), m2) / d3;
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]];
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]];
  const [n21, n22, n23] = n2, [n31, n32, n33] = n3;
  // Focal length from the quad; degenerate when a pair of sides stays parallel (pure tilt),
  // and noisy when nearly so. Then fall back to a phone main-camera prior (~0.75 x long edge).
  const L = 2 * Math.max(u0, v0);
  let f = NaN;
  if (Math.abs(n23) > 1e-9 && Math.abs(n33) > 1e-9) {
    f = Math.sqrt(Math.abs((1 / (n23 * n33)) * ((n21 * n31 - (n21 * n33 + n23 * n31) * u0 + n23 * n33 * u0 * u0) + (n22 * n32 - (n22 * n33 + n23 * n32) * v0 + n23 * n33 * v0 * v0))));
  }
  if (!isFinite(f) || f < 0.45 * L || f > 3 * L) f = 0.75 * L;
  // n^T (A^-T A^-1) n with A = [[f,0,u0],[0,f,v0],[0,0,1]]
  const q = (n) => {
    const x = (n[0] - u0 * n[2]) / f, y = (n[1] - v0 * n[2]) / f, z = n[2];
    return x * x + y * y + z * z;
  };
  return Math.sqrt(q(n2) / q(n3));
}

// Solve H such that H * [x y 1]^T ~ [u v 1]^T for 4 correspondences.
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let k = c; k <= n; k++) M[c][k] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row) => row[n]);
}

export function applyH(H, x, y) {
  const z = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
}

// Rotate the corner assignment so the output is rotated clockwise by `rot` degrees.
export function rotateQuad(q, rot) {
  const k = ((((rot / 90) | 0) % 4) + 4) % 4;
  const out = q.slice();
  for (let i = 0; i < k; i++) out.unshift(out.pop());
  return out;
}

export function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }

export function scaleQuad(q, sx, sy = sx) { return q.map(([x, y]) => [x * sx, y * sy]); }

// Standard paper ratios (long/short) for aspect lock.
const PAPER = [Math.SQRT2, 11 / 8.5, 14 / 8.5, 3.5 / 2];
export function snapAspect(w, h) {
  const long = Math.max(w, h), short = Math.min(w, h);
  const r = long / short;
  let best = null, bd = Infinity;
  for (const p of PAPER) { const d = Math.abs(r - p) / p; if (d < bd) { bd = d; best = p; } }
  if (bd > 0.14) return { w, h };
  const area = w * h;
  const s = Math.sqrt(area / best);
  return w >= h ? { w: s * best, h: s } : { w: s, h: s * best };
}
