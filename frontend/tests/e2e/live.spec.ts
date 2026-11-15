// Runs against the real API through the dev proxy (docker compose api up). Skipped when the API is not reachable.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const PRESETS = ['barnard', 'wise0855', 'epsindib', 'rwaur', 'rdra'] as const;

test.beforeEach(async ({ page, request }) => {
  const up = await request.get('/api/v1/health').then(
    (r) => r.ok(),
    () => false,
  );
  test.skip(!up, 'real API not running');
  await page.addInitScript(() => sessionStorage.removeItem('destello.fx'));
});

for (const id of PRESETS) {
  test(`live preset ${id}: frame, autoplay, no unexpected console errors`, async ({ page }) => {
    const errors: string[] = [];
    // Spectrum and astrometry endpoints are built by the science block; their 404 is expected until then.
    page.on('response', (r) => {
      if (r.status() >= 400 && !/\/(spectrum|astrometry|validation)(\?|$)/.test(r.url()))
        errors.push(`${r.status()} ${r.url()}`);
    });
    // Warm the dev server first: its on-demand module compilation under parallel workers is not
    // what the budget measures. The 4 s fresh-visit requirement is enforced on the production build by
    // acceptance step 1 (tests/e2e/acceptance.spec.ts); here, on the unbundled dev server shared with the
    // other parallel workers, the limit only guards against a gross regression.
    await page.goto('/about');
    await expect(page.getByTestId('header')).toBeVisible({ timeout: 20_000 });
    const t0 = Date.now();
    await page.goto(`/t/${id}`);
    await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
    expect(Date.now() - t0).toBeLessThan(8000);
    await expect(page.getByTestId('btn-play')).toContainText(/Pause|Pausa/);
    const nonBlank = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const g = c?.getContext('2d');
      if (!c || !g) return false;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 97) s += d[i];
      return s > 0;
    });
    expect(nonBlank).toBe(true);
    expect(errors).toEqual([]);
  });
}

test('live: epsindib epoch 4 has no data in D1 and says so', async ({ page }) => {
  await page.goto('/t/epsindib?play=0&det=1&frame=4');
  // The note on the frame; the timeline node of that epoch also names it in its label and tooltip.
  await expect(page.getByTestId('missing-frame').getByText(/No data in this detector/i)).toBeVisible({
    timeout: 20_000,
  });
});

test('live: manifest and FITS links answer', async ({ page, request }) => {
  await page.goto('/t/barnard?play=0&det=5');
  const links = page.locator('a[href*="/manifests/"], a[href*="/frames/"][href$=".fits"]');
  await expect(links.first()).toBeVisible({ timeout: 20_000 });
  for (const href of await links.evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) {
    expect((await request.get(href)).status()).toBe(200);
  }
});

test('live: axe on Barnard explorer', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="aladin-host"]')
    .analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
});

test('live: unreachable name resolver shows a clear message with coordinates hint', async ({ page }) => {
  test.setTimeout(60_000);
  // Simulate the outage: the real name service may well be reachable from the test machine.
  await page.route('**/api/v1/resolve?**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/problem+json',
      body: JSON.stringify({ code: 'RESOLVER_UNAVAILABLE', title: 'Name resolver unavailable.' }),
    }),
  );
  await page.goto('/?lang=en');
  await page.getByTestId('search-input').fill('Betelgeuse');
  await page.getByTestId('search-input').press('Enter');
  await expect(page.getByTestId('resolver-down')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('resolver-down')).toContainText(/coordinates/i);
});
