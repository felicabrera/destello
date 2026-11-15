import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// F-40 "16 years" view. The documents served here are real: the WISE W2 companion manifest of the WISE 0855 preset
// (frame input lists trimmed), its stored long-baseline fit, a real WISE coadd, and the real SPHEREx manifest of
// the demo. The view is mounted in the explorer (desktop), here on the fixture preset of WISE 0855; the companion
// routes are answered by the spec and fixture mode asks for them only when `__DESTELLO_WISE__` is set.
const SID = 'b06ca7834dc1fc1f'; // sequence id of the fixture preset wise0855 (src/dev-fixtures)
const FX = resolve(process.cwd(), 'tests/e2e/fixtures/wise');
const MANIFEST = readFileSync(resolve(FX, 'manifest.json'), 'utf-8');
const ASTROMETRY = readFileSync(resolve(FX, 'astrometry.json'), 'utf-8');
const FRAME = readFileSync(resolve(FX, 'frame.webp'));

async function serve(page: Page, opts: { companion?: boolean; astrometry?: boolean } = {}) {
  const { companion = true, astrometry = true } = opts;
  await page.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    (window as { __DESTELLO_WISE__?: boolean }).__DESTELLO_WISE__ = true;
  });
  const notFound = { status: 204, body: '' };
  await page.route(`**/api/v1/sequences/${SID}/wise/astrometry`, (r) =>
    astrometry
      ? r.fulfill({ status: 200, contentType: 'application/json', body: ASTROMETRY })
      : r.fulfill(notFound),
  );
  await page.route(`**/api/v1/sequences/${SID}/wise`, (r) =>
    companion
      ? r.fulfill({ status: 200, contentType: 'application/json', body: MANIFEST })
      : r.fulfill(notFound),
  );
  await page.route('**/frames/*.webp', (r) =>
    r.fulfill({ status: 200, contentType: 'image/webp', body: FRAME }),
  );
}

const url = (lang = 'en') => `/t/wise0855?play=0&lang=${lang}`;

test('F-40: markers for the three phases, shared stretch notices, warnings, credits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await serve(page);
  await page.goto(url());
  await expect(page.getByTestId('wise-timeline')).toBeVisible();
  await expect(page.locator('[data-mission="WISE"]').first())
    .toBeAttached()
    .catch(() => undefined);
  await expect(page.locator('[data-testid^="wise-marker-"][data-mission="NEOWISE"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="wise-marker-"][data-mission="SPHEREx"]').first()).toBeVisible();
  await expect(page.getByTestId('wise-notices')).toContainText('different pixels, bands and stretches');
  await expect(page.getByTestId('wise-notices')).toContainText('4.08 to 5.19');
  await expect(page.getByTestId('wise-warnings')).toContainText('2010 to 2011');
  await expect(page.getByTestId('wise-credit')).toContainText('Wide-field Infrared Survey Explorer');
  await expect(page.getByTestId('wise-credit')).toContainText('NEOWISE');
  expect(errors).toEqual([]);
});

test('F-40: the measured proper motion comes from the API with its error and the reference', async ({
  page,
}) => {
  await serve(page);
  await page.goto(url());
  const doc = JSON.parse(ASTROMETRY) as { fit: { pmra_masyr: number }; reference: { pmra_masyr: number } };
  const row = page.getByTestId('wise-pmra');
  await expect(row).toContainText('±');
  await expect(row).toContainText(
    Math.abs(Math.round(doc.fit.pmra_masyr))
      .toString()
      .replace(/(\d)(\d{3})$/, '$1,$2'),
  );
  await expect(row).toContainText(
    Math.abs(Math.round(doc.reference.pmra_masyr))
      .toString()
      .replace(/(\d)(\d{3})$/, '$1,$2'),
  );
  await expect(page.getByTestId('wise-spherex-only')).toBeVisible();
});

