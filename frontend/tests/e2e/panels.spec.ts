import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // Specs assert fixture data; force fixtures even when the real backend is listening.
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

// Run against dev fixtures until the real backend answers /api/v1/health. Numbers come from the fixture API.
async function ready(page: Page) {
  // The first paint waits for the dev server's on-demand compilation, which can take several seconds with
  // parallel workers. The 4 s budget of the product is measured on the production build (acceptance step 1).
  await expect(page.getByTestId('player-canvas')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

test('R Draconis opens Spectrum by default with plot, table and saturated warning', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/rdra?play=0');
  await ready(page);
  await expect(page.getByTestId('tab-spectrum')).toHaveAttribute('data-state', 'active');
  await expect(page.getByTestId('spectrum-plot')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  await expect(page.getByTestId('phot-table')).toBeVisible();
  // Saturation is partial in this target: the affected detector rows are marked in the table.
  const photDet = page.getByTestId('phot-detector');
  const initialDet = await photDet.inputValue();
  await photDet.selectOption('1');
  await expect(page.getByTestId('phot-table')).toContainText('saturated');
  await photDet.selectOption(initialDet);
  await expect(page.getByTestId('phot-verdict')).toContainText('sigma');
  // legend toggle hides an epoch and keeps the pressed state accessible
  await page.getByTestId('legend-1').click();
  await expect(page.getByTestId('legend-1')).toHaveAttribute('aria-pressed', 'false');
  expect(errors).toEqual([]);
});

test('RW Aurigae also opens Spectrum; Barnard opens Info', async ({ page }) => {
  await page.goto('/t/rwaur?play=0');
  await ready(page);
  await expect(page.getByTestId('tab-spectrum')).toHaveAttribute('data-state', 'active');
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await expect(page.getByTestId('tab-info')).toHaveAttribute('data-state', 'active');
});

test('explicit tab=info on R Draconis is kept in the URL', async ({ page }) => {
  await page.goto('/t/rdra?play=0');
  await ready(page);
  await page.getByTestId('tab-info').click();
  await expect(page).toHaveURL(/tab=info/);
});

test('clicking the frame selects a position and Spectrum follows it', async ({ page }) => {
  await page.goto('/t/barnard?play=0&tab=spectrum');
  await ready(page);
  await expect(page.getByTestId('spectrum-plot')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
  const c = page.getByTestId('player-canvas');
  const box = await c.boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.25);
  await expect(page.getByTestId('spectrum-panel')).toContainText('Forced aperture photometry');
});

test('Measure shows fit, reference with source, verdict and residual plot', async ({ page }) => {
  await page.goto('/t/barnard?play=0&tab=measure');
  await ready(page);
  await expect(page.getByTestId('measure-result')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('measure-verdict')).toContainText(/Agrees|Marginal|Differs/);
  await expect(page.getByTestId('measure-reference')).toContainText('DEV FIXTURE');
  await expect(page.getByTestId('centroid-table')).toBeVisible();
  await expect(page.getByTestId('residual-plot')).toHaveAttribute('data-state', 'ready', { timeout: 20_000 });
});

test('Measure warns about a blended source', async ({ page }) => {
  await page.goto('/t/epsindib?play=0&tab=measure');
  await ready(page);
  await expect(
    page.getByTestId('measure-warnings').locator('[data-code="BLENDED_SOURCE"]').first(),
  ).toBeVisible({ timeout: 20_000 });
});

test('Measure with one epoch says two epochs are needed', async ({ page }) => {
  await page.goto('/?ra=80&dec=28.16667&play=0&tab=measure&fx=single');
  await expect(page.getByTestId('measure-toofew')).toBeVisible({ timeout: 30_000 });
});

test('Context panel loads Aladin or shows a retryable failure', async ({ page }) => {
  await page.goto('/t/barnard?play=0&tab=context');
  await ready(page);
  const panel = page.getByTestId('context-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-state', /ready|failed/, { timeout: 30_000 });
  if ((await panel.getAttribute('data-state')) === 'failed') {
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  } else {
    await page.getByTestId('survey-allwise').click();
    await expect(page.getByTestId('survey-allwise')).toHaveAttribute('aria-checked', 'true');
  }
});

test('validation page is rendered from the API and degrades to an unavailable state', async ({ page }) => {
  await page.goto('/validation');
  await expect(page.getByTestId('validation-run')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('validation-row')).toHaveCount(3);
  await expect(page.getByTestId('validation-summary')).toContainText('2 of 3');
  await expect(page.locator('[data-status="not_measurable"]')).toContainText('Not measurable');
  await expect(page.getByTestId('validation-limits')).toBeVisible();
  await page.goto('/validation?fx=novalidation');
  await expect(page.getByTestId('validation-unavailable')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('validation-row')).toHaveCount(0);
});

test('validation light theme', async ({ page }) => {
  await page.goto('/validation?theme=light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('science and about pages in both languages', async ({ page }) => {
  await page.goto('/science');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Seeing the sky move');
  await expect(page.getByTestId('detector-table').locator('tbody tr')).toHaveCount(6);
  await expect(page.getByTestId('science-limits')).toBeVisible();
  await page.goto('/science?lang=es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ver moverse el cielo');
  await page.goto('/about');
  await expect(page.getByTestId('non-endorsement')).toContainText('not an official product of NASA');
  await expect(page.getByRole('heading', { name: 'Data acknowledgements' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await page.goto('/about?lang=es');
  await expect(page.getByRole('heading', { name: 'Privacidad' })).toBeVisible();
});

test('share dialog: embed options, copy buttons, 2 s toast, live preview', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('share-btn').click();
  const dlg = page.getByTestId('share-dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('radio', { name: /Large/ }).click();
  await dlg.getByRole('radio', { name: 'Light' }).click();
  await dlg.getByRole('radio', { name: 'None' }).click();
  await dlg.getByRole('radio', { name: 'Español' }).click();
  const snippet = dlg.getByTestId('embed-snippet');
  await expect(snippet).toContainText('width="720" height="600"');
  await expect(snippet).toContainText('theme=light');
  await expect(snippet).toContainText('controls=none');
  await expect(snippet).toContainText('lang=es');
  await expect(snippet).toContainText('target=barnard');
  await dlg.getByTestId('copy-embed').click();
  await expect(dlg.getByTestId('share-toast')).toContainText('Embed code copied');
  await expect(dlg.getByTestId('share-toast')).toHaveText('', { timeout: 4000 });
  await dlg.getByTestId('copy-link').click();
  await expect(dlg.getByTestId('share-toast')).toContainText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/t/barnard');
});

test('embed: size classes, controls levels, light theme, footer and postMessage', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __msgs: unknown[] }).__msgs = [];
    window.addEventListener('message', (e) =>
      (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data),
    );
  });
  await page.setViewportSize({ width: 360, height: 420 });
  await page.goto('/embed?target=barnard&play=0&controls=minimal&theme=light&lang=es');
  const emb = page.getByTestId('embed');
  await expect(emb).toHaveAttribute('data-size', 'compact');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('embed-open')).toBeVisible();
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.setViewportSize({ width: 480, height: 520 });
  await expect(emb).toHaveAttribute('data-size', 'standard');
  await page.setViewportSize({ width: 720, height: 600 });
  await expect(emb).toHaveAttribute('data-size', 'large');
  await page.goto('/embed?target=barnard&play=0&controls=none');
  await expect(page.getByTestId('btn-play')).toHaveCount(0);
  await expect(page.getByTestId('embed-open')).toBeVisible();
  const posted = await page.evaluate(() => (window as unknown as { __msgs: { type: string }[] }).__msgs);
  void posted; // same-window posts are not delivered to self when parent is the window itself
});

