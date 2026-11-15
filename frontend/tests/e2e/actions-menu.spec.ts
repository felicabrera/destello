// Overflow menu of the explorer actions: keyboard operation (open, reach an item, Escape, focus return).
import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

test('the actions menu opens with Enter, reaches both items and Escape returns focus to the opener', async ({
  page,
}) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const more = page.getByTestId('actions-more');
  await expect(more).toHaveAccessibleName('More actions');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('results-btn')).toHaveCount(0);
  await expect(page.getByTestId('report-btn')).toHaveCount(0);

  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('results-btn')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('report-btn')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByTestId('results-btn')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('actions-menu')).toHaveCount(0);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
});

test('an outside click closes the actions menu', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('actions-more').click();
  await expect(page.getByTestId('actions-menu')).toBeVisible();
  await page.mouse.click(5, 300);
  await expect(page.getByTestId('actions-menu')).toHaveCount(0);
});
