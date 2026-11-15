// Demo mode with the API down (F-18, F-33, F-40): the app reads the static bundle under /demo. The bundle here is
// small and synthetic, assembled from the development fixtures and the trimmed WISE documents of tests/e2e/fixtures;
// it exercises the client path mapping only. The real bundle is written by scripts/export_demo.py from cached
// SPHEREx data and is uploaded to the server by the operator.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const WISE_SID = 'b06ca7834dc1fc1f'; // sequence id of the fixture preset wise0855 (src/dev-fixtures)
const COMET_SID = 'c0e7c0e7c0e7c0e7';
const FX = resolve(process.cwd(), 'tests/e2e/fixtures/wise');
const FRAME = readFileSync(resolve(FX, 'frame.webp'));

/** Serve /demo/** from the fixtures, as the static host would. `wise: false` writes an index without companions. */
async function serveBundle(page: Page, opts: { wise?: boolean } = {}) {
  const { wise = true } = opts;
  const helper = await page.context().newPage();
  await helper.goto('/learn?lang=en');
  const fixture = (path: string) =>
    helper.evaluate(async (p) => {
      const src = '/src/dev-fixtures/index.ts';
      const m = (await import(/* @vite-ignore */ src)) as {
        handle: (method: string, path: string, body: unknown) => Promise<{ status: number; body: unknown }>;
      };
      return m.handle('GET', p, undefined);
    }, path);
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/v1/**', (r) => r.abort());
  await page.route('**/demo/**', async (r) => {
    const rel = new URL(r.request().url()).pathname.replace(/^\/demo\//, '');
    if (rel.startsWith('frames/')) return r.fulfill({ status: 200, contentType: 'image/webp', body: FRAME });
    if (rel === 'wise/index.json')
      return r.fulfill(json({ sequences: wise ? { [WISE_SID]: { manifest: true, astrometry: true } } : {} }));
    if (rel === `wise/${WISE_SID}.json`)
      return r.fulfill(json(JSON.parse(readFileSync(resolve(FX, 'manifest.json'), 'utf-8'))));
    if (rel === `wise/${WISE_SID}.astrometry.json`)
      return r.fulfill(json(JSON.parse(readFileSync(resolve(FX, 'astrometry.json'), 'utf-8'))));
    const apiPath = `/${rel.startsWith('manifests/') ? rel : rel.replace(/\.json$/, '')}`;
    const reply = await fixture(apiPath);
    if (reply.status !== 200) return r.fulfill({ status: 404, body: '' });
    return r.fulfill(json(reply.body));
  });
}

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    // The sky map is third-party context: the dev server has no HiPS mirror.
    if (m.type() === 'error' && !/HiPS|CDS|net::ERR|Failed to load resource/.test(m.text()))
      errors.push(m.text());
  });
  return errors;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'demo-bundle'));
});

test('the comet page loads from the bundle: frames, spectrum, ephemeris check', async ({ page }) => {
  const errors = watchConsole(page);
  await serveBundle(page);
  await page.goto(`/comet?lang=en&seq=${COMET_SID}`);
  await expect(page.getByTestId('comet-frame')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('comet-hud')).toContainText('Frame 1 of');
  await expect(page.getByTestId('mover-spectrum-plot')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('mover-ephemeris-check')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the WISE 0855 explorer shows the 16 year timeline from the bundle', async ({ page }) => {
  const errors = watchConsole(page);
  await serveBundle(page);
  await page.goto('/t/wise0855?play=0&lang=en');
  await expect(page.getByTestId('wise-timeline')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('wise-pmra')).toContainText('±');
  expect(errors).toEqual([]);
});

test('without a companion in the bundle the timeline is absent and nothing is probed', async ({ page }) => {
  const errors = watchConsole(page);
  const probed: string[] = [];
  page.on('request', (r) => /\/demo\/wise\/[0-9a-f]{16}/.test(r.url()) && probed.push(r.url()));
  await serveBundle(page, { wise: false });
  await page.goto('/t/wise0855?play=0&lang=en');
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('wise-timeline')).toHaveCount(0);
  expect(probed).toEqual([]);
  expect(errors).toEqual([]);
});
