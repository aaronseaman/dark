// Page detection on a small grayscale frame (~480px long edge).
// Pipeline: 5x5 Gaussian -> Sobel -> non-max suppression -> adaptive hysteresis (Canny)
// -> connected components -> convex hull -> max-area inscribed quad -> sub-pixel side
// refit -> scoring by edge support. A second candidate source thresholds brightness
// (paper is usually the brightest large thing in frame). Allocation-free after warm-up.

import { orderQuad, polyArea, angles, isConvex } from './geometry.js';

let W = 0, H = 0;
let blur, tmp, mag, dir, nms, edges, dil, labels, stack, mask, mask2;
const MAXC = 65536;
const cCount = new Int32Array(MAXC), cMinX = new Int32Array(MAXC), cMaxX = new Int32Array(MAXC), cMinY = new Int32Array(MAXC), cMaxY = new Int32Array(MAXC);
let rowMin, rowMax;

function alloc(w, h) {
  if (w === W && h === H) return;
  W = w; H = h;
  const n = w * h;
  blur = new Float32Array(n); tmp = new Float32Array(n); mag = new Float32Array(n);
  dir = new Uint8Array(n); nms = new Float32Array(n); edges = new Uint8Array(n); dil = new Uint8Array(n);
  labels = new Int32Array(n); stack = new Int32Array(n * 2); mask = new Uint8Array(n); mask2 = new Uint8Array(n);
  rowMin = new Int32Array(h); rowMax = new Int32Array(h);
}

export function rgbaToGray(rgba, w, h, out) {
  const n = w * h;
  const g = out && out.length === n ? out : new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

function gaussian(src, w, h) {
  // [1 4 6 4 1] / 16, separable, clamped borders
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = x > 1 ? x - 2 : 0, x1 = x > 0 ? x - 1 : 0, x3 = x < w - 1 ? x + 1 : w - 1, x4 = x < w - 2 ? x + 2 : w - 1;
      tmp[r + x] = (src[r + x0] + 4 * src[r + x1] + 6 * src[r + x] + 4 * src[r + x3] + src[r + x4]) * 0.0625;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = (y > 1 ? y - 2 : 0) * w, y1 = (y > 0 ? y - 1 : 0) * w, y2 = y * w, y3 = (y < h - 1 ? y + 1 : h - 1) * w, y4 = (y < h - 2 ? y + 2 : h - 1) * w;
    for (let x = 0; x < w; x++) blur[y2 + x] = (tmp[y0 + x] + 4 * tmp[y1 + x] + 6 * tmp[y2 + x] + 4 * tmp[y3 + x] + tmp[y4 + x]) * 0.0625;
  }
}

function sobel(w, h) {
  mag.fill(0);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = blur[i - w - 1], b = blur[i - w], c = blur[i - w + 1];
      const d = blur[i - 1], f = blur[i + 1];
      const g = blur[i + w - 1], hh = blur[i + w], k = blur[i + w + 1];
      const gx = c + 2 * f + k - a - 2 * d - g;
      const gy = g + 2 * hh + k - a - 2 * b - c;
            // Quantize gradient direction to 0:E-W, 1:NE-SW, 2:N-S, 3:NW-SE
      const ax = gx < 0 ? -gx : gx, ay = gy < 0 ? -gy : gy;
      mag[i] = ax + ay; // L1 magnitude: same ranking as L2 for NMS, no sqrt
      let q;
      if (ay <= ax * 0.4142) q = 0;
      else if (ay >= ax * 2.4142) q = 2;
      else q = (gx > 0) === (gy > 0) ? 3 : 1;
      dir[i] = q;
    }
  }
}

function nonMax(w, h) {
  nms.fill(0);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;
      let a, b;
      switch (dir[i]) {
        case 0: a = mag[i - 1]; b = mag[i + 1]; break;
        case 2: a = mag[i - w]; b = mag[i + w]; break;
        case 1: a = mag[i - w + 1]; b = mag[i + w - 1]; break;
        default: a = mag[i - w - 1]; b = mag[i + w + 1];
      }
      if (m >= a && m > b) nms[i] = m;
    }
  }
}

