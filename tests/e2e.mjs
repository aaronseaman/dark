// End-to-end smoke test in headless Chromium with a fake camera.
//   CAM=/path/cam.y4m OUT=/tmp/shots URL=http://localhost:8080/ node tests/e2e.mjs
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');

const URL = process.env.URL || 'http://localhost:8080/';
const OUT = process.env.OUT || '/tmp/dark-shots';
const CAM = process.env.CAM;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(CAM ? [`--use-file-for-fake-video-capture=${CAM}`] : []),
    '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 440, height: 956 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  permissions: ['camera'], acceptDownloads: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
});
await ctx.addInitScript(() => {
  // Force the plain download path so the test can capture the file.
  delete window.showSaveFilePicker;
  Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });
  Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const shot = async (name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); console.log('shot', name); };
const step = (s) => console.log('—', s);

step('load');
await page.goto(URL);
await page.waitForSelector('.firstrun, .library', { timeout: 15000 });
await page.waitForTimeout(400);
await shot('01-firstrun');
await page.waitForSelector('.firstrun', { state: 'detached', timeout: 60000 });
await page.waitForTimeout(500);
await shot('02-library-empty');

step('capture');
await page.tap('.fab');
await page.waitForSelector('.capture video', { timeout: 10000 });
await page.waitForFunction(() => document.querySelector('.capture video').videoWidth > 0, null, { timeout: 15000 });
await page.waitForTimeout(700);
await shot('03-capture-detect');
// auto-capture should fire on its own
await page.waitForFunction(() => /PG/.test(document.querySelector('.capture .counter')?.textContent || ''), null, { timeout: 20000 });
await page.waitForTimeout(1500);
await shot('04-capture-captured');
// manual second capture (same page, so auto won't re-arm): turn auto off, tap shutter
await page.tap('.autobtn');
await page.tap('.shutter');
await page.waitForFunction(() => /2 PGS/.test(document.querySelector('.capture .counter')?.textContent || ''), null, { timeout: 10000 });
await page.waitForTimeout(1200);
await shot('05-capture-two');

step('review');
await page.tap('.donebtn');
await page.waitForSelector('.review .stage canvas, .review .stage img', { timeout: 20000 });
await page.waitForTimeout(800);
await shot('06-review-enhance');
await page.tap('.filters button[data-k="bw"]');
await page.waitForTimeout(1500);
await shot('07-review-bw');
await page.tap('.filters button[data-k="original"]');
await page.waitForTimeout(1500);
await shot('08-review-original');
await page.tap('.filters button[data-k="enhance"]');
await page.waitForTimeout(1200);

step('crop');
await page.tap('.actions .action:nth-child(2)');
await page.waitForSelector('.crop canvas', { timeout: 10000 });
await page.waitForTimeout(600);
// drag the first corner a little to show the loupe
const box = await page.locator('.crop .cstage').boundingBox();
const corner = await page.evaluate(() => { const s = window.__cropDebug; return s || null; });
void corner;
await shot('09-crop');
await page.tap('.crop .cbar .textbtn:last-child');
await page.waitForTimeout(800);

step('done -> document + export');
await page.tap('.review .topbar .textbtn');
await page.waitForSelector('.sheet .formats', { timeout: 15000 });
await page.waitForTimeout(600);
await shot('10-export-sheet');

step('wait for OCR then export');
const dl = page.waitForEvent('download', { timeout: 120000 });
await page.tap('.sheet .sfoot .btn');
const d = await dl;
const pdfPath = `${OUT}/export.pdf`;
await d.saveAs(pdfPath);
console.log('downloaded', d.suggestedFilename());
await page.waitForTimeout(800);
await shot('11-document');

step('reader');
await page.tap('.pgrid .pcell');
await page.waitForSelector('.reader img[src]', { timeout: 10000 });
await page.waitForTimeout(600);
await shot('12-reader');
await page.tap('.reader .actions .action:nth-child(2)');
await page.waitForTimeout(800);
await shot('13-ocr-text');
await page.mouse.click(220, 100);
await page.waitForTimeout(400);
await page.tap('.reader .actions .action:nth-child(3)');
await page.waitForTimeout(400);
await shot('14-night');
await page.goBack();
await page.waitForTimeout(500);
await page.goBack();
await page.waitForTimeout(600);
await shot('15-library');

step('search');
await page.tap('.library .topbar [aria-label="Search"]');
await page.fill('.library input[type="search"]', 'acme');
await page.waitForTimeout(500);
await shot('16-search');

writeFileSync(`${OUT}/errors.txt`, errors.join('\n'));
console.log('errors:', errors.length);
for (const e of errors.slice(0, 30)) console.log(e);
await browser.close();
void box;
