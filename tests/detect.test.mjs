// Synthetic-scene tests for the page detector. Requires ImageMagick (`convert`).
// node tests/detect.test.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { detectQuad } from '../src/engine/detect.js';

const OUT = process.env.SCENES || '/tmp/dark-scenes';
mkdirSync(OUT, { recursive: true });
const SW = 1200, SH = 1600; // scene (portrait 3:4)
const DW = 360, DH = 480; // detection size

function im(args) { return execFileSync('convert', args, { maxBuffer: 1 << 28 }); }

function page(file, { shade = false } = {}) {
  const draws = [];
  // fake text lines
  let y = 120;
  draws.push('-fill', '#222', '-draw', 'rectangle 90,70 520,100');
  while (y < 1000) {
    const len = 520 + ((y * 37) % 160);
    for (let x = 90; x < len; x += 0) {
      const wlen = 30 + ((x * 13 + y) % 70);
      draws.push('-draw', `rectangle ${x},${y} ${Math.min(x + wlen, 760)},${y + 12}`);
      x += wlen + 14;
    }
    y += 30 + (y % 3 === 0 ? 20 : 0);
  }
  const args = ['-size', '850x1100', 'xc:#F6F4EE', '-fill', '#2a2a2a', ...draws];
  if (shade) args.push('(', '-size', '850x1100', 'gradient:#ffffff-#9a9690', '-rotate', '35', '-gravity', 'center', '-extent', '850x1100', ')', '-compose', 'multiply', '-composite');
  im([...args, file]);
}

function scene(name, { bg, corners, shade, clutter, noise = 6 }) {
  const pg = `${OUT}/${name}-page.png`;
  page(pg, { shade });
  const [a, b, c, d] = corners;
  const dist = `0,0 ${a[0]},${a[1]}  850,0 ${b[0]},${b[1]}  850,1100 ${c[0]},${c[1]}  0,1100 ${d[0]},${d[1]}`;
  const bgArgs = bg === 'wood'
    ? ['-size', `${SW}x${SH}`, 'plasma:#5a3d24-#3a2614', '-blur', '0x2']
    : bg === 'light'
      ? ['-size', `${SW}x${SH}`, 'xc:#c9c7c2', '+noise', 'Gaussian', '-blur', '0x1']
      : ['-size', `${SW}x${SH}`, 'xc:#1d1f22', '+noise', 'Gaussian', '-blur', '0x1'];
  const clut = clutter ? ['-fill', '#9b9890', '-draw', 'rectangle 40,60 300,230', '-fill', '#3f6b8a', '-draw', 'circle 1080,1450 1150,1520'] : [];
  const file = `${OUT}/${name}.png`;
  im([...bgArgs, ...clut, '(', pg, '-alpha', 'set', '-virtual-pixel', 'transparent', '+distort', 'Perspective', dist, ')', '-geometry', '+0+0', '-compose', 'over', '-flatten', '-attenuate', String(noise / 10), '+noise', 'Gaussian', '-crop', `${SW}x${SH}+0+0`, '+repage', file]);
  return file;
}

function grayOf(file) {
  return new Uint8Array(im([file, '-resize', `${DW}x${DH}!`, '-colorspace', 'Gray', '-depth', '8', 'gray:-']));
}

const cases = [
  { name: 'dark-mild', bg: 'dark', corners: [[230, 230], [980, 260], [1010, 1330], [200, 1300]] },
  { name: 'wood-strong', bg: 'wood', corners: [[330, 300], [880, 290], [1100, 1400], [110, 1420]] },
  { name: 'light-rot', bg: 'light', corners: [[300, 180], [1050, 330], [880, 1420], [110, 1260]] },
  { name: 'shade-clutter', bg: 'dark', shade: true, clutter: true, corners: [[260, 260], [960, 240], [1000, 1250], [230, 1290]] },
  { name: 'small', bg: 'wood', corners: [[420, 520], [800, 530], [790, 1020], [410, 1010]] },
  { name: 'offframe', bg: 'dark', corners: [[-200, 200], [900, 210], [920, 1300], [-180, 1320]], expectNull: true },
];

let fail = 0;
for (const c of cases) {
  const file = scene(c.name, c);
  const g = grayOf(file);
  const t0 = performance.now();
  let r;
  for (let i = 0; i < 5; i++) r = detectQuad(g, DW, DH);
  const ms = (performance.now() - t0) / 5;
  if (c.expectNull) {
    const ok = !r;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(14)} expected none, got ${r ? JSON.stringify(r.quad.map((p) => p.map(Math.round))) : 'none'} (${ms.toFixed(1)}ms)`);
    continue;
  }
  if (!r) { fail++; console.log(`FAIL ${c.name.padEnd(14)} no quad (${ms.toFixed(1)}ms)`); continue; }
  const s = DW / SW;
  const err = Math.max(...r.quad.map((p, i) => Math.hypot(p[0] - c.corners[i][0] * s, p[1] - c.corners[i][1] * s)));
  const ok = err < 4;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name.padEnd(14)} max corner err ${err.toFixed(2)}px @${DW}  support ${r.support.toFixed(2)} area ${r.area.toFixed(2)} (${ms.toFixed(1)}ms)`);
}
// empty scene
{
  const file = `${OUT}/empty.png`;
  im(['-size', `${SW}x${SH}`, 'plasma:#5a3d24-#3a2614', '-blur', '0x2', file]);
  const r = detectQuad(grayOf(file), DW, DH);
  if (r) fail++;
  console.log(`${r ? 'FAIL' : 'PASS'} empty          ${r ? 'false positive' : 'no quad'}`);
}
process.exit(fail ? 1 : 0);