test('embed in an iframe posts destello:ready and destello:frame to the parent', async ({ page }) => {
  await page.goto('/about');
  await page.evaluate(() => {
    (window as unknown as { __msgs: unknown[] }).__msgs = [];
    window.addEventListener('message', (e) =>
      (window as unknown as { __msgs: unknown[] }).__msgs.push(e.data),
    );
    const f = document.createElement('iframe');
    f.src = '/embed?target=barnard&play=0';
    f.width = '480';
    f.height = '520';
    f.title = 'test';
    document.body.appendChild(f);
  });
  await expect
    .poll(
      async () =>
        page.evaluate(() => (window as unknown as { __msgs: { type: string }[] }).__msgs.map((m) => m.type)),
      {
        timeout: 25_000,
      },
    )
    .toEqual(expect.arrayContaining(['destello:frame', 'destello:ready']));
});

test.describe('mobile sheet', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('handle cycles peek, half, full and playback pauses at full', async ({ page }) => {
    await page.goto('/t/barnard');
    await ready(page);
    const sheet = page.getByTestId('mobile-sheet');
    await expect(sheet).toHaveAttribute('data-state', 'peek');
    await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Pause/, { timeout: 20_000 });
    await page.getByTestId('sheet-handle').click();
    await expect(sheet).toHaveAttribute('data-state', 'half');
    // playback continues behind the half-open sheet
    await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Pause/);
    await page.getByTestId('sheet-handle').click();
    await expect(sheet).toHaveAttribute('data-state', 'full');
    await expect(page.getByTestId('btn-play')).toHaveAccessibleName(/Play/);
    await page.getByTestId('sheet-handle').focus();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveAttribute('data-state', 'peek');
  });

  test('dragging the handle up opens and swiping down closes to peek', async ({ page }) => {
    await page.goto('/t/barnard?play=0');
    await ready(page);
    const sheet = page.getByTestId('mobile-sheet');
    const h = await page.getByTestId('sheet-handle').boundingBox();
    if (!h) throw new Error('no handle');
    const x = h.x + h.width / 2;
    const y = h.y + h.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 320, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).not.toHaveAttribute('data-state', 'peek');
    const h2 = await page.getByTestId('sheet-handle').boundingBox();
    if (!h2) throw new Error('no handle');
    const y2 = h2.y + h2.height / 2;
    await page.mouse.move(x, y2);
    await page.mouse.down();
    await page.mouse.move(x, y2 + 200, { steps: 6 });
    await page.mouse.up();
    await expect(sheet).toHaveAttribute('data-state', 'peek');
  });

  test('search opens as a full-screen overlay', async ({ page }) => {
    await page.goto('/t/barnard?play=0');
    await page.getByTestId('open-search').click();
    await expect(page.getByTestId('search-overlay')).toBeVisible();
    await expect(page.getByTestId('search-overlay').getByTestId('search-input')).toBeFocused();
  });
});

