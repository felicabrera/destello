// F-30 results sheet, against the dev fixtures. Every number checked here is a DEV FIXTURE value: the test checks
// that the sheet repeats what the view holds, not the science.
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('destello.fx', 'fixtures');
    // The print dialog of the browser would block the test: count the calls instead.
    const w = window as unknown as { __prints: number };
    w.__prints = 0;
    window.print = () => {
      w.__prints++;
    };
  });
});

async function openActions(page: Page) {
  const more = page.getByTestId('actions-more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

async function ready(page: Page) {
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return errors;
}

test('F-30: the sheet repeats the loaded view, prints and downloads as JSON from the keyboard', async ({
  page,
}) => {
  const errors = watchErrors(page);
  await page.goto('/t/barnard?play=0&det=6&tab=measure&lang=en');
  await ready(page);
  await expect(page.getByTestId('measure-result')).toBeVisible({ timeout: 20_000 });
  const pmra = (await page.getByTestId('fit-pmra').textContent()) ?? '';
  const pmdec = (await page.getByTestId('fit-pmdec').textContent()) ?? '';
  const verdict = (await page.getByTestId('measure-verdict').textContent()) ?? '';

  await openActions(page);
  const btn = page.getByTestId('results-btn');
  await expect(btn).toHaveText('Results sheet');
  await btn.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByTestId('results-dialog');
  await expect(dlg).toBeVisible();
  const sheet = page.getByTestId('results-sheet');
  await expect(sheet.getByRole('heading', { name: 'Results sheet' })).toBeVisible();

  // Header
  await expect(page.getByTestId('sheet-target')).toHaveText("Barnard's Star");
  await expect(page.getByTestId('sheet-position')).toHaveText('RA 269.452100 deg, Dec 4.693400 deg');
  await expect(page.getByTestId('sheet-header')).toContainText('6 arcmin');
  await expect(page.getByTestId('sheet-url')).toContainText('/t/barnard?');
  await expect(page.getByTestId('sheet-url')).toContainText('det=6');
  await expect(page.getByTestId('sheet-generated')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // Data
  const data = page.getByTestId('sheet-data');
  await expect(data).toContainText('spherex_qr3');
  await expect(page.getByTestId('sheet-doi')).toHaveText('10.26131/IRSA662');
  await expect(data).toContainText('DEV FIXTURE');
  await expect(data).toContainText('dev-fixture');
  await expect(page.getByTestId('sheet-sequence')).toHaveText(/^[0-9a-f]{16}$/);
  const rows = page.getByTestId('sheet-epochs').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('E1');
  await expect(rows.nth(0)).toContainText('60813.4');
  await expect(rows.nth(0)).toContainText('68');
  await expect(rows.nth(0)).toContainText('D1, D2, D3, D4, D5, D6, broadband');

  // Frames shown
  await expect(page.getByTestId('sheet-mode')).toHaveText('Blink');
  await expect(page.getByTestId('sheet-detector')).toContainText('D6');
  await expect(page.getByTestId('sheet-detector')).toContainText('4.42 to 5.00 µm');
  await expect(page.getByTestId('sheet-stretch')).toContainText('asinh, -0.02 to 1.8 MJy/sr');

  // Measurements: the fit shown by the Measure panel, with its reference and agreement.
  await expect(page.getByTestId('sheet-pmra')).toHaveText(pmra);
  await expect(page.getByTestId('sheet-pmdec')).toHaveText(pmdec);
  await expect(page.getByTestId('sheet-pm-ref')).toContainText('DEV FIXTURE');
  await expect(page.getByTestId('sheet-pm-agreement')).toContainText('Agrees');
  expect(verdict).toContain('Agrees');
  // The spectrum was never opened in this view, so it is not in the sheet.
  await expect(page.getByTestId('sheet-spectrum')).toHaveCount(0);
  await expect(page.getByTestId('sheet-candidates')).toHaveCount(0);

  // Traceability
  const ids = page.getByTestId('sheet-obsids');
  await expect(ids.locator('li')).toHaveCount(21);
  await expect(ids).toContainText('E1 D6 (3):');
  await expect(ids).toContainText(/DEV-FIXTURE-[0-9a-f]{6}-1-6-1/);
  await expect(page.getByTestId('sheet-ack')).toContainText('SPHEREx, a joint project of');
  await expect(page.getByTestId('sheet-ack')).toContainText('Gaia');

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="results-dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );

  // Print: the dialog opens with the focus on its close button; the next control prints with Enter.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sheet-print')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => (window as unknown as { __prints: number }).__prints)).toBe(1);
  // With print media only the sheet is laid out, without the buttons.
  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('explorer')).toBeHidden();
  await expect(page.getByTestId('sheet-print')).toBeHidden();
  const paper = await sheet.evaluate((el) => {
    const d = el.closest('[data-sheet-dialog]') as HTMLElement;
    const cs = getComputedStyle(d);
    return { position: cs.position, translate: cs.translate, color: getComputedStyle(el).color };
  });
  expect(paper.position).toBe('static');
  expect(paper.translate).toBe('none');
  expect(paper.color).toBe('rgb(0, 0, 0)');
  await page.emulateMedia({ media: 'screen' });

  // JSON download from the keyboard.
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('sheet-json')).toBeFocused();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
  expect(dl.suggestedFilename()).toBe('destello-results-barnard-s-star.json');
  const doc = JSON.parse(readFileSync(await dl.path(), 'utf-8'));
  expect(Object.keys(doc)).toEqual([
    'schema_version',
    'generated_at_utc',
    'language',
    'view_url',
    'target',
    'data',
    'frames',
    'measurements',
    'warnings',
    'traceability',
  ]);
  expect(doc.target).toEqual({ name: "Barnard's Star", ra_deg: 269.4521, dec_deg: 4.6934, fov_arcmin: 6 });
  expect(doc.data.dois).toEqual(['10.26131/IRSA662']);
  expect(doc.data.epochs).toHaveLength(3);
  expect(doc.frames.detector).toBe(6);
  expect(doc.frames.stretch[0]).toMatchObject({ vmin: -0.02, vmax: 1.8, unit: 'MJy/sr' });
  expect(Object.keys(doc.measurements).sort()).toEqual(['position', 'proper_motion']);
  expect(typeof doc.measurements.proper_motion.fit.pmra_masyr).toBe('number');
  expect(doc.measurements.proper_motion.agreement_sigma).toBe(0.3);
  expect(doc.measurements.proper_motion.reference.source).toBe('DEV FIXTURE');
  expect(doc.traceability.obs_ids).toHaveLength(21);

  // Escape closes the dialog and the focus returns to the menu button that opened the sheet.
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(page.getByTestId('actions-more')).toBeFocused();
  expect(errors).toEqual([]);
});

test('F-30: without a loaded measurement the sheet says so and requests none', async ({ page }) => {
  const science: string[] = [];
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  page.on('request', (r) => /astrometry|spectrum|candidates/.test(r.url()) && science.push(r.url()));
  await openActions(page);
  await page.getByTestId('results-btn').click();
  await expect(page.getByTestId('results-sheet')).toBeVisible();
  await expect(page.getByTestId('sheet-nomeasurements')).toBeVisible();
  await expect(page.getByTestId('sheet-pm')).toHaveCount(0);
  await expect(page.getByTestId('sheet-preset')).toHaveCount(0);
  await expect(page.getByTestId('sheet-warnings')).toHaveCount(0);
  await expect(page.getByTestId('sheet-ack')).not.toContainText('Gaia');
  expect(science).toEqual([]);
});

test('F-30: the published preset result and the candidates counts appear when the view holds them', async ({
  page,
}) => {
  // fx=results is the fixture variant whose targets carry a published result (DEV FIXTURE numbers).
  await page.goto('/t/barnard?play=0&mode=diff&frame=2&cand=1&lang=en&fx=results');
  await ready(page);
  const listedInPanel = page.getByTestId('cand-counts').locator('[data-count="listed"] dd');
  await expect(listedInPanel).toHaveText(/^\d+$/, { timeout: 20_000 });
  const listed = (await listedInPanel.textContent()) ?? '';
  await openActions(page);
  await page.getByTestId('results-btn').click();
  const cand = page.getByTestId('sheet-candidates');
  await expect(cand.getByRole('heading')).toHaveText('Candidates to review');
  await expect(cand).toContainText('Epoch 2 minus epoch 1');
  await expect(page.getByTestId('sheet-cand-listed')).toHaveText(listed);
  await expect(cand).toContainText('It is not a detection of a new object');
  await expect(page.getByTestId('sheet-preset')).toContainText('DEV FIXTURE');
  await expect(page.getByTestId('sheet-mode')).toHaveText('Diff');
  // A difference is not drawn with the stretch of the coadds.
  await expect(page.getByTestId('sheet-stretch')).toContainText('Not applicable');
});

test('F-30: the sheet is in Spanish with lang=es', async ({ page }) => {
  await page.goto('/t/barnard?play=0&tab=measure&lang=es');
  await ready(page);
  await expect(page.getByTestId('measure-result')).toBeVisible({ timeout: 20_000 });
  await openActions(page);
  const btn = page.getByTestId('results-btn');
  await expect(btn).toHaveText('Ficha de resultados');
  await btn.click();
  const sheet = page.getByTestId('results-sheet');
  await expect(sheet.getByRole('heading', { name: 'Ficha de resultados' })).toBeVisible();
  await expect(page.getByTestId('sheet-target')).toHaveText('Estrella de Barnard');
  await expect(sheet.getByRole('heading', { name: 'Trazabilidad' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Movimiento propio ajustado' })).toBeVisible();
  await expect(page.getByTestId('sheet-pm-agreement')).toContainText('Coincide');
  await expect(page.getByTestId('sheet-print')).toHaveText('Imprimir o guardar como PDF');
  await expect(page.getByTestId('sheet-json')).toHaveText('Descargar JSON');
  // The keys of the JSON do not depend on the language.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sheet-json').click()]);
  const doc = JSON.parse(readFileSync(await dl.path(), 'utf-8'));
  expect(doc.language).toBe('es');
  expect(Object.keys(doc.measurements.proper_motion.fit)).toContain('pmra_masyr');
  expect(doc.target.name).toBe('Estrella de Barnard');
});

test('F-30: phone layout at 360 px opens the sheet from the tools row without horizontal overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await openActions(page);
  const btn = page.getByTestId('mobile-tools').getByTestId('results-btn');
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  const dlg = page.getByTestId('results-dialog');
  await expect(dlg).toBeVisible();
  await expect(page.getByTestId('sheet-obsids')).toContainText('DEV-FIXTURE-');
  const overflow = await page.evaluate(() => {
    const d = document.querySelector('[data-testid="results-dialog"]') as HTMLElement;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: d.scrollWidth - d.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.dialog).toBeLessThanOrEqual(0);
});
