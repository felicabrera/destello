// F-22 Report a mover, end to end against the dev fixtures (docs/02 F-22, docs/06 section 3.6).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function openActions(page: Page) {
  const more = page.getByTestId('actions-more');
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
}

async function ready(page: Page) {
  // The first paint waits for the dev server's on-demand compilation, which can take several seconds with
  // parallel workers. The 4 s budget of the product is measured on the production build (acceptance step 1).
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

test('mark two epochs by keyboard, run checks, submit, open the public page', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/t/barnard?play=0&frame=0&lang=en');
  await ready(page);

  await openActions(page);
  await page.getByTestId('report-btn').click();
  const flow = page.getByTestId('report-flow');
  await expect(flow).toBeVisible();
  await expect(page.getByTestId('report-run')).toBeDisabled();

  await page.getByTestId('report-place').click();
  await flow.getByRole('button', { name: 'Move the mark one pixel north' }).click();
  await flow.getByRole('button', { name: 'Show E3' }).click();
  await page.getByTestId('report-place').click();
  await flow.getByRole('button', { name: 'Move the mark one pixel east' }).click();
  await expect(page.getByTestId('report-marks').getByText('Marked')).toHaveCount(2);

  await page.getByTestId('report-run').click();
  await expect(page.getByTestId('report-verdict')).toContainText('No catalog match', { timeout: 20_000 });
  await expect(page.getByTestId('report-checks')).toContainText('JPL SBIdent');
  await expect(page.getByTestId('report-motion')).toBeVisible();

  await page.getByTestId('report-to-notes').click();
  await page.getByTestId('report-notes').fill('Faint source shifts between E1 and E3.');
  await page.getByTestId('report-contact').fill('not an email');
  await expect(page.getByTestId('report-submit')).toBeDisabled();
  await page.getByTestId('report-contact').fill('reporter@example.org');
  await expect(page.getByTestId('turnstile')).toHaveCount(0);
  await page.getByTestId('report-submit').click();

  await expect(page.getByTestId('report-next')).toContainText(
    'does not review reports or send them anywhere',
  );
  await expect(page.getByTestId('report-link')).toContainText(/\/r\/fx[0-9a-f]{8}/);
  await page.getByRole('link', { name: 'Open report page' }).click();

  await expect(page).toHaveURL(/\/r\/fx[0-9a-f]{8}/);
  await expect(page.getByTestId('report-page')).toBeVisible();
  await expect(page.getByTestId('report-unconfirmed')).toHaveText('Unconfirmed');
  await expect(page.getByTestId('report-notes-public')).toContainText('Faint source shifts');
  await expect(page.getByTestId('report-page')).not.toContainText('reporter@example.org');
  await expect(page.getByTestId('report-page')).not.toContainText(/discover/i);
  expect(errors).toEqual([]);
});

test('report button toggles the flow and reflects it in aria-pressed', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=en');
  await ready(page);
  await openActions(page);
  const btn = page.getByTestId('report-btn');
  await btn.click();
  await expect(page.getByTestId('report-flow')).toBeVisible();
  await openActions(page);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await expect(page.getByTestId('report-flow')).toHaveCount(0);
});

for (const lang of ['en', 'es']) {
  test(`public report page renders and passes axe (${lang})`, async ({ page }) => {
    await page.goto(`/r/fxReport01?lang=${lang}`);
    await expect(page.getByTestId('report-page')).toBeVisible();
    await expect(page.getByTestId('report-unconfirmed')).toHaveText(
      lang === 'en' ? 'Unconfirmed' : 'No confirmado',
    );
    await expect(page.getByTestId('report-verdict')).toBeVisible();
    await expect(page.getByTestId('report-crops').locator('canvas')).toHaveCount(3, { timeout: 20_000 });
    await audit(page);
  });
}

test('unknown report id shows the not-found notice', async ({ page }) => {
  await page.goto('/r/zzzzzzzzzz?lang=en');
  await expect(page.getByTestId('report-page-notice')).toContainText('does not exist', { timeout: 20_000 });
});

test('report flow is axe clean on the marking step (es)', async ({ page }) => {
  await page.goto('/t/barnard?play=0&lang=es');
  await ready(page);
  await openActions(page);
  await page.getByTestId('report-btn').click();
  await expect(page.getByTestId('report-flow')).toBeVisible();
  await audit(page);
});

test('phones: the report flow opens from the tools row and a tap on the frame places the mark', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/t/barnard?play=0&frame=0&lang=es');
  await ready(page);
  await openActions(page);
  const btn = page.getByTestId('mobile-tools').getByTestId('report-btn');
  await btn.click();
  const flow = page.getByTestId('report-flow');
  await expect(flow).toBeVisible();
  // The sheet gives way to the flow so the frame stays tappable.
  await expect(page.getByTestId('mobile-sheet')).toHaveCount(0);
  await page.getByTestId('player-canvas').click({ position: { x: 120, y: 120 } });
  await expect(page.getByTestId('report-marks').getByText('Marcada')).toHaveCount(1);
  await audit(page);
  await openActions(page);
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await btn.click();
  await expect(flow).toHaveCount(0);
});
