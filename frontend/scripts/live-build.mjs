// Opens a path that needs a build and logs UI state every 10 s (progress, phase) until frames play or timeout.
import { chromium } from '@playwright/test';
const [path, tag, maxS = '300'] = process.argv.slice(2);
const base = process.env.BASE ?? 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errs = [];
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(base, '').slice(0, 90)); });
await page.goto(base + '/about');
await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
const t0 = Date.now();
await page.goto(base + path);
let shot = 0;
while ((Date.now() - t0) / 1000 < +maxS) {
  await page.waitForTimeout(8000);
  const st = await page.evaluate(() => ({
    pb: [...document.querySelectorAll('[role=progressbar]')].map((e) => e.getAttribute('aria-valuenow') + '|' + (e.closest('[data-testid]')?.dataset.testid ?? '')).join(','),
    txt: [...document.querySelectorAll('[data-testid^=build],[data-testid^=state]')].map((e) => e.textContent.trim().slice(0, 140)).join(' || '),
    ep: !!document.querySelector('[data-testid=epoch-chip]'),
  }));
  console.log(Math.round((Date.now() - t0) / 1000) + 's', JSON.stringify(st));
  if (shot++ % 3 === 0) await page.screenshot({ path: `../qa/screens/B5-live/build-${tag}-${Math.round((Date.now() - t0) / 1000)}s.png` });
  if (st.ep && !st.pb) break;
}
await page.screenshot({ path: `../qa/screens/B5-live/build-${tag}-end.png` });
console.log('errors', JSON.stringify(errs));
await browser.close();
