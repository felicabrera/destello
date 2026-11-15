// F-35 Hunt on the dev fixtures: tutorial, vote by keyboard, gold reveal, empty state, counters, layout, axe.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page, opts: { tutorialSeen?: boolean; fx?: string } = {}) {
  await page.addInitScript(
    ([seen, fx]) => {
      sessionStorage.setItem('destello.fx', 'fixtures');
      if (fx) sessionStorage.setItem('destello.fxHunt', fx);
      if (seen) localStorage.setItem('destello.huntTutorialSeen', '1');
    },
    [opts.tutorialSeen !== false, opts.fx ?? ''] as const,
  );
}

/** Opaque id of the n-th dev fixture field (16 hex digits, like the API). */
const fid = (n: number) => n.toString(16).padStart(16, '0');

async function review(page: Page, field?: string) {
  await expect(page.getByTestId('hunt-review')).toBeVisible({ timeout: 20_000 });
  if (field) await expect(page.getByTestId('hunt-review')).toHaveAttribute('data-field', field);
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

async function audit(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="aladin-host"]')
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

test('first visit tutorial runs once and is kept as seen', async ({ page }) => {
  await setup(page, { tutorialSeen: false });
  await page.goto('/hunt?lang=en&play=0');
  const card = page.getByTestId('hunt-tutorial');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-step', 'look');
  for (const step of ['controls', 'classify', 'trust']) {
    await page.getByTestId('hunt-tutorial-next').click();
    await expect(card).toHaveAttribute('data-step', step);
  }
  await page.getByTestId('hunt-tutorial-next').click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('destello.huntTutorialSeen'))).toBe('1');
  await page.reload();
  await expect(page.getByTestId('hunt')).toBeVisible();
  await expect(page.getByTestId('hunt-tutorial')).toHaveCount(0);
  // The replay button opens it again, and Escape closes it.
  await page.getByTestId('hunt-tutorial-open').click();
  await expect(page.getByTestId('hunt-tutorial')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hunt-tutorial')).toHaveCount(0);
});

test('anonymous session token is random and stored locally', async ({ page }) => {
  await setup(page);
  await page.goto('/hunt?play=0');
  await review(page);
  const tok = await page.evaluate(() => localStorage.getItem('destello.huntSession'));
  expect(tok).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((k) => /name|mail|user/i.test(k))),
  ).toEqual([]);
});

test('vote by keyboard, gold answer only after the vote', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await setup(page);
  await page.goto('/hunt?play=0&lang=en');
  await review(page, fid(1));
  await expect(page.getByTestId('hunt-gold')).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL(/frame=2/);
  await page.keyboard.press('d');
  await expect(page.getByTestId('mode-diff')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('b');
  await page.keyboard.press('4'); // Nothing
  await review(page, fid(2));
  await page.keyboard.press('5'); // Not sure
  await review(page, fid(3));
  await expect(page.getByTestId('hunt-progress')).toContainText('Field 3');
  await expect(page.getByTestId('hunt-progress')).not.toContainText(/gold/i);
  // Nothing on the screen names the known answer before the vote.
  await expect(page.getByTestId('hunt')).not.toContainText('Known answer');
  await expect(page.getByTestId('hunt-gold')).toHaveCount(0);
  await page.keyboard.press('2'); // Brightness change: wrong for a mover
  const gold = page.getByTestId('hunt-gold');
  await expect(gold).toBeVisible();
  await expect(gold).toHaveAttribute('data-correct', 'false');
  await expect(page.getByTestId('hunt-gold-answer')).toContainText('Mover');
  // While the answer is on screen, further votes are ignored.
  await page.keyboard.press('1');
  await expect(gold).toBeVisible();
  await page.getByTestId('hunt-continue').click();
  await review(page, fid(4));
  await expect(page.getByTestId('counter-votes')).toContainText('3');
  expect(errors).toEqual([]);
});

test('optional mark: click marks a sky position, X removes it', async ({ page }) => {
  await setup(page);
  await page.goto('/hunt?play=0&lang=en');
  await review(page);
  await page.getByTestId('player-canvas').click({ position: { x: 60, y: 60 } });
  await expect(page.getByTestId('hunt-mark-pos')).toContainText('RA');
  await page.keyboard.press('x');
  await expect(page.getByTestId('hunt-mark-pos')).toHaveCount(0);
  await page.getByTestId('player-canvas').click({ position: { x: 80, y: 70 } });
  await page.getByTestId('hunt-mark-clear').click();
  await expect(page.getByTestId('hunt-mark-pos')).toHaveCount(0);
});

