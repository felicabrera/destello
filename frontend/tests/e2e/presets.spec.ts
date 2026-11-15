import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Specs assert fixture data; force fixtures even when the real backend is listening.
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

// These specs run against the dev fixtures until the real backend answers /api/v1/health.
const PRESETS = ['barnard', 'wise0855', 'epsindib', 'rwaur', 'rdra'] as const;

async function ready(page: Page) {
  // The first paint waits for the dev server's on-demand compilation, which can take several seconds with
  // parallel workers. The 4 s budget of the product is measured on the production build (acceptance step 1).
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

for (const id of PRESETS) {
  test(`preset ${id} loads, has HUD, result card and info`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/t/${id}?play=0&tab=info`);
    await ready(page);
    await expect(page.getByTestId('epoch-chip')).toContainText('MJD');
    await expect(page.getByTestId('scale-bar')).toBeVisible();
    await expect(page.getByTestId('result-card')).toBeVisible();
    await expect(page.getByTestId('info-panel')).toContainText('spherex_qr3');
    expect(errors).toEqual([]);
  });
}

test('first visit shows hero and autoplays Barnard unless reduced motion', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('hero')).toBeVisible();
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Pause/, { timeout: 20_000 });
});

test('reduced motion does not autoplay', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
  const page = await ctx.newPage();
  await page.goto('/t/barnard');
  await ready(page);
  await expect(page.getByTestId('rm-play')).toBeVisible();
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
  await ctx.close();
});

test('keyboard: arrows step epochs, mode and overlay shortcuts, help dialog', async ({ page }) => {
  await page.goto('/t/wise0855?play=0');
  await ready(page);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/frame=2/);
  await page.keyboard.press('g');
  await expect(page).toHaveURL(/ov=gaia/);
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('F-13: flagged fraction always visible; flags overlay shows a legend with header flag names', async ({
  page,
}) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  // Visible without the overlay.
  await expect(page.getByTestId('epoch-chip-flagged')).toContainText(/Flagged pixels \d+\.\d%/);
  await expect(page.getByTestId('flags-legend')).toHaveCount(0);
  const toggle = page.getByTestId('ov-flags');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('f');
  await expect(page).toHaveURL(/ov=[^&]*flags/);
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  const legend = page.getByTestId('flags-legend');
  await expect(legend).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-describedby', 'flags-legend');
  await expect(page.getByTestId('flags-legend-names')).toContainText('HOT');
  await expect(legend).toContainText(/\d+\.\d%/);
  // Keyboard: the switch turns the overlay and its legend off again.
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('flags-legend')).toHaveCount(0);
  await expect(page.getByTestId('epoch-chip-flagged')).toBeVisible();
  // Spanish copy.
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('epoch-chip-flagged')).toContainText(/Píxeles marcados \d+,\d\s?%/);
});

test('shortcuts are disabled while typing in search', async ({ page }) => {
  await page.goto('/t/wise0855?play=0');
  await ready(page);
  await page.getByTestId('search-input').fill('gdg');
  await expect(page).not.toHaveURL(/ov=/);
});

test('difference mode shows legend with symbols and scale factor', async ({ page }) => {
  await page.goto('/t/barnard?play=0&mode=diff&frame=2');
  await expect(page.getByTestId('diff-legend')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('diff-legend')).toContainText('▲');
  await expect(page.getByTestId('diff-scale')).toBeVisible();
});

test('language switch keeps state', async ({ page }) => {
  await page.goto('/t/wise0855?det=4&frame=2&play=0');
  await ready(page);
  await page.getByTestId('lang-toggle').click();
  await expect(page).toHaveURL(/lang=es/);
  await expect(page).toHaveURL(/det=4/);
  await expect(page).toHaveURL(/frame=2/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
});

test('coordinate search parses and opens a built view with progress', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('search-input').fill('08 55 10.831 -7 14 42.53');
  await expect(page.getByTestId('coords-preview')).toContainText('133.79513');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/ra=133\.7951\d*&dec=-7\.2451\d*/);
});

test('invalid declination shows a localized error', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('search-input').fill('10 -95');
  await expect(page.getByTestId('coords-error')).toContainText('Dec must be between -90 and +90');
});

test('Spanish alias opens the preset without the resolver', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('search-input').fill('estrella de barnard');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/t\/barnard/);
});

test('system states: no data and rate limit', async ({ page }) => {
  await page.goto('/?ra=318.5&dec=-63.33333');
  await expect(page.getByTestId('state-nodata')).toBeVisible({ timeout: 20_000 });
  await page.goto('/?ra=10&dec=10&fx=rate');
  await expect(page.getByTestId('state-rate')).toBeVisible({ timeout: 20_000 });
});

test('custom coordinates show staged build progress and become playable', async ({ page }) => {
  await page.goto('/?ra=200&dec=20&play=0');
  await expect(page.getByTestId('build-progress')).toBeVisible();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 30_000 });
});

test('progressive build: the requested detector is viewable before the build completes', async ({ page }) => {
  await page.goto('/?ra=200&dec=20&play=0&det=4');
  await expect(page.getByTestId('build-progress')).toBeVisible();
  // The requested detector is published first and is playable while the other detectors build.
  await expect(page.getByTestId('build-detector-4')).toHaveAttribute('data-ready', 'true', {
    timeout: 15_000,
  });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId('build-progress')).toBeVisible();
  // No fallback note: the detector on screen is the selected one.
  await expect(page.getByTestId('build-shown-detector')).toHaveCount(0);
  await expect(page.getByTestId('build-progress')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled();
});

test('progressive build: broadband selection shows the first published detector meanwhile', async ({
  page,
}) => {
  await page.goto('/?ra=200&dec=20&play=0&det=all');
  await expect(page.getByTestId('build-shown-detector')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId('build-progress')).toHaveCount(0, { timeout: 30_000 });
});

test('a running build stays listed in the header and reopens with one click', async ({ page }) => {
  await page.goto('/?ra=200&dec=20&play=0');
  await expect(page.getByTestId('build-progress')).toBeVisible();
  // Not listed while its own progress is on screen.
  await expect(page.getByTestId('builds-indicator')).toHaveCount(0);
  await page.getByRole('link', { name: 'About' }).first().click();
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  const indicator = page.getByTestId('builds-indicator');
  await expect(indicator).toHaveAttribute('data-running', '1');
  await indicator.click();
  await expect(page.getByTestId('builds-item')).toHaveCount(1);
  await page.getByTestId('builds-open').click();
  await expect(page).toHaveURL(/ra=200/);
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 30_000 });
  // Finished and seen: nothing left to point at.
  await expect(page.getByTestId('build-progress')).toHaveCount(0, { timeout: 30_000 });
  await page.getByRole('link', { name: 'About' }).first().click();
  await expect(page.getByTestId('builds-indicator')).toHaveCount(0);
});

test('a build that finishes while another page is open is listed as ready', async ({ page }) => {
  await page.goto('/?ra=200&dec=20&play=0');
  await expect(page.getByTestId('build-progress')).toBeVisible();
  await page.getByRole('link', { name: 'About' }).first().click();
  const indicator = page.getByTestId('builds-indicator');
  await expect(indicator).toHaveAttribute('data-running', '0', { timeout: 30_000 });
  await indicator.click();
  await expect(page.getByTestId('builds-item')).toHaveAttribute('data-state', 'ready');
  await page.getByTestId('builds-open').click();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('builds-indicator')).toHaveCount(0);
});

test('embed renders chromeless player', async ({ page }) => {
  await page.goto('/embed?target=barnard&play=0&lang=es');
  await expect(page.getByTestId('embed')).toBeVisible();
  await expect(page.getByTestId('header')).toHaveCount(0);
});

test('release selector lists collections, defaults to all releases and writes the URL', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('data-options-toggle').click();
  const select = page.getByTestId('release-input');
  await expect(select).toHaveValue('all');
  await expect(select.locator('option')).toHaveCount(3);
  await select.selectOption('spherex_dr1');
  await expect(page).toHaveURL(/release=spherex_dr1/);
  await select.selectOption('all');
  await expect(page).not.toHaveURL(/release=/);
});

test('field of view menu shows images, transfer size and time before building', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('data-options-toggle').click();
  await page.getByTestId('fov-button').click();
  await expect(page.getByTestId('fov-select')).toContainText(/MB/);
});

test('the R Draconis card says the object could not be measured', async ({ page }) => {
  await page.goto('/t/rdra?play=0');
  await ready(page);
  await expect(page.getByTestId('result-none')).toContainText('could not measure');
});

test('a dismissed propagation notice stays dismissed on the next preset in the session', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  const notice = page.getByTestId('propagation-notice');
  await expect(notice).toBeVisible();
  await notice.getByRole('button').click();
  await expect(notice).toHaveCount(0);
  await page.goto('/t/wise0855?play=0');
  await ready(page);
  await expect(notice).toHaveCount(0);
});
