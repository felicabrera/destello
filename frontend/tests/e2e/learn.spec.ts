// F-38 Measure it yourself on the dev fixtures: clicks by mouse and keyboard, the steps, the comparison table,
// EN and ES, axe, the 390 px layout and the print guide.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function setup(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
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
async function ready(page: Page) {
  await expect(page.getByTestId('learn-activity')).toBeVisible({ timeout: 30_000 });
}
const num = (s: string | null) => Number((s ?? '').replace(/[^\d.,-]/g, '').replace(',', '.'));

test('mouse and keyboard clicks give steps and a comparison', async ({ page }) => {
  await setup(page);
  await page.goto('/learn?lang=en');
  await ready(page);
  await expect(page.getByTestId('learn-need-two')).toBeVisible();
  const canvas = page.getByTestId('player-canvas');
  const box = (await canvas.boundingBox())!;
  // Epoch 1 by mouse, redo it, then click again.
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
  await expect(page.getByTestId('learn-confirm')).toBeEnabled();
  await page.getByTestId('learn-confirm').click();
  await expect(page.getByTestId('learn-epoch-0')).toHaveAttribute('data-clicked', '1');
  await page.getByTestId('learn-epoch-0').click();
  await page.getByTestId('learn-redo').click();
  await expect(page.getByTestId('learn-epoch-0')).toHaveAttribute('data-clicked', '0');
  await canvas.click({ position: { x: box.width * 0.5, y: box.height * 0.5 } });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('learn-epoch-0')).toHaveAttribute('data-clicked', '1');
  // The next epoch by keyboard: the arrows move the crosshair instead of stepping epochs.
  await canvas.focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(page.getByTestId('learn-live')).toContainText('Crosshair');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('learn-epoch-1')).toHaveAttribute('data-clicked', '1');
  await expect(page.getByTestId('learn-frame')).toHaveAttribute('data-epoch', '2');
  // Two epochs are enough; the steps appear and agree with each other.
  await expect(page.getByTestId('learn-steps')).toBeVisible();
  for (const n of [1, 2, 3, 4, 5]) await expect(page.getByTestId(`learn-step-${n}`)).toBeVisible();
  const years = num(
    await page
      .getByTestId('learn-time')
      .textContent()
      .then((t) => /= ([\d.,]+) years/.exec(t ?? '')?.[1] ?? ''),
  );
  expect(years).toBeGreaterThan(0);
  const pmRa = num(
    /= ([+-][\d.,]+)\s/.exec((await page.getByTestId('learn-pm-ra').textContent()) ?? '')?.[1] ?? '',
  );
  const pmDec = num(
    /= ([+-][\d.,]+)\s/.exec((await page.getByTestId('learn-pm-dec').textContent()) ?? '')?.[1] ?? '',
  );
  const total = num(
    await page
      .getByTestId('learn-result')
      .textContent()
      .then((t) => /: ([\d.,]+)/.exec(t ?? '')?.[1] ?? ''),
  );
  expect(total).toBeCloseTo(Math.hypot(pmRa, pmDec), 1);
  await expect(page.getByTestId('learn-cmp-mine')).toBeVisible();
  await expect(page.getByTestId('learn-cmp-gaia')).toBeVisible();
  await expect(page.getByTestId('learn-why')).toContainText('6 arcsec');
  await audit(page);
});

test('Spanish page, axe and 390 px layout', async ({ page }) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn?lang=es');
  await ready(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mida usted mismo');
  const canvas = page.getByTestId('player-canvas');
  await canvas.click({ position: { x: 100, y: 100 } });
  await page.keyboard.press('Enter');
  await canvas.click({ position: { x: 120, y: 90 } });
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('learn-steps')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await audit(page);
});

test('the guide renders in both languages and prints without the site chrome', async ({ page }) => {
  await setup(page);
  for (const [lang, h] of [
    ['en', "Measure the proper motion of Barnard's Star"],
    ['es', 'Medir el movimiento propio de la estrella de Barnard'],
  ] as const) {
    await page.goto(`/learn/guide?lang=${lang}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(h);
    for (const s of ['objectives', 'timeline', 'materials', 'steps', 'questions', 'answer'])
      await expect(page.getByTestId(`guide-${s}`)).toBeVisible();
    await expect(page.getByTestId('guide-range')).toBeVisible({ timeout: 20_000 });
    await audit(page);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/learn/guide?lang=en');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByTestId('header')).toBeHidden();
  await expect(page.getByTestId('footer')).toBeHidden();
  await expect(page.getByTestId('guide-print')).toBeHidden();
});
