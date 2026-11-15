import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://localhost:5173';
const queries = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
for (const q of queries) {
  const [lang, text] = q.split('|');
  await page.goto(base + '/about');
  await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
  await page.goto(base + '/?lang=' + lang);
  await page.waitForTimeout(800);
  await page.fill('[data-testid=search-input]', text);
  const t0 = Date.now();
  await page.press('[data-testid=search-input]', 'Enter');
  await page.waitForTimeout(+(process.env.WAIT ?? 5000));
  const msg = await page.evaluate(() => [...document.querySelectorAll('[role=alert],[role=status],[data-testid*=error],[data-testid*=state]')].map((e) => e.textContent.trim().slice(0, 200)).filter(Boolean).join(' || '));
  console.log(JSON.stringify({ q, url: page.url().replace(base, ''), msg }));
}
await browser.close();