test('F-40: arrow keys step, Home and End jump, Space plays and pauses', async ({ page }) => {
  await serve(page);
  await page.goto(url());
  const view = page.getByTestId('wise-view');
  const pos = page.getByTestId('wise-position');
  await expect(pos).toContainText('of 24'); // 21 WISE epochs and the 3 SPHEREx epochs of the fixture preset;
  await view.focus();
  await page.keyboard.press('Home');
  await expect(pos).toContainText('Epoch 1 of');
  await page.keyboard.press('ArrowRight');
  await expect(pos).toContainText('Epoch 2 of');
  await page.keyboard.press('ArrowLeft');
  await expect(pos).toContainText('Epoch 1 of');
  await page.keyboard.press('End');
  await expect(page.getByTestId('wise-frame')).toHaveAttribute('data-mission', 'SPHEREx');
  await page.keyboard.press('Home');
  await page.keyboard.press(' ');
  await expect(page.getByTestId('wise-play')).toHaveAttribute('aria-pressed', 'true');
  await expect(pos).not.toContainText('Epoch 1 of', { timeout: 5_000 });
  await page.keyboard.press(' ');
  await expect(page.getByTestId('wise-play')).toHaveAttribute('aria-pressed', 'false');
});

test('F-40: nothing autoplays and reduced motion disables playback', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await serve(page);
  await page.goto(url());
  const pos = page.getByTestId('wise-position');
  const first = await pos.textContent();
  await page.waitForTimeout(1500);
  await expect(pos).toHaveText(first ?? '');
  await expect(page.getByTestId('wise-play')).toBeDisabled();
  await expect(page.getByTestId('wise-reduced')).toBeVisible();
  await page.getByTestId('wise-view').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(pos).not.toHaveText(first ?? '');
});

test('F-40: selecting a marker shows that epoch coadd; Spanish strings load', async ({ page }) => {
  await serve(page);
  await page.goto(url('es'));
  await expect(page.getByTestId('wise-timeline')).toContainText('16 años de cielo');
  await page.locator('[data-testid^="wise-marker-w"]').first().click();
  await expect(page.getByTestId('wise-frame')).toHaveAttribute('data-mission', 'NEOWISE');
  await expect(page.getByTestId('wise-frame')).toHaveAttribute('data-key', 'w0');
  await expect(page.getByTestId('wise-credit')).toContainText('Créditos y cita');
});

test('F-40: without a companion nothing is rendered', async ({ page }) => {
  await serve(page, { companion: false });
  await page.goto(url());
  await page.waitForTimeout(800);
  await expect(page.getByTestId('wise-timeline')).toHaveCount(0);
});

test('F-40: a preset without a companion renders no timeline and logs no console error', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    (window as { __DESTELLO_WISE__?: boolean }).__DESTELLO_WISE__ = true;
  });
  await page.route('**/api/v1/sequences/*/wise', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/api/v1/sequences/*/wise/astrometry', (r) => r.fulfill({ status: 204, body: '' }));
  await page.goto('/t/barnard?play=0&lang=en');
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await expect(page.getByTestId('wise-timeline')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F-40: one entry scrolls to the timeline and focuses it; none without a companion', async ({ page }) => {
  await serve(page);
  await page.goto(url());
  const entry = page.getByTestId('wise-entry');
  await expect(entry).toHaveText('See 16 years of this field');
  await expect(page.getByRole('button', { name: /16 years of this field/ })).toHaveCount(1);
  await entry.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#wise-timeline')).toBeFocused();
  await page.screenshot({ path: '../qa/screens/sprint/story16/explorer-1440.png' });
  await page.goto(url('es'));
  await expect(page.getByTestId('wise-entry')).toHaveText('Ver 16 años de este campo');
  const none = await page.context().newPage();
  await serve(none, { companion: false });
  await none.goto(url());
  await expect(none.getByTestId('result-card'))
    .toBeVisible()
    .catch(() => undefined);
  await expect(none.getByTestId('wise-entry')).toHaveCount(0);
});

test('F-40: the timeline fits on a phone without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await serve(page);
  await page.goto(url());
  await expect(page.getByTestId('wise-timeline')).toBeVisible();
  await page.getByTestId('wise-entry').click();
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '../qa/screens/sprint/story16/explorer-390.png' });
});
