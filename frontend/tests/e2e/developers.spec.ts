// F-36 /developers on the dev fixtures: endpoints from the OpenAPI document, embed, URL contract, rate limits,
// the docs/17 register, the credits, nav link, axe in EN and ES, and the 390 px layout.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
}

async function audit(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

test('the page lists endpoints from OpenAPI, embed, URL contract, limits, register and credits', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await page.goto('/developers?lang=en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Use Destello from code');
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByTestId('api-endpoints')).toBeVisible();
  await expect(page.getByTestId('api-endpoint').first()).toBeVisible();
  await expect(page.getByTestId('api-endpoints')).toContainText('/api/v1/sequences/{sid}/notebook');
  await expect(page.getByTestId('embed-code')).toContainText('/embed?target=barnard');
  await expect(page.getByTestId('url-params')).toContainText('blink, diff, diffseq, stack, rgb');
  await expect(page.getByTestId('rate-limits')).toContainText('120 per minute');
  await expect(page.getByTestId('resource')).toHaveCount(15);
  await expect(page.getByTestId('resources')).toContainText('not verified');
  await expect(page.getByTestId('developers')).toContainText('inspired by WiseView', { ignoreCase: true });
  await expect(page.getByTestId('developers')).toContainText('NEOSSat Data Tutorial');
  await expect(page.getByTestId('developers')).toContainText('SPHEREx Tutorial Notebooks');
  expect(errors).toEqual([]);
});

test('the header links to the page', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/about?lang=en');
  await page.getByTestId('more-toggle').click();
  await page.getByRole('navigation', { name: 'Destello' }).getByRole('link', { name: 'Developers' }).click();
  await expect(page).toHaveURL(/\/developers/);
});

for (const lang of ['en', 'es'] as const) {
  test(`axe clean in ${lang}`, async ({ page }) => {
    await setup(page);
    await page.goto(`/developers?lang=${lang}`);
    await expect(page.getByTestId('api-endpoints')).toBeVisible();
    await audit(page);
  });

  test(`no horizontal overflow at 390 px in ${lang}`, async ({ page }) => {
    await setup(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/developers?lang=${lang}`);
    await expect(page.getByTestId('api-endpoints')).toBeVisible();
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  });

  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    test(`screenshot ${lang} ${w}`, async ({ page }) => {
      await setup(page);
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/developers?lang=${lang}`);
      await expect(page.getByTestId('api-endpoints')).toBeVisible();
      await page.screenshot({
        path: `../qa/screens/sprint/developers/developers-${lang}-${w}.png`,
        fullPage: true,
      });
    });
  }
}
