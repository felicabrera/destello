// F-31 low coverage epochs, against the dev fixtures. With include_partial the fixture adds one short revisit
// (epoch 4) that observed only D2, D5 and the broadband coadd. The frames are synthetic (DEV FIXTURE); the real
// grouping is covered by the backend tests.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

async function ready(page: Page) {
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

test('F-31: short revisits are off by default and the switch keeps partial=1 in the URL', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await page.getByTestId('data-options-toggle').click();
  const sw = page.getByTestId('partial-toggle');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(sw).toContainText('Include short revisits');
  await expect(page.getByTestId('partial-help')).toContainText('never used in measurements');
  await expect(page.getByTestId('epoch-node-4')).toHaveCount(0);
  await expect(page.getByTestId('epoch-low-4')).toHaveCount(0);

  // Keyboard: the switch is a button, Space turns it on.
  await sw.focus();
  await page.keyboard.press('Space');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/[?&]partial=1(&|$)/);
  await ready(page);
  await expect(page.getByTestId('epoch-node-4')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('epoch-low-4')).toHaveText('Low coverage');
  await expect(page.getByTestId('epoch-low-3')).toHaveCount(0);
  await expect(page.getByTestId('epoch-node-4')).toHaveAttribute('aria-label', /Low coverage/);

  // Off again: the key leaves the URL and the short revisit leaves the timeline.
  await sw.focus();
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page).not.toHaveURL(/partial=/);
  await expect(page.getByTestId('epoch-node-4')).toHaveCount(0, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

test('F-31: a low coverage epoch is labelled and a detector it did not observe is stated, never filled in', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/t/barnard?play=0&partial=1&frame=4&lang=en');
  await ready(page);
  await expect(page.getByTestId('epoch-chip-low')).toHaveText('Low coverage');
  await expect(page.getByTestId('player-announce')).toContainText('Low coverage');
  await expect(page.getByTestId('missing-frame')).toHaveCount(0);

  // D6 was not observed in the short revisit: the frame states it.
  await page.getByTestId('det-6').click();
  await expect(page).toHaveURL(/[?&]det=6(&|$)/);
  const missing = page.getByTestId('missing-frame');
  await expect(missing).toBeVisible();
  await expect(missing).toContainText('short revisit that did not observe D6');
  await expect(page.getByTestId('epoch-node-4')).toHaveAttribute(
    'aria-label',
    /without data in this detector/,
  );

  // Back to a detector the short revisit observed: its frame is shown.
  await page.getByTestId('det-2').click();
  await expect(page.getByTestId('missing-frame')).toHaveCount(0);
  expect(errors).toEqual([]);

  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="aladin-host"]')
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
});

test('F-31: candidates are not computed for a pair with a low coverage epoch', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/t/barnard?play=0&partial=1&mode=diffseq&frame=4&cand=1&det=2&lang=en');
  await ready(page);
  await expect(page.getByTestId('cand-low')).toContainText('not computed for low coverage epochs');
  await expect(page.getByTestId('cand-row')).toHaveCount(0);
  await expect(page.getByTestId('diff-legend')).toContainText('Epoch 4');
  await expect(page.getByTestId('diff-legend')).toContainText('Epoch 3');

  // A pair of full epochs is computed as before.
  await page.getByTestId('epoch-node-3').click();
  await expect(page.getByTestId('cand-low')).toHaveCount(0);
  await expect(page.getByTestId('cand-list').getByTestId('cand-row').first()).toBeVisible({
    timeout: 20_000,
  });

  // The reference picker of the difference mode labels the short revisit.
  await page.getByTestId('mode-diff').click();
  await expect(page.getByTestId('ref-select').locator('option').nth(3)).toHaveText('Epoch 4 (low coverage)');
  expect(errors).toEqual([]);
});

test('F-31: Spanish labels', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/t/barnard?play=0&partial=1&frame=4&lang=es');
  await ready(page);
  await expect(page.getByTestId('partial-toggle')).toContainText('Incluir revisitas breves');
  await expect(page.getByTestId('partial-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('epoch-low-4')).toHaveText('Cobertura baja');
  await expect(page.getByTestId('epoch-chip-low')).toHaveText('Cobertura baja');
  await page.getByTestId('det-6').click();
  await expect(page.getByTestId('missing-frame')).toContainText('revisita breve que no observó D6');
  expect(errors).toEqual([]);
});
