// Usage: node scripts/live-shot.mjs "<path+query>" out.png [width] [height] [lang]
import { chromium } from '@playwright/test';
const [path, out, w = '1440', h = '900', lang = 'en'] = process.argv.slice(2);
const base = process.env.BASE ?? 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h } });
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 120)); });
page.on('response', (r) => { if (r.status() >= 400) errs.push(r.status() + ' ' + r.url().replace(base, '').slice(0, 100)); });
await page.goto(base + '/about');
await page.evaluate((l) => { sessionStorage.removeItem('destello.fx'); try { localStorage.setItem('destello.lang', l); } catch {} }, lang);
await page.goto(base + path + (path.includes('lang=') ? '' : (path.includes('?') ? '&' : '?') + 'lang=' + lang));
await page.waitForTimeout(+(process.env.WAIT ?? 4000));
await page.screenshot({ path: out, fullPage: !!process.env.FULL });
console.log(JSON.stringify(errs));
await browser.close();
