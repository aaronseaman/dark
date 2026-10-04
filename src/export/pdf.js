// Minimal scanned-PDF writer. Page images pass through untouched (JPEG -> DCTDecode,
// our 1-bit PNG IDAT -> FlateDecode + PNG predictor). OCR words are laid over the
// image in text render mode 3 (invisible): searchable and selectable at ~zero cost.

import { latin1, concat, zlib, jpegInfo, pngInfo, hex } from './bytes.js';
import { setupEncryption } from './pdfcrypt.js';

// Helvetica advance widths for WinAnsi 32..126 (per 1000 em).
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];

const WINANSI_EXTRA = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };

function winAnsi(str) {
  const out = [];
  for (const ch of str.normalize('NFC')) {
    const c = ch.codePointAt(0);
    if (c >= 0x20 && c < 0x7f) out.push(c);
    else if (c >= 0xa0 && c <= 0xff) out.push(c);
    else if (WINANSI_EXTRA[c]) out.push(WINANSI_EXTRA[c]);
    else out.push(0x3f);
  }
  return out;
}

function pdfString(codes) {
  let s = '(';
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) s += '\\' + String.fromCharCode(c);
    else if (c < 0x20 || c > 0x7e) s += '\\' + c.toString(8).padStart(3, '0');
    else s += String.fromCharCode(c);
  }
  return s + ')';
}

function textWidth(codes) {
  let w = 0;
  for (const c of codes) w += c >= 32 && c <= 126 ? HELV[c - 32] : 556;
  return w / 1000;
}

const f2 = (n) => (Math.round(n * 100) / 100).toString();

export function pageSizeFor(w, h) {
  const portrait = h >= w;
  const r = Math.max(w, h) / Math.min(w, h);
  let short, long;
  if (Math.abs(r - Math.SQRT2) / Math.SQRT2 < 0.035) { short = 595.28; long = 841.89; }
  else if (Math.abs(r - 11 / 8.5) / (11 / 8.5) < 0.035) { short = 612; long = 792; }
  else { short = 595.28; long = 595.28 * r; }
  return portrait ? { pw: short, ph: long } : { pw: long, ph: short };
}

function textLayer(words, pw, ph) {
  const ops = ['BT', '3 Tr'];
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    const codes = winAnsi(wd.t);
    if (!codes.length) continue;
    const fs = Math.max(1, wd.h * ph * 1.0);
    const tw = textWidth(codes) * fs;
    // A trailing space (outside the fitted width) lets every extractor see word breaks.
    const next = words[i + 1];
    if (next && (wd.l != null ? next.l === wd.l : Math.abs(next.y - wd.y) < wd.h * 0.5)) codes.push(0x20);
    const target = wd.w * pw;
    const tz = Math.max(10, Math.min(500, tw > 0 ? (target / tw) * 100 : 100));
    const x = wd.x * pw;
    const y = ph - (wd.b ?? wd.y + wd.h * 0.8) * ph;
    ops.push(`/F0 ${f2(fs)} Tf ${f2(tz)} Tz 1 0 0 1 ${f2(x)} ${f2(y)} Tm ${pdfString(codes)} Tj`);
  }
  ops.push('ET');
  return ops.join('\n');
}

function dateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function utf16be(s) {
  const out = [0xfe, 0xff];
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out.push(c >> 8, c & 0xff); }
  return new Uint8Array(out);
}

/**
 * pages: [{ bytes: Uint8Array, type: 'image/jpeg'|'image/png', words?: [{t,x,y,w,h,b}] }]
 * returns Uint8Array
 */
export async function writePDF({ pages, title = 'Scan', password = '', searchable = true }) {
  const id0 = crypto.getRandomValues(new Uint8Array(16));
  const enc = password ? await setupEncryption(password, id0) : null;
  const chunks = [];
  const offsets = [];
  let pos = 0;
  const push = (b) => { chunks.push(b); pos += b.length; };
  push(latin1('%PDF-1.7\n'));
  push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  // Object numbers: 1 catalog, 2 pages, 3 font, 4 info, then 3 per page, then encrypt.
  const n = pages.length;
  const pageObj = (i) => 5 + i * 3;
  const encNum = 5 + n * 3;
  const total = enc ? encNum + 1 : encNum;

  const obj = (num, body) => { offsets[num] = pos; push(latin1(`${num} 0 obj\n${body}\nendobj\n`)); };
  const strObj = async (num, s) => {
    // Strings outside streams must be encrypted too.
    const raw = utf16be(s);
    return enc ? `<${hex(await enc.encryptObject(num, 0, raw))}>` : `<${hex(raw)}>`;
  };
  const stream = async (num, dict, data) => {
    const body = enc ? await enc.encryptObject(num, 0, data) : data;
    offsets[num] = pos;
    push(latin1(`${num} 0 obj\n<< ${dict} /Length ${body.length} >>\nstream\n`));
    push(body);
    push(latin1('\nendstream\nendobj\n'));
  };

  obj(1, '<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /DisplayDocTitle true >> >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}] >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, `<< /Title ${await strObj(4, title)} /Producer ${await strObj(4, 'dark')} /Creator ${await strObj(4, 'dark scanner')} /CreationDate ${await strObj(4, dateString())} >>`);

  for (let i = 0; i < n; i++) {
    const pg = pages[i];
    let w, h, imgDict, data;
    if (pg.type === 'image/png') {
      const info = pngInfo(pg.bytes);
      if (!info || info.depth !== 1 || info.color !== 0 || info.interlace) throw new Error('unsupported PNG');
      w = info.w; h = info.h; data = info.idat;
      imgDict = `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 1 /Columns ${w} >>`;
    } else {
      const info = jpegInfo(pg.bytes);
      if (!info) throw new Error('unsupported JPEG');
      w = info.w; h = info.h; data = pg.bytes;
      const cs = info.comps === 1 ? '/DeviceGray' : info.comps === 4 ? '/DeviceCMYK' : '/DeviceRGB';
      imgDict = `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`;
    }
    const { pw, ph } = pageSizeFor(w, h);
    const po = pageObj(i), co = po + 1, io = po + 2;
    obj(po, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f2(pw)} ${f2(ph)}] /Resources << /XObject << /Im0 ${io} 0 R >> /Font << /F0 3 0 R >> /ProcSet [/PDF /Text /ImageB /ImageC] >> /Contents ${co} 0 R >>`);
    let content = `q ${f2(pw)} 0 0 ${f2(ph)} 0 0 cm /Im0 Do Q\n`;
    if (searchable && pg.words && pg.words.length) content += textLayer(pg.words, pw, ph);
    await stream(co, '/Filter /FlateDecode', await zlib(latin1(content)));
    await stream(io, imgDict, data);
  }

  if (enc) {
    obj(encNum, `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV2 /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(enc.O)}> /U <${hex(enc.U)}> /P ${enc.P} /EncryptMetadata true >>`);
  }

  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  const idh = hex(id0);
  x += `trailer\n<< /Size ${total} /Root 1 0 R /Info 4 0 R /ID [<${idh}> <${idh}>]${enc ? ` /Encrypt ${encNum} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  push(latin1(x));
  return concat(chunks);
}
