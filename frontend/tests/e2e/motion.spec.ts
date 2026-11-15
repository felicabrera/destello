// F-32 motion search, against the dev fixtures. The fixture lists are synthetic (DEV FIXTURE); the real search is
// covered by the backend tests.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function ready(page: Page) {
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
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

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

test('F-32: the search runs only on request, lists the target and draws its track', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/t/epsindib?play=0&lang=en');
  await ready(page);
  const panel = page.getByTestId('motion-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Motion search' })).toBeVisible();
  await expect(page.getByTestId('motion-list')).toHaveCount(0);
  await expect(page.getByTestId('player-canvas')).not.toHaveAttribute('data-motion-tracks');

  // Keyboard: the button starts the search.
  const run = page.getByTestId('motion-run');
  await expect(run).toBeEnabled();
  await run.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('motion-disclaimer')).toContainText('candidate to review');
  const rows = page.getByTestId('motion-list').getByTestId('motion-row');
  await expect(rows).toHaveCount(1, { timeout: 20_000 });
  const row = rows.first();
  await expect(row).toHaveAttribute('data-status', 'target');
  await expect(row).toContainText('m1');
  await expect(row).toContainText('At the target');
  await expect(row.getByTestId('motion-pm')).toHaveText('pmra* 3.75 ± 0.17, pmdec -2.57 ± 0.17 arcsec/yr');
  await expect(row).toContainText('D2 D3 D4 D5 D6');
  await expect(page.getByTestId('motion-counts').locator('[data-count="target"] dd')).toHaveText('1');
  await expect(page.getByTestId('motion-method')).toContainText('3 full coverage epochs');
  await expect(page.getByTestId('player-canvas')).toHaveAttribute('data-motion-tracks', '1');

  // Keyboard selection.
  const select = row.getByTestId('motion-select');
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('aria-pressed', 'true');

  // Limits, including the distant solar system object, behind a keyboard operable disclosure.
  const limits = page.getByTestId('motion-limits');
  await limits.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(limits.locator('[data-limit="distant"]')).toContainText('hypothetical Planet X');
  await expect(limits.locator('[data-limit="distant"]')).toBeVisible();

  const text = (await panel.innerText()).toLowerCase();
  expect(text).not.toContain('discovery');
  await audit(page);

  // Tracks belong to sky frames: none on a difference image.
  await page.getByTestId('mode-diff').click();
  await expect(page.getByTestId('player-canvas')).not.toHaveAttribute('data-motion-tracks');
  expect(errors).toEqual([]);
});

test('F-32: an empty result says that no source moves consistently', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await page.getByTestId('motion-run').click();
  await expect(page.getByTestId('motion-empty')).toHaveText(
    'No source moves consistently in two or more detectors.',
    { timeout: 20_000 },
  );
  await expect(page.getByTestId('motion-counts').locator('[data-count="listed"] dd')).toHaveText('0');
  await expect(page.getByTestId('player-canvas')).not.toHaveAttribute('data-motion-tracks');
  expect(errors).toEqual([]);
});

test('F-32: too few epochs is stated without a retry', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/t/wise0855?play=0&lang=en');
  await ready(page);
  await page.getByTestId('motion-run').click();
  const err = page.getByTestId('motion-error');
  await expect(err).toHaveAttribute('data-code', 'TOO_FEW_EPOCHS', { timeout: 20_000 });
  await expect(err).toContainText('three or more full coverage epochs');
  await expect(err.getByRole('button')).toHaveCount(0);
  // The expected 422 is logged by the browser as a failed resource load; nothing else may fail.
  expect(errors.filter((e) => !e.includes('422'))).toEqual([]);
});

test('F-32: a rate limit offers a retry', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en&fx=motionerr');
  await ready(page);
  await page.getByTestId('motion-run').click();
  const err = page.getByTestId('motion-error');
  await expect(err).toHaveAttribute('data-code', 'RATE_LIMITED', { timeout: 20_000 });
  await expect(err.getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('F-32: Spanish copy, catalog match and tracks of several sources', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=es&fx=motionmany');
  await ready(page);
  await expect(page.getByRole('heading', { name: 'Búsqueda de movimiento' })).toBeVisible();
  await page.getByRole('button', { name: 'Buscar fuentes en movimiento' }).click();
  const rows = page.getByTestId('motion-row');
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.first()).toContainText('Sin coincidencia en catálogos');
  await expect(rows.nth(1)).toContainText('Fuente de catálogo');
  await expect(rows.nth(1).getByTestId('motion-match')).toContainText('difiere del catálogo en 0,2 sigma');
  await expect(page.getByTestId('motion-disclaimer')).toContainText('candidato a revisar');
  await expect(page.getByTestId('player-canvas')).toHaveAttribute('data-motion-tracks', '2');
  const text = (await page.getByTestId('motion-panel').innerText()).toLowerCase();
  expect(text).not.toContain('descubrimiento');
});

test('F-32: phone layout at 360 px has the search in the tools sheet and no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/t/epsindib?play=0&lang=es');
  await ready(page);
  const tool = page.getByTestId('tool-motion');
  await expect(tool).toContainText('Sin ejecutar');
  await tool.click();
  const dialog = page.getByTestId('tool-dialog');
  await dialog.getByTestId('motion-run').click();
  await expect(dialog.getByTestId('motion-row')).toHaveCount(1, { timeout: 20_000 });
  const over = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="tool-dialog"]') as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: d.scrollWidth - d.clientWidth,
    };
  });
  expect(over.page).toBeLessThanOrEqual(0);
  expect(over.dialog).toBeLessThanOrEqual(0);
  await audit(page);
});
