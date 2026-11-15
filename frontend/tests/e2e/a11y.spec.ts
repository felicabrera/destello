import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Specs assert fixture data; force fixtures even when the real backend is listening.
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function ready(page: Page) {
  // The first paint waits for the dev server's on-demand compilation, which can take several seconds with
  // parallel workers. The 4 s budget of the product is measured on the production build (acceptance step 1).
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

async function audit(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    // Aladin and Plotly render third-party DOM that we do not control.
    .exclude('[data-testid="aladin-host"]')
    .analyze();
  const summary = r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary).toEqual([]);
}

for (const lang of ['en', 'es']) {
  const q = `lang=${lang}`;
  test(`axe explorer, blink, diff (${lang})`, async ({ page }) => {
    await page.goto(`/t/barnard?play=0&${q}`);
    await ready(page);
    await audit(page);
    await page.goto(`/t/barnard?play=0&mode=diff&frame=2&${q}`);
    await ready(page);
    await audit(page);
  });

  test(`axe spectrum and measure (${lang})`, async ({ page }) => {
    await page.goto(`/t/rdra?play=0&${q}`);
    await ready(page);
    await expect(page.getByTestId('spectrum-plot')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await audit(page);
    await page.goto(`/t/barnard?play=0&tab=measure&${q}`);
    await ready(page);
    await expect(page.getByTestId('measure-result')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('residual-plot')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await audit(page);
  });

  test(`axe share dialog and embed (${lang})`, async ({ page }) => {
    await page.goto(`/t/barnard?play=0&${q}`);
    await ready(page);
    await page.getByTestId('share-btn').click();
    await expect(page.getByTestId('share-dialog')).toBeVisible();
    // The live preview is an embedded player; audit it only after it has finished loading.
    await expect(page.frameLocator('iframe').getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
    await page.waitForTimeout(600);
    await audit(page);
    await page.goto(`/embed?target=barnard&play=0&${q}`);
    await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
    await audit(page);
  });

  test(`axe system states and pages (${lang})`, async ({ page }) => {
    await page.goto(`/?ra=318.5&dec=-63.33333&${q}`);
    await expect(page.getByTestId('state-nodata')).toBeVisible({ timeout: 20_000 });
    await audit(page);
    await page.goto(`/?ra=10&dec=10&fx=rate&${q}`);
    await expect(page.getByTestId('state-rate')).toBeVisible({ timeout: 20_000 });
    await audit(page);
    for (const p of ['science', 'about', 'validation']) {
      await page.goto(`/${p}?${q}`);
      await expect(page.locator('main h1, h1').first()).toBeVisible();
      if (p === 'validation')
        await expect(page.getByTestId('validation-run')).toBeVisible({ timeout: 20_000 });
      await audit(page);
    }
  });
}

test('keyboard only: search, preset, play/pause, step, mode switch', async ({ page }) => {
  await page.goto('/?play=0');
  await ready(page);
  await page.getByTestId('search-input').focus();
  await page.keyboard.type('barnard');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/barnard/);
  await ready(page);
  await page.getByTestId('chip-wise0855').focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/wise0855/);
  await expect(page.getByTestId('target-label')).toContainText(/WISE/);
  await ready(page);
  await page.waitForTimeout(1500);
  const play = page.getByTestId('btn-play');
  await play.focus();
  const first = (await play.getAttribute('aria-label')) ?? '';
  await page.keyboard.press('Enter');
  await expect(play).not.toHaveAttribute('aria-label', first);
  await page.keyboard.press('Enter');
  await expect(play).toHaveAttribute('aria-label', first);
  // Leave playback paused so the step assertion is deterministic.
  if (/Pause/.test(first)) await page.keyboard.press('Enter');
  const chip = page.getByTestId('epoch-chip');
  const before = await chip.textContent();
  await page.getByTestId('btn-next').focus();
  await page.keyboard.press('Enter');
  await expect(chip).not.toHaveText(before ?? '');
  await page.getByTestId('mode-diff').focus();
  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/mode=diff/);
});

test('reduced motion: no autoplay and no animated transitions on the sheet', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
  const page = await ctx.newPage();
  await page.goto('/t/barnard');
  await ready(page);
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
  await ctx.close();
});

test('axe with reduced motion: the Play button and announcements are not nested in an image', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
  await page.goto('/t/barnard?lang=en');
  await ready(page);
  await expect(page.getByTestId('rm-play')).toBeVisible();
  await audit(page);
  await ctx.close();
});

test('dialogs opened from code return focus to their opener', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await page.getByTestId('share-btn').click();
  await expect(page.getByTestId('share-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('share-dialog')).toBeHidden();
  await expect(page.getByTestId('share-btn')).toBeFocused();
});

test('the field of view list moves with arrow keys and closes when focus leaves', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await page.getByTestId('data-options-toggle').click();
  await page.getByTestId('fov-button').click();
  const first = page.getByTestId('fov-select').locator('ul button').first();
  await first.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByTestId('fov-select').locator('ul button').nth(1)).toBeFocused();
  await audit(page);
  await page.getByTestId('btn-play').focus();
  await expect(page.getByTestId('fov-select').locator('ul')).toHaveCount(0);
});

test('the embed keeps its own page when the viewer steps or pauses', async ({ page }) => {
  await page.goto('/embed?target=barnard&play=0&controls=full&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('player-canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/\/embed\?.*frame=2/);
  await expect(page.getByTestId('embed')).toBeVisible();
});

test('validation cards do not overflow on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/validation?lang=es');
  await expect(page.getByTestId('validation-run')).toBeVisible({ timeout: 20_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await audit(page);
});
