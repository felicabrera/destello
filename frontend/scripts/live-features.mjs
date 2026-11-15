import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(base, '').slice(0, 90)); });
const log = (k, v) => console.log(k.padEnd(28), typeof v === 'string' ? v : JSON.stringify(v));
await page.goto(base + '/about');
await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
// Downloads
await page.goto(base + '/t/barnard?play=0&det=5&frame=2');
await page.waitForTimeout(2500);
const links = await page.evaluate(() => [...document.querySelectorAll('a[download],a[href*="frames"],a[href*="manifests"]')].map((a) => ({ t: a.textContent.trim(), h: a.getAttribute('href'), d: a.getAttribute('download') })));
log('download links', links);
for (const l of links) {
  const r = await page.request.get(base + l.h);
  log('  GET ' + l.h.slice(0, 40), r.status() + ' ' + r.headers()['content-type'] + ' ' + (await r.body()).length);
}
// URL round trip
const u = '/t/barnard?fov=6&det=5&mode=diff&ref=1&frame=2&fps=1&play=0&ov=catwise,flags&tab=measure&lang=es';
await page.goto(base + u);
await page.waitForTimeout(3500);
log('roundtrip in ', u);
log('roundtrip out', page.url().replace(base, ''));
// Lang switch keeps state
await page.click('[data-testid=lang-toggle]');
await page.waitForTimeout(800);
log('after lang toggle', page.url().replace(base, ''));
// Shortcuts
await page.goto(base + '/t/barnard?play=0');
await page.waitForTimeout(2500);
const keyLog = [];
for (const k of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'End', 'Home', 'KeyG', 'KeyW', 'KeyF', 'Digit3', 'KeyD', 'Space', 'Space', 'Shift+Slash']) {
  await page.keyboard.press(k.replace('Digit', '').replace('Key', '').replace('Slash', '?').toLowerCase() === k ? k : k.startsWith('Key') ? k.slice(3).toLowerCase() : k.startsWith('Digit') ? k.slice(5) : k);
  await page.waitForTimeout(250);
  keyLog.push(k + ' -> ' + page.url().replace(base, '').replace('/t/barnard', ''));
}
log('shortcuts', keyLog);
await page.keyboard.press('Escape');
log('errors', errs);
await browser.close();
