import { chromium } from '@playwright/test';
const [file, x, y, w, h, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await page.goto('http://localhost:8099/' + encodeURIComponent(file));
await page.waitForTimeout(4000);
await page.screenshot({ path: out, fullPage: true, clip: { x: +x, y: +y, width: +w, height: +h } });
await browser.close();
