// 1-bit grayscale PNG encoder. For pure text this is often 3-5x smaller than JPEG,
// and its IDAT stream drops straight into a PDF (FlateDecode + PNG predictor).

import { concat, crc32, u32be, zlib, latin1 } from './bytes.js';

function chunk(type, data) {
  const t = latin1(type);
  const body = concat([t, data]);
  return concat([u32be(data.length), body, u32be(crc32(body))]);
}

export async function encodePNG1({ bits, stride, w, h }) {
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    raw.set(bits.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32be(w), 0);
  ihdr.set(u32be(h), 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // grayscale
  const png = concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await zlib(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
  return new Blob([png], { type: 'image/png' });
}
