// Rasterize icon + iOS startup images with the bundled Chromium.
// node tools/icons.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

const ROOT = new URL('..', import.meta.url).pathname;
const svg = readFileSync(ROOT + 'assets/icons/icon.svg', 'utf8');
const glyph = svg.replace(/<rect width="1024" height="1024" fill="#0B0C0D"\/>/, '');

const browser = await chromium.launch();
const page = await browser.newPage();
async function shot(html, w, h, out) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#0B0C0D">${html}</body></html>`);
  await page.screenshot({ path: ROOT + out, omitBackground: false });
  console.log(out);
}
const icon = (size, scale = 1) => `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;background:#0B0C0D"><div style="width:${size * scale}px;height:${size * scale}px">${svg.replace('<svg ', `<svg width="${size * scale}" height="${size * scale}" `)}</div></div>`;
await shot(icon(180), 180, 180, 'assets/icons/apple-touch-icon.png');
await shot(icon(192), 192, 192, 'assets/icons/icon-192.png');
await shot(icon(512), 512, 512, 'assets/icons/icon-512.png');
await shot(icon(512, 0.8), 512, 512, 'assets/icons/maskable-512.png');
for (const [w, h] of [[1320, 2868], [1206, 2622], [1260, 2736]]) {
  const g = Math.round(w * 0.3);
  await shot(`<div style="width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center">${glyph.replace('<svg ', `<svg width="${g}" height="${g}" `)}</div>`, w, h, `assets/splash/splash-${w}x${h}.png`);
}
await browser.close();
