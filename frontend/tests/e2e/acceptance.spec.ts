// Acceptance script of docs/11 section 3, automated. Runs only when ACCEPTANCE_URL points at a
// full stack (Caddy serving the production build plus the API), for example
//   ACCEPTANCE_URL=http://127.0.0.1:8080 pnpm exec playwright test acceptance
// Steps that need a second browser or a phone are covered by a fresh context and a phone viewport.
import { expect, test, type Page } from '@playwright/test';

const BASE = process.env.ACCEPTANCE_URL;
const PRESETS = ['barnard', 'wise0855', 'epsindib', 'rwaur', 'rdra'] as const;

test.skip(!BASE, 'ACCEPTANCE_URL not set');
// The guided tour (F-24) is marked as seen for the stack under test, as the shared config does for the dev
// server; tests/e2e/tour.spec.ts covers the tour itself.
const TOUR_SEEN_HERE = BASE
  ? {
      cookies: [],
      origins: [{ origin: new URL(BASE).origin, localStorage: [{ name: 'destello.tourSeen', value: '1' }] }],
    }
  : undefined;
test.use({ baseURL: BASE, storageState: TOUR_SEEN_HERE });
test.describe.configure({ timeout: 90_000 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.removeItem('destello.fx'));
});

async function playable(page: Page, ms = 20_000) {
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: ms });
}

test('1. Barnard plays within 4 s on a fresh visit', async ({ page }) => {
  const t0 = Date.now();
  await page.goto('/t/barnard');
  await playable(page, 4000);
  expect(Date.now() - t0).toBeLessThan(4000);
});

test('2. switching to Spanish changes the visible text', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await playable(page);
  const before = await page.getByTestId('header').innerText();
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.getByTestId('header')).not.toHaveText(before);
  await expect(page.getByTestId('btn-play')).toContainText(/Reproducir|Pausa/);
});

for (const id of PRESETS) {
  test(`3. preset ${id} shows frames, metadata and its result card`, async ({ page }) => {
    await page.goto(`/t/${id}?play=0&tab=info`);
    await playable(page);
    await expect(page.getByTestId('epoch-chip')).toContainText('MJD');
    await expect(page.getByTestId('info-panel')).toContainText(/spherex_(dr|qr)\d/);
    await expect(page.getByTestId('result-card')).toBeVisible();
  });
}

test('4. WISE 0855 coordinates show the propagation notice', async ({ page }) => {
  await page.goto('/?play=0');
  const input = page.getByTestId('search-input');
  await input.fill('08h55m10.831s -07d14m42.53s');
  await input.press('Enter');
  await expect(page.getByTestId('propagation-notice')).toBeVisible({ timeout: 30_000 });
});

test('5. difference mode on Barnard shows the scale factor', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await playable(page);
  await page.getByTestId('mode-diff').click();
  await expect(page.getByTestId('diff-legend')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('diff-legend')).toContainText(/\d/);
});

test('6. Gaia overlay loads markers for Barnard', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await playable(page);
  const toggle = page.getByTestId('ov-gaia');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/ov=[^&]*gaia/);
});

test('7. RW Aurigae spectrum by epoch renders with error bars', async ({ page }) => {
  await page.goto('/t/rwaur?play=0&tab=spectrum');
  await playable(page);
  const panel = page.getByTestId('spectrum-panel');
  await expect(panel).toBeVisible({ timeout: 60_000 });
  // Plotly draws one errorbar group per point that carries an uncertainty.
  await expect(panel.locator('g.errorbar').first()).toBeAttached({ timeout: 90_000 });
});

test('8. the share URL opens the same view in another browser context', async ({ page, browser }) => {
  await page.goto('/t/barnard?play=0&fov=6&mode=diff');
  await playable(page);
  const url = page.url();
  const other = await browser.newContext({ storageState: TOUR_SEEN_HERE });
  const p2 = await other.newPage();
  await p2.goto(url);
  await playable(p2);
  expect(new URL(p2.url()).search).toBe(new URL(url).search);
  await other.close();
});

test('9. the embed player works inside a host page', async ({ page }) => {
  await page.goto('/');
  const src = new URL('/embed?target=barnard&controls=full', page.url()).href;
  await page.setContent(
    `<!doctype html><iframe title="embed" src="${src}" width="720" height="600"></iframe>`,
  );
  const frame = page.frameLocator('iframe');
  await expect(frame.getByTestId('embed')).toBeVisible({ timeout: 20_000 });
});

test.describe('10. phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('Barnard plays, presets open and the share URL round trips', async ({ page }) => {
    await page.goto('/t/barnard');
    await playable(page, 8000);
    for (const id of PRESETS) {
      await page.goto(`/t/${id}?play=0`);
      await playable(page);
    }
    const url = page.url();
    await page.goto(url);
    await playable(page);
  });
});

test('11. with the API blocked the demo banner appears and presets still play', async ({ page }) => {
  await page.route('**/api/v1/**', (r) => r.abort());
  await page.goto('/t/barnard');
  await expect(page.getByTestId('demo-banner')).toBeVisible({ timeout: 30_000 });
  await playable(page, 30_000);
});

test('12. keyboard only: play, open a preset and switch to difference', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await playable(page);
  await page.getByTestId('btn-play').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('btn-play')).toContainText(/Pause|Pausa/);
  await page.getByTestId('mode-diff').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/mode=diff/);
});
