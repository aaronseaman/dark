// node tests/pdf.test.mjs <outdir> : writes sample PDFs/DOCX for external validation
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writePDF } from '../src/export/pdf.js';
import { writeDOCX } from '../src/export/docx.js';
import { encodePNG1 } from '../src/export/png1.js';
import { md5 } from '../src/export/pdfcrypt.js';
import { createHash } from 'node:crypto';

const out = process.argv[2] || '/tmp';
// md5 sanity
for (const s of ['', 'abc', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(200)]) {
  const a = Buffer.from(md5(new TextEncoder().encode(s))).toString('hex');
  const b = createHash('md5').update(s).digest('hex');
  if (a !== b) { console.error('MD5 mismatch', s, a, b); process.exit(1); }
}
console.log('md5 ok');
const jpg = new Uint8Array(execFileSync('convert', ['-size', '850x1100', 'xc:#fafaf8', '-fill', '#111', '-draw', 'rectangle 100,100 700,140', '-quality', '82', 'jpg:-']));
// bitonal page: stripes
const w = 850, h = 1100, stride = (w + 7) >> 3;
const bits = new Uint8Array(stride * h).fill(0xff);
for (let y = 200; y < 240; y++) for (let x = 100; x < 700; x++) bits[y * stride + (x >> 3)] &= ~(0x80 >> (x & 7));
const png = new Uint8Array(await (await encodePNG1({ bits, stride, w, h })).arrayBuffer());
writeFileSync(`${out}/bitonal.png`, png);
const words = [
  { t: 'Invoice', x: 100 / 850, w: 300 / 850, y: 100 / 1100, h: 40 / 1100, b: 132 / 1100 },
  { t: 'Acme(Corp)\\é', x: 420 / 850, w: 280 / 850, y: 100 / 1100, h: 40 / 1100, b: 132 / 1100 },
];
const pages = [
  { bytes: jpg, type: 'image/jpeg', w: 850, h: 1100, words, text: 'Invoice Acme' },
  { bytes: png, type: 'image/png', w, h, words: [{ t: 'Total', x: 0.12, w: 0.2, y: 0.18, h: 0.036, b: 0.215 }], text: 'Total' },
];
writeFileSync(`${out}/plain.pdf`, await writePDF({ pages, title: 'Invoice Acme — 2026' }));
writeFileSync(`${out}/locked.pdf`, await writePDF({ pages, title: 'Locked', password: 'hunter2' }));
writeFileSync(`${out}/doc.docx`, writeDOCX({ pages, title: 'Doc', includeText: true }));
console.log('written');
