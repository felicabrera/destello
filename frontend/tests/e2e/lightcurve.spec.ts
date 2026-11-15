import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// F-26 light curve. The frames are a DEV FIXTURE; the photometry sidecar served here is a real one written by a
// build for the demo (WISE 0855), so the plotted values are real measurements.
const SIDECAR = readFileSync(
  resolve(process.cwd(), 'tests/fixtures/manifests/3bf0d84f65f4400c.photometry.json'),
  'utf-8',
);

async function serveSidecar(page: Page, body: string = SIDECAR) {
  await page.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    sessionStorage.setItem('destello.fxPhot', '1');
  });
  await page.route('**/manifests/*.photometry.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body }),
  );
}

test('F-26: the light curve plots the sidecar per detector with wavelength and errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serveSidecar(page);
  await page.goto('/t/rdra?play=0&tab=spectrum');
  const lc = page.getByTestId('light-curve');
  await expect(lc).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('lc-plot')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('lc-note')).toContainText('12 arcsec');
  // Detectors come from the sidecar; the radio group is keyboard operable.
  const d5 = page.getByTestId('lc-det-5');
  const d6 = page.getByTestId('lc-det-6');
  await expect(d5).toBeVisible();
  await d6.focus();
  await page.keyboard.press('Enter');
  await expect(d6).toHaveAttribute('aria-checked', 'true');
  const row = page.getByTestId('lc-row-0');
  await expect(row).toContainText('µm');
  await expect(row).toContainText('±');
  expect(errors).toEqual([]);
});

test('F-26: an epoch without a measurement shows the reason instead of a value', async ({ page }) => {
  // Test input only: the first entry of the real sidecar is replaced by the shape the build writes when the
  // core is saturated (flux withheld, reason code set).
  const doc = JSON.parse(SIDECAR) as { epoch_photometry: Record<string, unknown>[] };
  const first = doc.epoch_photometry[0];
  first.flux = null;
  first.flux_err = null;
  first.reason = 'saturated_core';
  await serveSidecar(page, JSON.stringify(doc));
  await page.goto(`/t/rdra?play=0&tab=spectrum&lang=es&det=${String(first.detector)}`);
  await expect(page.getByTestId(`lc-reason-${String(first.epoch)}`)).toHaveText(
    'No medible: núcleo saturado',
    {
      timeout: 20_000,
    },
  );
});

test('F-26: a sequence without a photometry file says so', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
  await page.goto('/t/rdra?play=0&tab=spectrum');
  await expect(page.getByTestId('lc-unavailable')).toContainText('no photometry file', { timeout: 20_000 });
});
