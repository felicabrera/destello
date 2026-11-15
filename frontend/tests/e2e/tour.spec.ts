import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// F-24 guided tour on a first visit. The shared config marks the tour as seen for every other spec; this file
// starts from an empty browser state so the tour opens by itself.
test.use({ storageState: { cookies: [], origins: [] } });

const TOTAL = 9;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function tourOpen(page: Page) {
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('tour-card')).toBeVisible({ timeout: 20_000 });
}

async function seenFlag(page: Page) {
  return page.evaluate(() => localStorage.getItem('destello.tourSeen'));
}

/** Walks every step and checks that the card stays inside the viewport without horizontal page scroll. */
async function walk(page: Page, width: number) {
  for (let i = 1; i <= TOTAL; i++) {
    await expect(page.getByTestId('tour-count')).toHaveText(`${i} of ${TOTAL}`);
    const box = await page.getByTestId('tour-card').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('tour-skip')).toBeVisible();
    if (i < TOTAL) await page.getByTestId('tour-next').click();
  }
  await expect(page.getByTestId('tour-next')).toHaveText('Finish');
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
}

test('opens on the first visit with a labelled dialog, Next and Back, and never starts playback', async ({
  page,
}) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await tourOpen(page);
  const dialog = page.getByRole('dialog', { name: 'The blink player' });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('tour-count')).toHaveText(`1 of ${TOTAL}`);
  await expect(page.getByTestId('tour-spotlight')).toBeVisible();
  await expect(page.getByTestId('tour-next')).toBeFocused();
  await expect(page.getByTestId('tour-back')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tour-count')).toHaveText(`2 of ${TOTAL}`);
  await expect(page.getByRole('dialog', { name: 'Choose a sky position' })).toBeVisible();
  await page.getByTestId('tour-back').click();
  await expect(page.getByTestId('tour-count')).toHaveText(`1 of ${TOTAL}`);
  // Focus stays inside the tour while it is open.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="tour-card"]'))).toBe(
      true,
    );
  }
  // Space and arrows do not reach the player while the tour is open.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tour-count')).toHaveText(`1 of ${TOTAL}`);
  await expect(page.getByTestId('btn-play')).toHaveAttribute('aria-label', 'Play');
  expect(await seenFlag(page)).toBeNull();
});

test('Skip hides the tour and it stays hidden after a reload', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await tourOpen(page);
  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  expect(await seenFlag(page)).toBe('1');
  await page.reload();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  // Another target page in the same browser does not show it either.
  await page.goto('/t/epsindib?play=0&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
});

test('Escape closes the tour and counts as skipped', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await tourOpen(page);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  expect(await seenFlag(page)).toBe('1');
  await page.reload();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
});

test('the header replays the tour and focus returns to it afterwards', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/t/barnard?play=0&lang=en');
  await tourOpen(page);
  await walk(page, 1280);
  expect(await seenFlag(page)).toBe('1');
  await page.getByTestId('more-toggle').click();
  const replay = page.getByTestId('tour-replay-menu');
  await expect(replay).toHaveText('Guided tour');
  await replay.click();
  await expect(page.getByTestId('tour-count')).toHaveText(`1 of ${TOTAL}`);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  await expect(page.getByTestId('more-toggle')).toBeFocused();
});

test('works at 768 px and in Spanish', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/t/barnard?play=0&lang=es');
  await tourOpen(page);
  await expect(page.getByRole('dialog', { name: 'El reproductor de parpadeo' })).toBeVisible();
  await expect(page.getByTestId('tour-skip')).toHaveText('Omitir recorrido');
  await expect(page.getByTestId('tour-count')).toHaveText(`1 de ${TOTAL}`);
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  // Below the wide layout the replay sits in the menu.
  await page.getByTestId('menu-toggle').click();
  await page.getByTestId('tour-replay-menu').click();
  await expect(page.getByTestId('tour-count')).toHaveText(`1 de ${TOTAL}`);
});

test.describe('phone', () => {
  test.use({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
  test('every step fits a 360 px screen and the menu replays the tour', async ({ page }) => {
    await page.goto('/t/barnard?play=0&lang=en');
    await tourOpen(page);
    await walk(page, 360);
    await page.getByTestId('menu-toggle').click();
    await page.getByTestId('tour-replay-menu').click();
    await expect(page.getByTestId('tour-count')).toHaveText(`1 of ${TOTAL}`);
    await page.getByTestId('tour-skip').click();
    await expect(page.getByTestId('tour-card')).toHaveCount(0);
  });
});

for (const lang of ['en', 'es']) {
  test(`axe on the open tour (${lang})`, async ({ page }) => {
    await page.goto(`/t/barnard?play=0&lang=${lang}`);
    await tourOpen(page);
    // Audit once the player has finished loading, as a11y.spec.ts does: the Play button changes color when enabled.
    await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(300);
      const r = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .exclude('[data-testid="aladin-host"]')
        .analyze();
      const summary = r.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
      );
      expect(summary).toEqual([]);
      await page.getByTestId('tour-next').click();
    }
  });
}

test('reduced motion: the tour opens without starting playback', async ({ browser }) => {
  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    storageState: { cookies: [], origins: [] },
  });
  await ctx.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
  const page = await ctx.newPage();
  await page.goto('/t/barnard?lang=en');
  await tourOpen(page);
  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-next').click();
  await page.waitForTimeout(1000);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
  await ctx.close();
});

test('never opens in the embed player', async ({ page }) => {
  await page.goto('/embed?target=barnard&play=0&controls=full&lang=en');
  await expect(page.getByTestId('embed')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  expect(await seenFlag(page)).toBeNull();
});

test('with storage blocked the tour still opens once and closes cleanly', async ({ page }) => {
  await page.addInitScript(() => {
    // Every read and write of the tour flag throws, in both storages; other keys keep working.
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (this: Storage, k: string) {
      if (k === 'destello.tourSeen') throw new DOMException('blocked', 'SecurityError');
      return get.call(this, k);
    };
    Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
      if (k === 'destello.tourSeen') throw new DOMException('blocked', 'SecurityError');
      set.call(this, k, v);
    };
  });
  await page.goto('/t/barnard?play=0&lang=en');
  await tourOpen(page);
  await page.getByTestId('tour-skip').click();
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
  // Moving to another target in the same page load does not reopen it.
  await page.getByTestId('preset-chips').getByRole('button').nth(1).click();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('tour-card')).toHaveCount(0);
});
