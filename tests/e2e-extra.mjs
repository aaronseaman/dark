// Secondary flows: import from file, settings, light theme, delete + undo, reorder.
//   IMG=/path/scene.png OUT=/tmp/shots URL=http://localhost:8080/ node tests/e2e-extra.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/node22/lib/node_modules/playwright');
const URL = process.env.URL || 'http://localhost:8080/';
const OUT = process.env.OUT || '/tmp/dark-shots';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Estimating resolution/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
await page.goto(URL);
await page.waitForSelector('.library');
await page.waitForSelector('.firstrun', { state: 'detached', timeout: 60000 }).catch(() => {});
// import two images through the library's hidden input
await page.setInputFiles('.library input[type=file]', [process.env.IMG, process.env.IMG]);
await page.waitForSelector('.review .stage canvas, .review .stage img', { timeout: 30000 });
await page.waitForTimeout(1200);
await shot('x1-import-review');
await page.tap('.review .topbar .textbtn');
await page.waitForSelector('.sheet .formats', { timeout: 15000 });
await page.mouse.click(220, 120); // dismiss sheet via backdrop
await page.waitForTimeout(500);
await shot('x2-document');
// reorder: long-press page 2 and drag onto page 1
const cells = page.locator('.pgrid .pcell');
const b2 = await cells.nth(1).boundingBox();
const b1 = await cells.nth(0).boundingBox();
const id2 = await page.evaluate(() => document.querySelectorAll('.pgrid .pcell img')[1].src);
await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2);
await page.mouse.down();
await page.waitForTimeout(600);
await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2, { steps: 8 });
await page.waitForTimeout(200);
await page.mouse.up();
await page.waitForTimeout(600);
const first = await page.evaluate(() => document.querySelectorAll('.pgrid .pcell img')[0].src);
console.log('reorder', first === id2 ? 'PASS' : 'FAIL');
await shot('x3-reordered');
// delete document from menu, then undo
await page.tap('.document .topbar [aria-label="More"]');
await page.waitForTimeout(300);
await page.getByText('Delete document').tap();
await page.waitForTimeout(500);
const count0 = await page.locator('.library .card').count();
await page.getByRole('button', { name: 'Undo' }).tap();
await page.waitForTimeout(500);
const count1 = await page.locator('.library .card').count();
console.log('delete+undo', count0 === 0 && count1 === 1 ? 'PASS' : `FAIL ${count0} ${count1}`);
// settings + light theme
await page.tap('.library .topbar [aria-label="More"]');
await page.waitForTimeout(300);
await page.getByText('Settings', { exact: true }).tap();
await page.waitForSelector('.settings');
await page.waitForTimeout(400);
await shot('x4-settings');
await page.getByRole('radio', { name: 'Light' }).tap();
await page.waitForTimeout(300);
await shot('x5-settings-light');
await page.goBack();
await page.waitForTimeout(500);
await shot('x6-library-light');
console.log('errors', errors);
await browser.close();
