import { expect, test } from '@playwright/test';

// F-28 "Surprise me". Fixture mode: the build is a DEV FIXTURE, the field list and its catalog astrometry are real.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

test('F-28: Surprise me opens a curated field with its reason and catalog epoch', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/barnard?play=0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const btn = page.getByTestId('surprise-btn');
  await expect(btn).toHaveAccessibleName('Surprise me');
  // Keyboard operable.
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/[?&]pick=[a-z0-9]+/);
  const card = page.getByTestId('surprise-card');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('surprise-catalog')).toContainText(/reference epoch J20(00|16)\.0/);
  const first = new URL(page.url()).searchParams.get('pick');
  await page.getByTestId('surprise-another').click();
  await expect(page).not.toHaveURL(new RegExp(`pick=${first}(&|$)`));
  await expect(page).toHaveURL(/[?&]pick=[a-z0-9]+/);
  expect(errors).toEqual([]);
});

test('F-28: a picked field reads its position from the catalog and plays', async ({ page }) => {
  await page.goto('/?pick=kapteyn&play=0&lang=es');
  await expect(page.getByTestId('surprise-card')).toContainText('Estrella de Kapteyn');
  await expect(page.getByTestId('surprise-catalog')).toContainText('Gaia DR3 4810594479418041856');
  await expect(page.getByTestId('surprise-catalog')).toContainText('J2016.0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
});

test('F-28: no coverage for a picked field shows the no data card', async ({ page }) => {
  await page.goto('/?pick=proxima&fx=nodata');
  await expect(page.getByTestId('state-nodata')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('surprise-card')).toBeVisible();
});

test('F-28: unknown picks are ignored', async ({ page }) => {
  await page.goto('/?pick=nowhere');
  await expect(page.getByTestId('hero')).toBeVisible();
  await expect(page.getByTestId('surprise-card')).toHaveCount(0);
});

test('F-28: demo mode keeps the button focusable and explains why it is off', async ({ page }) => {
  await page.goto('/t/rdra?play=0&fx=demo');
  const btn = page.getByTestId('surprise-btn');
  await expect(btn).toHaveAttribute('aria-disabled', 'true', { timeout: 20_000 });
  await expect(btn).toHaveAccessibleName('Surprise me');
  await expect(btn).toHaveAccessibleDescription(/live server/);
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/pick=/);
});
