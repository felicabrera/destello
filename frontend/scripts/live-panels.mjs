// Helper (not part of the product): drives Spectrum and Measure for the five presets against the live API.
// Usage: node scripts/live-panels.mjs <outDir> [preset ...]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out || out === 'undefined') {
  console.error('Usage: node scripts/live-panels.mjs <outDir>: the output directory is required');
  process.exit(2);
}
const only = process.argv.slice(3);
const base = process.env.BASE ?? 'http://localhost:5173';
mkdirSync(out, { recursive: true });
const presets = ['barnard', 'wise0855', 'epsindib', 'rwaur', 'rdra'].filter((p) => !only.length || only.includes(p));
const browser = await chromium.launch({ channel: 'chrome' });
const summary = {};
for (const id of presets) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message.slice(0, 160)));
  await page.goto(base + '/about');
  await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
  const res = { errs };
  for (const tab of ['measure', 'spectrum']) {
    const t0 = Date.now();
    await page.goto(`${base}/t/${id}?tab=${tab}&lang=en`);
    const sel = tab === 'measure' ? '[data-testid="measure-panel"], [data-testid="measure-notmeasurable"], [data-testid="measure-toofew"], [data-testid="measure-error"]' : '[data-testid="spectrum-plot"], [data-testid="spectrum-error"], [data-testid="spectrum-saturated"]';
    try {
      await page.waitForSelector(sel, { timeout: 30000 });
      if (tab === 'measure') await page.waitForSelector('[data-testid="measure-result"], [data-testid="measure-notmeasurable"], [data-testid="measure-toofew"], [data-testid="measure-error"]', { timeout: 200000 });
      else await page.waitForSelector('[data-testid="spectrum-plot"], [data-testid="spectrum-error"]', { timeout: 200000 });
    } catch (e) {
      res[tab + 'Timeout'] = true;
    }
    await page.waitForTimeout(1500);
    res[tab + 'Ms'] = Date.now() - t0;
    res[tab + 'Text'] = (await page.locator('[data-testid="' + (tab === 'measure' ? 'measure-panel' : 'spectrum-panel') + '"], [data-testid="measure-notmeasurable"], [data-testid="measure-toofew"]').first().innerText().catch(() => '')).slice(0, 1500);
    await page.screenshot({ path: `${out}/${tab}-${id}.png` });
  }
  summary[id] = res;
  await ctx.close();
}
console.log(JSON.stringify(summary, null, 1));
await browser.close();
