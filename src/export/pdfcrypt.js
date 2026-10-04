// PDF Standard Security Handler, revision 4 (AES-128, AESV2).
// MD5 + RC4 are needed for key derivation only; content is AES-CBC via WebCrypto.

const PAD = new Uint8Array([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

export function md5(bytes) {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 2 ** 32), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0, true); ov.setUint32(4, b0, true); ov.setUint32(8, c0, true); ov.setUint32(12, d0, true);
  return out;
}

export function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function padPw(pw) {
  const b = new Uint8Array(32);
  const src = new Uint8Array([...pw].slice(0, 32).map((ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 63; }));
  b.set(src);
  b.set(PAD.subarray(0, 32 - src.length), src.length);
  return b;
}

function cat(...a) {
  const n = a.reduce((s, x) => s + x.length, 0);
  const o = new Uint8Array(n);
  let p = 0;
  for (const x of a) { o.set(x, p); p += x.length; }
  return o;
}

// Returns { O, U, P, key, encryptObject(num, gen, bytes) -> Promise<bytes> }
export async function setupEncryption(userPw, id0, ownerPw) {
  const P = -4; // all permissions
  const owner = ownerPw || Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => String.fromCharCode(33 + (b % 90))).join('');
  // Algorithm 3: O
  let h = md5(padPw(owner));
  for (let i = 0; i < 50; i++) h = md5(h);
  const okey = h.subarray(0, 16);
  let O = rc4(okey, padPw(userPw));
  for (let i = 1; i <= 19; i++) O = rc4(okey.map((b) => b ^ i), O);
  // Algorithm 2: file key
  const pb = new Uint8Array(4);
  new DataView(pb.buffer).setInt32(0, P, true);
  let k = md5(cat(padPw(userPw), O, pb, id0));
  for (let i = 0; i < 50; i++) k = md5(k.subarray(0, 16));
  const key = k.slice(0, 16);
  // Algorithm 5: U
  let U = rc4(key, md5(cat(PAD, id0)));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = cat(U, new Uint8Array(16));

  const salt = new Uint8Array([0x73, 0x41, 0x6c, 0x54]); // "sAlT"
  async function encryptObject(num, gen, bytes) {
    const ok = md5(cat(key, new Uint8Array([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, gen & 0xff, (gen >> 8) & 0xff]), salt)).subarray(0, 16);
    const ck = await crypto.subtle.importKey('raw', ok, { name: 'AES-CBC' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, ck, bytes));
    return cat(iv, ct);
  }
  return { O, U, P, key, encryptObject };
}
