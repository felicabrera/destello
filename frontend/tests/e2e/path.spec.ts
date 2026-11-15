import { expect, test } from '@playwright/test';

// F-27 predicted path and parallax ellipse. Fixture mode: the build is a DEV FIXTURE (linear motion and a
// synthetic loop); the real computation is covered by the backend tests.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

test('F-27: the path layer is in the URL, keyboard operable and explained', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/barnard?play=0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const sw = page.getByTestId('ov-path');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  // P toggles the layer.
  await page.locator('body').press('p');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/[?&]ov=path(&|$)/);
  const legend = page.getByTestId('path-legend');
  await expect(legend).toBeVisible({ timeout: 20_000 });
  await expect(legend).toContainText('J2000.0');
  await expect(sw).toHaveAccessibleDescription(/Predicted path/);
  // The fixture target has no catalog parallax: no ellipse, and the legend says so.
  await expect(page.getByTestId('path-no-parallax')).toBeVisible();
  await page.locator('body').press('p');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(legend).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F-27: a field with a catalog parallax shows the ellipse with its size', async ({ page }) => {
  await page.goto('/?pick=kapteyn&play=0&ov=path&lang=es');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const ell = page.getByTestId('path-ellipse');
  await expect(ell).toBeVisible({ timeout: 20_000 });
  await expect(ell).toContainText('semieje mayor');
  await expect(ell).toContainText('segundos de arco');
});

test('F-27: a target without proper motion keeps the switch focusable but off', async ({ page }) => {
  await page.goto('/t/rdra?play=0&ov=path');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const sw = page.getByTestId('ov-path');
  await expect(sw).toHaveAttribute('aria-disabled', 'true');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).toHaveAccessibleDescription(/proper motion/);
  await sw.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('path-legend')).toHaveCount(0);
});

test('F-27: demo mode explains that the path needs the live server', async ({ page }) => {
  await page.goto('/t/barnard?play=0&fx=demo');
  const sw = page.getByTestId('ov-path');
  await expect(sw).toHaveAttribute('aria-disabled', 'true', { timeout: 20_000 });
  await expect(sw).toHaveAccessibleDescription(/live server/);
});
