// F-34 Story mode on the dev fixtures: chapter navigation by keyboard, reduced motion, lazy embeds, EN and ES,
// axe in both languages and the 390 px layout.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
}

async function audit(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="aladin-host"]')
    .exclude('iframe')
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

// Chapter 4 shows the 16 years view when the API has a WISE companion for the WISE 0855 preset. The companion
// documents are the real ones stored with the wise spec; fixture mode asks only when the spec says so.
const FX = resolve(process.cwd(), 'tests/e2e/fixtures/wise');
const WISE_MANIFEST = readFileSync(resolve(FX, 'manifest.json'), 'utf-8');
const WISE_ASTROMETRY = readFileSync(resolve(FX, 'astrometry.json'), 'utf-8');
const WISE_FRAME = readFileSync(resolve(FX, 'frame.webp'));

async function withCompanion(page: Page, companion: boolean) {
  await page.addInitScript(() => {
    (window as { __DESTELLO_WISE__?: boolean }).__DESTELLO_WISE__ = true;
  });
  await page.route('**/api/v1/sequences/*/wise/astrometry', (r) =>
    companion
      ? r.fulfill({ status: 200, contentType: 'application/json', body: WISE_ASTROMETRY })
      : r.fulfill({ status: 204, body: '' }),
  );
  await page.route(/\/api\/v1\/sequences\/[^/]+\/wise$/, (r) =>
    companion
      ? r.fulfill({ status: 200, contentType: 'application/json', body: WISE_MANIFEST })
      : r.fulfill({ status: 204, body: '' }),
  );
  await page.route('**/frames/*.webp', (r) =>
    r.fulfill({ status: 200, contentType: 'image/webp', body: WISE_FRAME }),
  );
}

test('chapter 4 shows the 16 years view when a companion exists, in both languages', async ({ page }) => {
  await setup(page);
  await withCompanion(page, true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/story?lang=en');
  const ch = page.getByTestId('story-ch-4');
  await ch.scrollIntoViewIfNeeded();
  await expect(ch.getByTestId('wise-timeline')).toBeVisible();
  await expect(ch.locator('iframe')).toHaveCount(0);
  await expect(ch).toContainText('another fast mover, WISE 0855');
  await expect(page.getByTestId('story-facts-ch4')).toContainText('catalog proper motion');
  await expect(page.getByTestId('story-open-barnard')).toHaveAttribute('href', /\/t\/wise0855\?/);
  await audit(page);
  await page.screenshot({ path: '../qa/screens/sprint/story16/story-ch4-1440.png' });
  await page.goto('/story?lang=es');
  await page.getByTestId('story-ch-4').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('story-ch-4').getByTestId('wise-timeline')).toBeVisible();
  await expect(page.getByTestId('story-ch-4')).toContainText('otro objeto de movimiento rápido');
  await audit(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/story?lang=en');
  await page.getByTestId('story-ch-4').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('story-ch-4').getByTestId('wise-timeline')).toBeVisible();
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
  await page.screenshot({ path: '../qa/screens/sprint/story16/story-ch4-390.png' });
});

test('chapter 4 falls back to the Barnard player when the API answers 204', async ({ page }) => {
  await setup(page);
  await withCompanion(page, false);
  await page.goto('/story?lang=en');
  await page.getByTestId('story-embed-barnard').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('story-frame-barnard')).toBeVisible();
  await expect(page.getByTestId('story-ch-4').getByTestId('wise-timeline')).toHaveCount(0);
  await expect(page.getByTestId('story-ch-4')).toContainText('The player below shows real SPHEREx epochs');
});

const active = (page: Page) => page.getByTestId('story').getAttribute('data-active');

test('seven chapters, headings in order, landmarks', async ({ page }) => {
  await setup(page);
  await page.goto('/story?lang=en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From Pluto to Planet X');
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(7);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Story chapters' })).toBeVisible();
  await expect(page.getByTestId('story-keys')).toContainText('N next chapter');
  // Text-only chapters carry no embed.
  for (const n of [1, 2, 7]) await expect(page.getByTestId(`story-ch-${n}`).locator('iframe')).toHaveCount(0);
});

