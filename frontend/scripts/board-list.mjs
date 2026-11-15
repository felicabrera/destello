import { chromium } from '@playwright/test';
const [file] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
await page.goto('http://localhost:8099/' + encodeURIComponent(file));
await page.waitForTimeout(4000);
const r = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('*').forEach((e) => {
    const t = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ');
    if (/^S-\d\d/.test(t) || /S-\d\d ·|S-\d\d:/.test(t)) {
      const b = e.getBoundingClientRect();
      out.push(`${t.slice(0, 70)} @${Math.round(b.x)},${Math.round(b.y + scrollY)} ${e.tagName}`);
    }
  });
  return out;
});
console.log(r.join('\n'));
await browser.close();
