// Helper (not part of the product): loading, error and retry states of Spectrum, ES copy, validation page.
// Usage: node scripts/live-states.mjs <outDir>
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const out = process.argv[2];
if (!out || out === 'undefined') {
  console.error('Usage: node scripts/live-states.mjs <outDir>: the output directory is required');
  process.exit(2);
}
const base = process.env.BASE ?? 'http://localhost:5173';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const errs = [];
const mk = async (w = 1440, h = 1000) => {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text().slice(0, 160));
  });
  page.on('pageerror', (e) => errs.push('pageerror ' + e.message.slice(0, 160)));
  await page.goto(base + '/about');
  await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
  return page;
};
const res = {};

// 1. Loading state then error then retry (first call delayed 7 s and failed with 500, second call passes).
{
  const page = await mk();
  let n = 0;
  await page.route('**/api/v1/sequences/*/spectrum*', async (route) => {
    n += 1;
    if (n === 1) {
      await new Promise((r) => setTimeout(r, 7000));
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{"code":"INTERNAL_ERROR","detail":"x"}' });
    } else await route.continue();
  });
  await page.goto(`${base}/t/rwaur?tab=spectrum&lang=en`);
  await page.waitForSelector('[data-testid="spectrum-loading"]', { timeout: 30000 });
  await page.waitForTimeout(4500);
  res.loading = (await page.locator('[data-testid="spectrum-loading"]').innerText()).replace(/\n/g, ' | ');
  await page.screenshot({ path: `${out}/state-spectrum-loading.png` });
  await page.waitForSelector('[data-testid="spectrum-error"]', { timeout: 30000 });
  res.error = (await page.locator('[data-testid="spectrum-error"]').innerText()).replace(/\n/g, ' | ');
  await page.screenshot({ path: `${out}/state-spectrum-error.png` });
  // keyboard: focus retry button and press Enter
  await page.locator('[data-testid="spectrum-error"] button').focus();
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-testid="spectrum-plot"]', { timeout: 60000 });
  res.retryOk = true;
  await page.context().close();
}

// 2. Spanish copy.
{
  const page = await mk();
  await page.goto(`${base}/t/epsindib?tab=measure&lang=es`);
  await page.waitForSelector('[data-testid="measure-result"]', { timeout: 120000 });
  await page.waitForTimeout(1000);
  res.esMeasure = (await page.locator('[data-testid="measure-panel"]').innerText()).slice(0, 900).replace(/\n/g, ' | ');
  await page.screenshot({ path: `${out}/es-measure-epsindib.png` });
  await page.goto(`${base}/t/rdra?tab=spectrum&lang=es`);
  await page.waitForSelector('[data-testid="spectrum-plot"]', { timeout: 150000 });
  await page.waitForTimeout(1000);
  res.esSpectrum = (await page.locator('[data-testid="spectrum-panel"]').innerText()).slice(0, 700).replace(/\n/g, ' | ');
  await page.screenshot({ path: `${out}/es-spectrum-rdra.png` });
  await page.context().close();
}

// 3. Validation page, both languages and a narrow viewport.
{
  const page = await mk();
  await page.goto(`${base}/validation?lang=en`);
  await page.waitForSelector('[data-testid="validation-row"]', { timeout: 30000 });
  await page.waitForTimeout(1500);
  res.validation = {
    rows: await page.locator('[data-testid="validation-row"]').evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-status') + ' ' + e.innerText.replace(/\n+/g, ' / ').slice(0, 140)),
    ),
    summary: await page.locator('[data-testid="validation-summary"]').innerText(),
    failnote: await page.locator('[data-testid="validation-failnote"]').innerText(),
    run: await page.locator('[data-testid="validation-run"]').innerText(),
    plots: await page.locator('[data-testid="validation-residuals"]').count(),
  };
  await page.screenshot({ path: `${out}/validation.png`, fullPage: true });
  await page.goto(`${base}/validation?lang=es`);
  await page.waitForSelector('[data-testid="validation-row"]', { timeout: 30000 });
  await page.screenshot({ path: `${out}/validation-es.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(500);
  res.noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  await page.context().close();
}
res.errs = errs;
console.log(JSON.stringify(res, null, 1));
await browser.close();