test('keyboard moves between chapters and focuses the heading', async ({ page }) => {
  await setup(page);
  await page.goto('/story?lang=en');
  await expect(page.getByTestId('story-counter')).toHaveText('Chapter 1 of 7');
  await expect(page.getByTestId('story-prev')).toBeDisabled();
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('n');
  await expect(page.getByTestId('story-counter')).toHaveText('Chapter 2 of 7');
  await expect(page.getByRole('heading', { level: 2, name: /WISE and the volunteers/ })).toBeFocused();
  await page.keyboard.press('5');
  await expect(page.getByTestId('story-counter')).toHaveText('Chapter 5 of 7');
  await page.keyboard.press('p');
  await expect(page.getByTestId('story-counter')).toHaveText('Chapter 4 of 7');
  await page.getByTestId('story-next').click();
  await expect(page.getByTestId('story-counter')).toHaveText('Chapter 5 of 7');
  await page.keyboard.press('7');
  await expect(page.getByTestId('story-next')).toBeDisabled();
  await expect(page.getByTestId('story-hunt')).toBeVisible();
  expect(await active(page)).toBe('6');
});

test('embeds mount only near the viewport', async ({ page }) => {
  await setup(page);
  await page.goto('/story?lang=en');
  await expect(page.getByTestId('story-embed-colors')).toBeVisible();
  await expect(page.getByTestId('story-embed-barnard')).toHaveAttribute('data-mounted', '0');
  await expect(page.getByTestId('story-embed-wise0855')).toHaveAttribute('data-mounted', '0');
  await expect(page.getByTestId('story-frame-barnard')).toHaveCount(0);
  await page.getByTestId('story-embed-barnard').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('story-embed-barnard')).toHaveAttribute('data-mounted', '1');
  const src = await page.getByTestId('story-frame-barnard').getAttribute('src');
  expect(src).toContain('/embed?');
  expect(src).toContain('target=barnard');
  // The embedded player renders inside the frame.
  await expect(
    page.frameLocator('[data-testid="story-frame-barnard"]').getByTestId('player-canvas'),
  ).toBeVisible({ timeout: 20_000 });
  // Far from the viewport again: the frame is unmounted.
  await page.keyboard.press('7');
  await expect(page.getByTestId('story-embed-barnard')).toHaveAttribute('data-mounted', '0');
  await expect(page.getByTestId('story-frame-barnard')).toHaveCount(0);
});

test('numbers come from the API (dev fixtures) and chapter 6 is the comet', async ({ page }) => {
  await setup(page);
  await page.goto('/story?lang=en');
  await expect(page.getByTestId('story-facts-ch4')).toContainText('catalog proper motion');
  await expect(page.getByTestId('story-facts-ch5')).toContainText('V-03');
  await expect(page.getByTestId('story-ch-6')).toContainText('A visitor from another star');
});

test('reduced motion: no autoplay and step controls remain', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page);
  await page.goto('/story?lang=en');
  await expect(page.getByTestId('story')).toHaveAttribute('data-reduced', '1');
  await expect(page.getByTestId('story-reduced')).toBeVisible();
  await page.getByTestId('story-next').click();
  await page.keyboard.press('4');
  await expect(page.getByTestId('story-embed-barnard')).toHaveAttribute('data-mounted', '1');
  const src = await page.getByTestId('story-frame-barnard').getAttribute('src');
  expect(src).toContain('play=0');
  expect(src).not.toContain('play=1');
  const f = page.frameLocator('[data-testid="story-frame-barnard"]');
  await expect(f.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(f.getByTestId('btn-play')).not.toHaveAccessibleName(/pause/i);
});

test('Spanish page, axe in both languages', async ({ page }) => {
  await setup(page);
  await page.goto('/story?lang=es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('De Plutón al Planeta X');
  await expect(page.getByTestId('story-counter')).toHaveText('Capítulo 1 de 7');
  await expect(page.getByTestId('story-ch-3')).toContainText('102 colores');
  await audit(page);
  await page.goto('/story?lang=en');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('From Pluto to Planet X');
  await audit(page);
});

test('linked from the header and the home hero', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?lang=en');
  await expect(page.getByTestId('hero-story')).toBeVisible();
  await page.getByRole('navigation', { name: 'Destello' }).getByRole('link', { name: 'Story' }).click();
  await expect(page).toHaveURL(/\/story/);
  await expect(page.getByTestId('story')).toBeVisible();
});

test('layout at 1440 and 390 px has no horizontal overflow', async ({ page }) => {
  await setup(page);
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/story?lang=en');
    await expect(page.getByTestId('story')).toBeVisible();
    await page.getByTestId('story-embed-barnard').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('story-frame-barnard')).toBeVisible();
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    await expect(
      page.frameLocator('[data-testid="story-frame-barnard"]').getByTestId('player-canvas'),
    ).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `../qa/screens/sprint/story/story-${w}.png` });
  }
});
