// F-29 candidates to review, against the dev fixtures. The fixture list is synthetic (DEV FIXTURE); the real
// detection is covered by the backend tests.
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

test('F-29: the toggle is off by default, lists the pair and is kept in the URL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&lang=en');
  await ready(page);
  const sw = page.getByTestId('cand-toggle');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('cand-panel')).toHaveCount(0);
  await expect(page.getByTestId('player-canvas')).not.toHaveAttribute('data-cand-markers');

  // Keyboard: the switch is a button, Enter turns it on.
  await sw.focus();
  await page.keyboard.press('Enter');
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/[?&]cand=1(&|$)/);

  const panel = page.getByTestId('cand-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('cand-disclaimer')).toContainText('It is not a detection of a new object');
  await expect(page.getByTestId('cand-pair')).toContainText('Epoch 2');
  await expect(page.getByTestId('cand-pair')).toContainText('minus epoch 1');
  await expect(page.getByTestId('cand-list').getByTestId('cand-row')).toHaveCount(3, { timeout: 20_000 });
  await expect(page.getByTestId('cand-counts')).toContainText('Listed');
  await expect(page.getByTestId('cand-counts').locator('[data-count="listed"] dd')).toHaveText('7');
  await expect(page.getByTestId('cand-method')).toContainText('5 sigma');
  await expect(page.getByTestId('cand-method')).toContainText('Gaia DR3 and CatWISE2020');
  await expect(page.getByTestId('cand-causes')).toContainText('optical reflections');
  await expect(page.getByTestId('cand-dropped')).toContainText('16 seen by a single detector');
  await expect(page.getByTestId('cand-legend')).toBeVisible();

  const first = page.getByTestId('cand-row').first();
  await expect(first).toContainText('c1');
  await expect(first).toContainText('No catalog match');
  await expect(first).toContainText('Brighter in epoch 2');
  await expect(first).toContainText('S/N 9.6');
  await expect(first).toContainText('D3 D4 D5');
  await expect(first).toContainText(/RA \d+\.\d{4} deg, Dec [+-]\d+\.\d{4} deg/);
  await expect(page.getByTestId('cand-row').nth(2)).toContainText('Moved');
  await expect(page.getByTestId('cand-row').nth(2)).toContainText('Separation between the two positions');

  // Markers on the frame: the default list only, while the explained groups are collapsed.
  const canvas = page.getByTestId('player-canvas');
  await expect(canvas).toHaveAttribute('data-cand-markers', '3');
  const group = page.getByTestId('cand-group-target');
  await expect(group.getByRole('button', { name: /At the target \(2\)/ })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await group.getByRole('button').first().click();
  await expect(group.getByTestId('cand-row')).toHaveCount(2);
  await expect(group.getByTestId('cand-match')).toContainText('Gaia DR3');
  await expect(canvas).toHaveAttribute('data-cand-markers', '5');

  // Keyboard selection: the row button is focusable and Enter highlights its marker.
  const select = first.getByTestId('cand-select');
  await select.focus();
  await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveAttribute('data-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(select).toHaveAttribute('aria-pressed', 'false');

  await audit(page);

  // A reload keeps the toggle.
  await page.reload();
  await ready(page);
  await expect(page.getByTestId('cand-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('cand-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('F-29: a click on a marker selects its row', async ({ page }) => {
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=en');
  await ready(page);
  await expect(page.getByTestId('cand-list').getByTestId('cand-row')).toHaveCount(3, { timeout: 20_000 });
  const row = page.getByTestId('cand-row').nth(1);
  const x = Number(await row.getAttribute('data-x'));
  const y = Number(await row.getAttribute('data-y'));
  const n = await page.evaluate(() => (window as unknown as { __destello: { n: number } }).__destello.n);
  const canvas = page.getByTestId('player-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no box');
  await page.mouse.click(box.x + (x / n) * box.width, box.y + (y / n) * box.height);
  await expect(row).toHaveAttribute('data-selected', 'true');
  await expect(row.getByTestId('cand-select')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cand-row').first()).not.toHaveAttribute('data-selected');
});

test('F-29: the report action opens the report flow with both epochs marked', async ({ page }) => {
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=en');
  await ready(page);
  const row = page.getByTestId('cand-list').getByTestId('cand-row').nth(2);
  await expect(row).toContainText('Moved', { timeout: 20_000 });
  await row.getByTestId('cand-report').click();
  await expect(page.getByTestId('report-flow')).toBeVisible();
  await expect(page.getByTestId('report-marks').getByText('Marked', { exact: true })).toHaveCount(2);
  await expect(page.getByTestId('report-run')).toBeEnabled();
});

test('F-29: Spanish copy, catalog outage and cut list notices', async ({ page }) => {
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=es&fx=candcat');
  await ready(page);
  const panel = page.getByTestId('cand-panel');
  await expect(panel.getByRole('heading', { name: 'Candidatos a revisar' })).toBeVisible();
  await expect(page.getByTestId('cand-disclaimer')).toContainText('No es la detección de un objeto nuevo');
  await expect(page.getByTestId('cand-unchecked-notice')).toContainText('CatWISE2020', { timeout: 20_000 });
  await expect(page.getByTestId('cand-truncated')).toContainText('La lista fue recortada');
  const first = page.getByTestId('cand-row').first();
  await expect(first).toContainText('Sin verificar');
  await expect(first).toContainText('Más brillante en la época 2');
  await expect(first).toContainText('S/R 9,6');
  await expect(page.getByTestId('cand-toggle')).toContainText('Candidatos');
  await expect(panel).not.toContainText(/descubrimiento/i);
});

test('F-29: empty and error states', async ({ page }) => {
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=en&fx=candempty');
  await ready(page);
  await expect(page.getByTestId('cand-empty')).toHaveText('No candidates in this pair', { timeout: 20_000 });
  await expect(page.getByTestId('cand-dropped')).toContainText('37 in extended structure');
  await expect(page.getByTestId('player-canvas')).toHaveAttribute('data-cand-markers', '0');

  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=en&fx=canderr');
  await ready(page);
  await expect(page.getByTestId('cand-error')).toContainText('Too many requests', { timeout: 20_000 });
  await expect(page.getByTestId('cand-error').getByRole('button', { name: 'Retry' })).toBeVisible();
});

test('F-29: phone layout at 360 px has the list in the tools sheet and no horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=es');
  await ready(page);
  await expect(page.getByTestId('player-canvas')).toHaveAttribute('data-cand-markers', '3', {
    timeout: 20_000,
  });
  const tool = page.getByTestId('tool-cand');
  await expect(tool).toContainText('Candidatos');
  await tool.click();
  const dialog = page.getByTestId('tool-dialog');
  await expect(dialog.getByTestId('cand-list').getByTestId('cand-row')).toHaveCount(3);
  await dialog.getByTestId('cand-group-target').getByRole('button').first().click();
  await expect(dialog.getByTestId('cand-match').first()).toBeVisible();
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

test('F-29: the embed draws markers only when the URL carries the toggle, and has no list', async ({
  page,
}) => {
  await page.goto('/embed?target=barnard&play=0&mode=diff&frame=2&cand=1&controls=full&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('player-canvas')).toHaveAttribute('data-cand-markers', '3', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('cand-panel')).toHaveCount(0);
  await expect(page.getByTestId('cand-toggle')).toHaveCount(0);

  await page.goto('/embed?target=barnard&play=0&mode=diff&frame=2&controls=full&lang=en');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await expect(page.getByTestId('player-canvas')).not.toHaveAttribute('data-cand-markers');
});