function thresholds(w, h) {
  // Robust upper value of the gradient distribution; thresholds scale with scene contrast.
  const bins = new Uint32Array(256);
  let max = 1;
  const n = w * h;
  for (let i = 0; i < n; i++) if (nms[i] > max) max = nms[i];
  const s = 255 / max;
  let cnt = 0;
  for (let i = 0; i < n; i++) if (nms[i] > 0) { bins[(nms[i] * s) | 0]++; cnt++; }
  let acc = 0, p98 = max;
  for (let b = 0; b < 256; b++) { acc += bins[b]; if (acc >= cnt * 0.98) { p98 = (b + 1) / s; break; } }
  const hi = Math.min(160, Math.max(26, p98 * 0.2));
  return { hi, lo: hi * 0.45 };
}

function hysteresis(w, h, lo, hi) {
  edges.fill(0);
  let sp = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (nms[i] >= hi && !edges[i]) {
      edges[i] = 1; stack[sp++] = i;
      while (sp) {
        const j = stack[--sp];
        const y = (j / w) | 0, x = j - y * w;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const k = yy * w + xx;
            if (!edges[k] && nms[k] >= lo) { edges[k] = 1; stack[sp++] = k; }
          }
        }
      }
    }
  }
}

function dilate3(src, dst, w, h) {
  // separable 3x3 max: horizontal into mask-sized scratch, then vertical
  const t = tmpU8();
  for (let y = 0; y < h; y++) {
    const r = y * w;
    t[r] = src[r] | src[r + 1];
    for (let x = 1; x < w - 1; x++) t[r + x] = src[r + x - 1] | src[r + x] | src[r + x + 1];
    t[r + w - 1] = src[r + w - 2] | src[r + w - 1];
  }
  for (let x = 0; x < w; x++) { dst[x] = t[x] | t[x + w]; dst[(h - 1) * w + x] = t[(h - 1) * w + x] | t[(h - 2) * w + x]; }
  for (let i = w; i < (h - 1) * w; i++) dst[i] = t[i - w] | t[i] | t[i + w];
}
let scratchU8 = null;
function tmpU8() { if (!scratchU8 || scratchU8.length !== W * H) scratchU8 = new Uint8Array(W * H); return scratchU8; }

function erode3(src, dst, w, h) {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) { dst[i] = 0; continue; }
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dst[i] = 1; continue; }
      dst[i] = src[i - 1] & src[i + 1] & src[i - w] & src[i + w] & src[i - w - 1] & src[i - w + 1] & src[i + w - 1] & src[i + w + 1];
    }
  }
}

function otsu(w, h) {
  const hist = new Float64Array(256);
  const n = w * h;
  for (let i = 0; i < n; i++) hist[blur[i] | 0]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = t; }
  }
  return th;
}

// Label 8-connected components of `bin`, then turn big ones into quad candidates.
function components(bin, w, h, minFrac, out) {
  labels.fill(0);
  let next = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (!bin[i] || labels[i]) continue;
    if (next >= MAXC - 1) break;
    const L = ++next;
    let sp = 0, count = 0, minX = w, maxX = 0, minY = h, maxY = 0;
    labels[i] = L; stack[sp++] = i;
    while (sp) {
      const j = stack[--sp];
      const y = (j / w) | 0, x = j - y * w;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        let k;
        k = j - w - 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j - w; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j - w + 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j - 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j + 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j + w - 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j + w; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        k = j + w + 1; if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        continue;
      }
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const k = yy * w + xx;
          if (bin[k] && !labels[k]) { labels[k] = L; stack[sp++] = k; }
        }
      }
    }
    cCount[L] = count; cMinX[L] = minX; cMaxX[L] = maxX; cMinY[L] = minY; cMaxY[L] = maxY;
  }
  const minArea = minFrac * w * h;
  for (let L = 1; L <= next; L++) {
    const bw = cMaxX[L] - cMinX[L] + 1, bh = cMaxY[L] - cMinY[L] + 1;
    if (bw * bh < minArea || bw < w * 0.12 || bh < h * 0.12) continue;
    if (cCount[L] < (bw + bh) * 0.5) continue;
    const pts = [];
    for (let y = cMinY[L]; y <= cMaxY[L]; y++) { rowMin[y] = -1; rowMax[y] = -1; }
    for (let y = cMinY[L]; y <= cMaxY[L]; y++) {
      const r = y * w;
      for (let x = cMinX[L]; x <= cMaxX[L]; x++) {
        if (labels[r + x] === L) { if (rowMin[y] < 0) rowMin[y] = x; rowMax[y] = x; }
      }
      if (rowMin[y] >= 0) { pts.push([rowMin[y], y]); if (rowMax[y] !== rowMin[y]) pts.push([rowMax[y], y]); }
    }
    const hull = convexHull(pts);
    if (hull.length < 4) continue;
    const q = maxQuad(simplify(hull, 18));
    if (q) out.push(q);
  }
}

