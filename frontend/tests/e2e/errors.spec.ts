// Custom error pages on the dev fixtures: 404 in both languages, the 500 view for a render error,
// axe in both languages and the 390 px layout.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function audit(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(wide).toBe(false);
}

const TITLES = { en: 'Page not found', es: 'Página no encontrada' } as const;
const CRASH = { en: 'Something went wrong', es: 'Algo salió mal' } as const;

for (const lang of ['en', 'es'] as const) {
  test(`404 page, links and axe (${lang})`, async ({ page }) => {
    await page.goto(`/randomurl?lang=${lang}`);
    const view = page.getByTestId('not-found');
    await expect(view).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(TITLES[lang]);
    await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(page.getByTestId('header')).toBeVisible();
    await expect(page.getByTestId('not-found-path')).toHaveText('/randomurl');
    await expect(page).toHaveTitle(new RegExp(`^${TITLES[lang]}`));
    await expect(page.locator('meta[name="robots"][content="noindex, nofollow"]')).toHaveCount(1);
    await audit(page);

    const presets = page.getByTestId('not-found-presets').getByRole('link');
    await expect(presets.first()).toBeVisible();
    await presets.first().click();
    await expect(page).toHaveURL(/\/t\/[a-z]+/);
    await page.goBack();
    await page.getByTestId('error-home').click();
    await expect(page.getByTestId('not-found')).toHaveCount(0);
  });

  test(`404 page escapes the requested path (${lang})`, async ({ page }) => {
    await page.goto(`/%3Cimg%20src=x%20onerror=alert(1)%3E?lang=${lang}`);
    await expect(page.getByTestId('not-found')).toBeVisible();
    await expect(page.getByTestId('not-found').locator('img[src="x"]')).toHaveCount(0);
  });

  test(`render error shows the 500 page and axe is clean (${lang})`, async ({ page }) => {
    await page.goto(`/__crash?lang=${lang}`);
    await expect(page.getByTestId('unexpected-error')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(CRASH[lang]);
    await expect(page.getByTestId('header')).toBeVisible();
    await audit(page);
    await page.getByTestId('error-retry').click();
    await expect(page.getByTestId('unexpected-error')).toBeVisible();
    await page.getByTestId('error-home').click();
    await expect(page.getByTestId('unexpected-error')).toHaveCount(0);
  });

  test(`390 px layout has no horizontal overflow (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/randomurl-with-a-long-name-${'x'.repeat(200)}?lang=${lang}`);
    await expect(page.getByTestId('not-found')).toBeVisible();
    await noOverflow(page);
    await page.goto(`/__crash?lang=${lang}`);
    await expect(page.getByTestId('unexpected-error')).toBeVisible();
    await noOverflow(page);
  });
}

test('a failed lazy chunk shows the reload state', async ({ page }) => {
  await page.route(/StaticPages/, (route) => route.abort());
  await page.goto('/about?lang=en');
  await expect(page.getByTestId('chunk-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('error-reload')).toBeVisible();
});
