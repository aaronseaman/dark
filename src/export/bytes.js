// Byte-level helpers shared by the PNG, PDF, ZIP and DOCX writers.

const te = new TextEncoder();
export const utf8 = (s) => te.encode(s);

// Latin-1 bytes (PDF syntax is byte-oriented; we only emit ASCII outside strings).
export function latin1(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

let crcTable = null;
export function crc32(buf, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; ) {
    const end = Math.min(buf.length, i + 3800);
    for (; i < end; i++) { a += buf[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// zlib-wrapped DEFLATE. Uses the platform CompressionStream (Safari 16.4+);
// falls back to stored blocks, which is valid zlib, just not smaller.
export async function zlib(data) {
  if (typeof CompressionStream === 'function') {
    try {
      const cs = new CompressionStream('deflate');
      const out = new Response(new Blob([data]).stream().pipeThrough(cs)).arrayBuffer();
      return new Uint8Array(await out);
    } catch { /* fall through */ }
  }
  const blocks = [new Uint8Array([0x78, 0x01])];
  for (let i = 0; i < data.length || i === 0; i += 65535) {
    const len = Math.min(65535, data.length - i);
    const last = i + 65535 >= data.length ? 1 : 0;
    blocks.push(new Uint8Array([last, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]));
    blocks.push(data.subarray(i, i + len));
    if (!data.length) break;
  }
  const a = adler32(data);
  blocks.push(new Uint8Array([a >>> 24, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]));
  return concat(blocks);
}

export function u32be(n) { return new Uint8Array([n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]); }

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// JPEG SOF parse: dimensions + component count, so PDF can declare the right colour space.
export function jpegInfo(bytes) {
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const m = bytes[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) {
      return { h: (bytes[i + 5] << 8) | bytes[i + 6], w: (bytes[i + 7] << 8) | bytes[i + 8], comps: bytes[i + 9] };
    }
    i += 2 + len;
  }
  return null;
}

// Minimal PNG reader for our own 1-bit grayscale files: returns IHDR + concatenated IDAT.
export function pngInfo(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  let i = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let info = null;
  const idat = [];
  while (i < bytes.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    const data = bytes.subarray(i + 8, i + 8 + len);
    if (type === 'IHDR') info = { w: dv.getUint32(i + 8), h: dv.getUint32(i + 12), depth: bytes[i + 16], color: bytes[i + 17], interlace: bytes[i + 20] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    i += 12 + len;
  }
  if (!info) return null;
  info.idat = concat(idat);
  return info;
}