function convexHull(pts) {
  if (pts.length < 3) return pts;
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// Visvalingam: drop the vertex contributing the smallest triangle until `target` remain.
function simplify(poly, target) {
  const p = poly.slice();
  const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
  while (p.length > target) {
    let k = 0, best = Infinity;
    for (let i = 0; i < p.length; i++) {
      const a = tri(p[(i + p.length - 1) % p.length], p[i], p[(i + 1) % p.length]);
      if (a < best) { best = a; k = i; }
    }
    p.splice(k, 1);
  }
  return p;
}

function maxQuad(p) {
  const n = p.length;
  if (n < 4) return null;
  if (n === 4) return p;
  let best = -1, bq = null;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
    const q = [p[a], p[b], p[c], p[d]];
    const ar = polyArea(q);
    if (ar > best) { best = ar; bq = q; }
  }
  return bq;
}

// Fit a line to edge pixels near each side, then intersect neighbours for sub-pixel corners.
function refine(q, w, h) {
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const xs = [], ys = [];
    for (let t = len * 0.08; t <= len * 0.92; t += 1) {
      const cx = a[0] + ux * t, cy = a[1] + uy * t;
      for (const d of [0, 1, -1, 2, -2, 3, -3]) {
        const x = Math.round(cx + nx * d), y = Math.round(cy + ny * d);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (edges[y * w + x]) { xs.push(x); ys.push(y); break; }
      }
    }
    let line = null;
    if (xs.length > len * 0.35) {
      line = fitLine(xs, ys, null);
      if (line) {
        // one pass of outlier rejection
        const keep = xs.map((x, i) => Math.abs((x - line.x) * line.nx + (ys[i] - line.y) * line.ny) < 1.5);
        line = fitLine(xs, ys, keep) || line;
      }
    }
    lines.push(line || { x: a[0], y: a[1], nx, ny });
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return q;
    out.push(p);
  }
  const diag = Math.hypot(w, h);
  for (let i = 0; i < 4; i++) if (Math.hypot(out[i][0] - q[i][0], out[i][1] - q[i][1]) > diag * 0.05) return q;
  return out;
}

function fitLine(xs, ys, keep) {
  let n = 0, mx = 0, my = 0;
  for (let i = 0; i < xs.length; i++) if (!keep || keep[i]) { mx += xs[i]; my += ys[i]; n++; }
  if (n < 6) return null;
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) if (!keep || keep[i]) { const dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  // principal direction
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(th), dy = Math.sin(th);
  return { x: mx, y: my, nx: -dy, ny: dx };
}

function intersect(l1, l2) {
  // n . (p - p0) = 0 for both
  const a1 = l1.nx, b1 = l1.ny, c1 = l1.nx * l1.x + l1.ny * l1.y;
  const a2 = l2.nx, b2 = l2.ny, c2 = l2.nx * l2.x + l2.ny * l2.y;
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
}

// Fraction of each side backed by an edge pixel (dilated map) or by a paper/background boundary.
function support(q, w, h, useMask) {
  const sides = [];
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len;
    // outward normal
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    if ((mx - cx) * nx + (my - cy) * ny < 0) { nx = -nx; ny = -ny; }
    const N = Math.max(12, Math.min(80, len | 0));
    let hit = 0, total = 0;
    for (let k = 0; k < N; k++) {
      const t = 0.06 + (0.88 * k) / (N - 1);
      const px = a[0] + dx * t, py = a[1] + dy * t;
      total++;
      let ok = false;
      for (let d = -2; d <= 2 && !ok; d++) {
        const x = Math.round(px + nx * d), y = Math.round(py + ny * d);
        if (x >= 0 && y >= 0 && x < w && y < h && dil[y * w + x]) ok = true;
      }
      if (!ok && useMask) {
        const ix = Math.round(px - nx * 3), iy = Math.round(py - ny * 3), ox = Math.round(px + nx * 3), oy = Math.round(py + ny * 3);
        if (ix >= 0 && iy >= 0 && ix < w && iy < h && ox >= 0 && oy >= 0 && ox < w && oy < h) ok = mask[iy * w + ix] === 1 && mask[oy * w + ox] === 0;
      }
      if (ok) hit++;
    }
    sides.push(hit / total);
  }
  return sides;
}

