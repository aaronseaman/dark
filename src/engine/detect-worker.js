import { detectQuad, rgbaToGray } from './detect.js';

let gray = null;

self.onmessage = (e) => {
  const { id, buf, w, h } = e.data;
  const t0 = performance.now();
  const rgba = new Uint8Array(buf);
  gray = rgbaToGray(rgba, w, h, gray);
  let res = null;
  try { res = detectQuad(gray, w, h); } catch (err) { res = null; }
  // 8x8 luminance signature: lets capture tell "same page still there" from "page turned".
  const sig = new Uint8Array(64);
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      let s = 0, c = 0;
      const x0 = ((gx * w) / 8) | 0, x1 = (((gx + 1) * w) / 8) | 0, y0 = ((gy * h) / 8) | 0, y1 = (((gy + 1) * h) / 8) | 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { s += gray[y * w + x]; c++; }
      sig[gy * 8 + gx] = c ? s / c : 0;
    }
  }
  self.postMessage({ id, quad: res ? res.quad : null, score: res ? res.score : 0, area: res ? res.area : 0, sig, ms: performance.now() - t0, buf }, [buf]);
};