test('zoom and contrast apply to the view without leaving the page', async ({ page }) => {
  await setup(page);
  await page.goto('/hunt?play=0');
  await review(page);
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('z');
  await expect(page.getByTestId('hunt-zoom')).toHaveAttribute('data-zoom', '2');
  await page.getByTestId('hunt-reset-view').click();
  await expect(page.getByTestId('hunt-zoom')).toHaveAttribute('data-zoom', '1');
});

test('empty state when the bank is not built', async ({ page }) => {
  await setup(page, { fx: 'huntempty' });
  await page.goto('/hunt?lang=en');
  await expect(page.getByTestId('hunt-empty')).toContainText('No fields available yet');
  await expect(page.getByTestId('hunt-review')).toHaveCount(0);
  await audit(page);
});

test('a burst needs the verification check', async ({ page }) => {
  await setup(page, { fx: 'hunttoken' });
  await page.goto('/hunt?play=0&lang=en');
  await review(page, fid(1));
  await page.keyboard.press('4');
  await review(page, fid(2));
  await page.keyboard.press('4');
  await expect(page.getByTestId('hunt-turnstile')).toBeVisible();
  await expect(page.getByTestId('hunt-review')).toHaveAttribute('data-field', fid(2));
});

test('rate limit shows a wait message and keeps the field', async ({ page }) => {
  await setup(page, { fx: 'huntrate' });
  await page.goto('/hunt?play=0&lang=en');
  await review(page, fid(1));
  await page.keyboard.press('4');
  await expect(page.getByTestId('hunt-rate')).toContainText('20 seconds');
  await expect(page.getByTestId('hunt-review')).toHaveAttribute('data-field', fid(1));
});

test('counters on the home page link to Hunt', async ({ page }) => {
  await setup(page);
  await page.goto('/');
  await expect(page.getByTestId('hunt-counters-compact')).toBeVisible({ timeout: 20_000 });
  await page.getByTestId('hunt-open').click();
  await expect(page.getByTestId('hunt')).toBeVisible();
  await expect(page.getByTestId('hunt-counters')).toBeVisible();
});

test('reduced motion: no autoplay', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  await ctx.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    localStorage.setItem('destello.huntTutorialSeen', '1');
  });
  const page = await ctx.newPage();
  await page.goto('/hunt');
  await review(page);
  await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
  await ctx.close();
});

test('390 px layout has no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.goto('/hunt?play=0&lang=en');
  await review(page);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(0);
});

for (const lang of ['en', 'es']) {
  test(`axe hunt page (${lang})`, async ({ page }) => {
    await setup(page);
    await page.goto(`/hunt?play=0&lang=${lang}`);
    await review(page);
    await audit(page);
  });
  test(`axe hunt tutorial (${lang})`, async ({ page }) => {
    await setup(page, { tutorialSeen: false });
    await page.goto(`/hunt?play=0&lang=${lang}`);
    await expect(page.getByTestId('hunt-tutorial')).toBeVisible();
    await audit(page);
  });
}

test('candidates: honest empty state, then a list with a link to the explorer, in both languages', async ({
  page,
}) => {
  await setup(page);
  await page.goto('/hunt?lang=en&play=0');
  const box = page.getByTestId('hunt-candidates');
  await expect(box).toContainText('not a confirmed detection');
  await expect(page.getByTestId('hunt-candidates-empty')).toHaveText('No candidates yet.');
  await audit(page);
  const some = await page.context().newPage();
  await setup(some, { fx: 'huntcands' });
  await some.goto('/hunt?lang=en&play=0');
  const row = some.getByTestId('hunt-candidate');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('1');
  await expect(row).toContainText('Mover');
  await expect(row).toContainText('80.0%');
  await expect(row.getByRole('link')).toHaveAttribute('href', /seq=/);
  await audit(some);
  await some.goto('/hunt?lang=es&play=0');
  await expect(some.getByTestId('hunt-candidates')).toContainText('no una detección confirmada');
  await audit(some);
  await some.setViewportSize({ width: 390, height: 844 });
  await some.goto('/hunt?lang=en&play=0');
  await some.getByTestId('hunt-candidates').scrollIntoViewIfNeeded();
  const over = await some.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
  await some.screenshot({ path: '../qa/screens/sprint/story16/hunt-390.png' });
  await some.setViewportSize({ width: 1440, height: 900 });
  await some.goto('/hunt?lang=en&play=0');
  await some.getByTestId('hunt-candidates').scrollIntoViewIfNeeded();
  await some.screenshot({ path: '../qa/screens/sprint/story16/hunt-1440.png' });
});