// Mean |inside - outside| brightness across each side, sampled 4px either side.
function contrast(q, w, h) {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  const out = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s], b = q[(s + 1) % 4];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    let nx = -dy / len, ny = dx / len;
    if (((a[0] + b[0]) / 2 - cx) * nx + ((a[1] + b[1]) / 2 - cy) * ny < 0) { nx = -nx; ny = -ny; }
    let sum = 0, cnt = 0;
    for (let k = 0; k < 24; k++) {
      const t = 0.1 + (0.8 * k) / 23;
      const px = a[0] + dx * t, py = a[1] + dy * t;
      const ix = Math.round(px - nx * 4), iy = Math.round(py - ny * 4), ox = Math.round(px + nx * 4), oy = Math.round(py + ny * 4);
      if (ix < 0 || iy < 0 || ix >= w || iy >= h || ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
      sum += Math.abs(blur[iy * w + ix] - blur[oy * w + ox]); cnt++;
    }
    out.push(cnt ? sum / cnt : 0);
  }
  return out;
}

function evaluate(q, w, h, useMask) {
  if (!isConvex(q)) return null;
  const area = polyArea(q) / (w * h);
  if (area < 0.06 || area > 0.995) return null;
  const ang = angles(q);
  for (const a of ang) if (a < 50 || a > 130) return null;
  let minSide = Infinity;
  for (let i = 0; i < 4; i++) minSide = Math.min(minSide, Math.hypot(q[i][0] - q[(i + 1) % 4][0], q[i][1] - q[(i + 1) % 4][1]));
  if (minSide < Math.min(w, h) * 0.12) return null;
  // Corners pinned to the frame edge mean the page runs off-screen.
  let onBorder = 0;
  for (const [x, y] of q) if (x < 2 || y < 2 || x > w - 3 || y > h - 3) onBorder++;
  if (onBorder >= 2) return null;
  // A side hugging one frame edge is the frame, not a page.
  const m = Math.min(w, h) * 0.03;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    if ((a[0] < m && b[0] < m) || (a[1] < m && b[1] < m) || (a[0] > w - m && b[0] > w - m) || (a[1] > h - m && b[1] > h - m)) return null;
  }
  // Paper edges are a brightness step; texture is not.
  const con = contrast(q, w, h);
  if (Math.min(...con) < 9) return null;
  const sup = support(q, w, h, useMask);
  const mean = (sup[0] + sup[1] + sup[2] + sup[3]) / 4;
  const min = Math.min(...sup);
  if (min < 0.4 || mean < 0.6) return null;
  const rect = ang.reduce((s, a) => s + Math.abs(90 - a), 0) / 360; // 0 = perfect rectangle
  const score = mean * mean * Math.sqrt(area) * (1 - rect * 0.6);
  return { score, area, support: mean };
}

export function detectQuad(gray, w, h) {
  alloc(w, h);
  gaussian(gray, w, h);
  sobel(w, h);
  nonMax(w, h);
  const { lo, hi } = thresholds(w, h);
  hysteresis(w, h, lo, hi);
  dilate3(edges, dil, w, h);

  // Brightness mask (paper vs. background), opened to break thin bridges.
  const th = otsu(w, h);
  const n = w * h;
  for (let i = 0; i < n; i++) mask[i] = blur[i] > th ? 1 : 0;
  erode3(mask, mask2, w, h); erode3(mask2, mask, w, h);
  dilate3(mask, mask2, w, h); dilate3(mask2, mask, w, h);

  const edgeCands = [];
  components(dil, w, h, 0.05, edgeCands);
  const maskCands = [];
  // `components` overwrites labels; mask candidates are evaluated with the mask boundary as support.
  components(mask, w, h, 0.05, maskCands);

  let best = null;
  const consider = (raw, useMask) => {
    const q = orderQuad(raw);
    const r = refine(q, w, h);
    let quad = r, ev = evaluate(r, w, h, useMask);
    if (!ev) { quad = q; ev = evaluate(q, w, h, useMask); }
    if (ev && (!best || ev.score > best.score)) best = { quad, ...ev };
  };
  for (const q of edgeCands) consider(q, false);
  for (const q of maskCands) consider(q, true);
  return best;
}