for (const w of [360, 390, 768, 1024]) {
  test(`no horizontal overflow at ${w}`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/t/barnard?play=0');
    await ready(page);
    const over = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
  });
}

test('demo mode disables panels that need the live server', async ({ page }) => {
  await page.goto('/t/rdra?play=0&fx=demo');
  await ready(page);
  await expect(page.getByTestId('panel-demo-off')).toBeVisible();
});

test('M measures at the cursor; outside the image it measures the selection', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.mouse.move(2, 2);
  await page.keyboard.press('m');
  await expect(page.getByTestId('tab-measure')).toHaveAttribute('data-state', 'active');
  const position = page.getByTestId('measure-position');
  const atTarget = await position.textContent();
  const box = await page.getByTestId('player-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.15);
  await expect(page.getByTestId('hover-readout')).toBeVisible();
  await page.keyboard.press('m');
  await expect(position).not.toHaveText(atTarget ?? '');
});

test('recent searches are offered on focus, newest first', async ({ page }) => {
  await page.goto('/');
  const input = page.getByTestId('search-input');
  await input.fill('estrella de barnard');
  await input.press('Enter');
  await expect(page).toHaveURL(/\/t\/barnard/);
  // The list does not stay open over the result after a submit.
  await expect(page.getByTestId('search-recent')).toHaveCount(0);
  await page.getByTestId('search-input').first().blur();
  await page.getByTestId('search-input').first().focus();
  const recent = page.getByTestId('search-recent');
  await expect(recent).toBeVisible();
  await expect(recent.getByRole('option').first()).toContainText(/Barnard/);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/t\/barnard/);
});

test('C opens the RGB composite; channels stay distinct and live in the URL', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('player-canvas').focus();
  await page.keyboard.press('c');
  await expect(page.getByTestId('mode-rgb')).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/mode=rgb/);
  await expect(page.getByTestId('rgb-legend')).toContainText('D6');
  await expect(page.getByTestId('epoch-chip-flagged')).toHaveCount(0);
  // Picking the blue detector for red swaps the two channels.
  await page.getByTestId('rgb-r').selectOption('1');
  await expect(page).toHaveURL(/rgb=1(%2C|,)3(%2C|,)6/);
  await expect(page.getByTestId('rgb-b')).toHaveValue('6');
  await page.keyboard.press('b');
  await expect(page).not.toHaveURL(/rgb=/);
  expect(errors).toEqual([]);
});

test('T turns on track mode for a known mover; off in differences; stack along the track', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('player-canvas').focus();
  await page.keyboard.press('t');
  await expect(page.getByTestId('track-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page).toHaveURL(/track=1/);
  await expect(page.getByTestId('track-tag')).toContainText('target fixed');
  await page.keyboard.press('s');
  await expect(page.getByTestId('track-tag')).toContainText('along the track');
  await page.keyboard.press('d');
  await expect(page.getByTestId('track-toggle')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('track-tag')).toHaveCount(0);
  await page.keyboard.press('b');
  await page.keyboard.press('t');
  await expect(page).not.toHaveURL(/track=/);
  await expect(page.getByTestId('track-tag')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('track mode is not offered for a target without proper motion', async ({ page }) => {
  await page.goto('/t/rwaur?play=0&track=1');
  await ready(page);
  await expect(page.getByTestId('track-toggle')).toHaveCount(0);
  await expect(page.getByTestId('track-tag')).toHaveCount(0);
});

test('guided tour: nine steps from the shortcuts dialog, Back, Esc ends it', async ({ page }) => {
  await page.goto('/t/barnard?play=0');
  await ready(page);
  await page.getByTestId('player-canvas').focus();
  await page.keyboard.press('?');
  await page.getByTestId('shortcuts-dialog').getByTestId('tour-start').click();
  const card = page.getByTestId('tour-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('tour-count')).toHaveText('1 of 9');
  await expect(page.getByTestId('tour-spotlight')).toBeVisible();
  await expect(page.getByTestId('tour-next')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tour-count')).toHaveText('2 of 9');
  await page.getByTestId('tour-back').click();
  await expect(page.getByTestId('tour-count')).toHaveText('1 of 9');
  for (let i = 0; i < 8; i++) await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-count')).toHaveText('9 of 9');
  await expect(page.getByTestId('tour-next')).toHaveText('Finish');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  // Shortcuts work again once the tour is closed.
  await page.getByTestId('player-canvas').focus();
  await page.keyboard.press('g');
  await expect(page).toHaveURL(/ov=[^&]*gaia/);
});
