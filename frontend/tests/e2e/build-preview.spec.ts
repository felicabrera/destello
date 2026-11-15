import { expect, test, type Page } from '@playwright/test';

// Dev fixtures simulate a server build for any position that is not a cached preset. fxSlow stretches the
// simulated build so the building state can be inspected without racing its timers.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    sessionStorage.setItem('destello.fxSlow', '3');
  });
});

const NEW_POSITION = '/?ra=150.1&dec=2.2&play=0';

async function finished(page: Page) {
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId('build-progress')).toHaveCount(0, { timeout: 30_000 });
}

test('a new position shows the labelled sky context until the first frames arrive', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => {
    // The Vite dev server has no /hips mirror (Caddy serves it): when CDS is unreachable, Aladin reports the
    // missing tiles or an unreachable HiPS root asynchronously. The sky map is third-party context; only
    // application errors fail the test.
    if (!/HiPS not found|does not points to a HiPS location|does not refer to a found CDS ID/.test(e.message))
      errors.push(e.message);
  });
  await page.goto(NEW_POSITION);
  const preview = page.getByTestId('build-sky-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('build-progress')).toBeVisible();
  await expect(page.getByTestId('build-sky-label')).toContainText('Not SPHEREx data');
  await expect(preview).toContainText('Sky at the requested position');
  await expect(page.getByTestId('player-canvas')).toHaveCount(0);
  // The survey selector stays keyboard operable.
  await page.getByTestId('survey-allwise').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('survey-allwise')).toHaveAttribute('aria-checked', 'true');
  // The player replaces the preview as soon as the first detector is published.
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 30_000 });
  await expect(preview).toHaveCount(0);
  await expect(page.getByTestId('build-progress')).toBeVisible();
  expect(errors).toEqual([]);
});

test('the preview label is translated', async ({ page }) => {
  await page.goto(`${NEW_POSITION}&lang=es`);
  await expect(page.getByTestId('build-sky-label')).toContainText('No son datos de SPHEREx');
});

test('a cached preset never loads the sky preview', async ({ page }) => {
  const sky: string[] = [];
  page.on('request', (r) => {
    if (/alasky|\/hips\//.test(r.url())) sky.push(r.url());
  });
  await page.goto('/t/barnard?play=0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('build-sky-preview')).toHaveCount(0);
  expect(sky).toEqual([]);
});

test('the share link is available during a build and matches the finished view', async ({ page }) => {
  await page.goto(NEW_POSITION);
  await expect(page.getByTestId('build-sky-preview')).toBeVisible();
  await page.getByTestId('share-btn').click();
  const dlg = page.getByTestId('share-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('share-building-note')).toContainText('still being built');
  const during = await dlg.locator('#share-link').inputValue();
  expect(during).toMatch(/ra=150\.1/);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);

  await finished(page);
  await page.getByTestId('share-btn').click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('share-building-note')).toHaveCount(0);
  expect(await dlg.locator('#share-link').inputValue()).toBe(during);
});

test('the building note is translated', async ({ page }) => {
  await page.goto(`${NEW_POSITION}&lang=es`);
  await expect(page.getByTestId('build-sky-preview')).toBeVisible();
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-building-note')).toContainText('todavía se está construyendo');
});
