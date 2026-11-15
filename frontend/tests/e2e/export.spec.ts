import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

// F-25 export. Fixture mode: the frames are a DEV FIXTURE; the test checks the export mechanics, not science.
/** Number of images in a GIF, read by walking its blocks. */
function gifImages(b: Uint8Array): number {
  let p = 13;
  if (b[10] & 0x80) p += 3 * (1 << ((b[10] & 7) + 1));
  const skipSub = () => {
    while (b[p] !== 0) p += b[p] + 1;
    p++;
  };
  let images = 0;
  while (p < b.length && b[p] !== 0x3b) {
    if (b[p] === 0x21) {
      p += 2;
      skipSub();
    } else if (b[p] === 0x2c) {
      images++;
      const flags = b[p + 9];
      p += 10;
      if (flags & 0x80) p += 3 * (1 << ((flags & 7) + 1));
      p++;
      skipSub();
    } else throw new Error(`bad block at ${p}`);
  }
  return images;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

test('F-25: the blink is exported as a looping GIF from the keyboard', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/t/barnard?play=0&ov=gaia');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  const btn = page.getByTestId('export-btn');
  await btn.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByTestId('export-dialog');
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Gaia');
  const frames = Number(await page.getByTestId('export-frames').textContent());
  expect(frames).toBeGreaterThan(1);
  await page.getByTestId('export-create').focus();
  await page.keyboard.press('Enter');
  const link = page.getByTestId('export-download');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('export-status')).toContainText('GIF ready');
  await expect(page.getByTestId('export-preview')).toHaveAttribute('data-animated', 'true');
  const axe = await new AxeBuilder({ page })
    .include('[data-testid="export-dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(axe.violations).toEqual([]);
  const [dl] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(dl.suggestedFilename()).toMatch(/^destello-.*-blink\.gif$/);
  const path = await dl.path();
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 6).toString('latin1')).toBe('GIF89a');
  // One image per exported frame.
  expect(gifImages(new Uint8Array(bytes))).toBe(frames);
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('F-25: with reduced motion the preview is a still frame and the file stays animated', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/t/barnard?play=0&lang=es');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('export-btn').click();
  await page.getByTestId('export-create').click();
  await expect(page.getByTestId('export-download')).toBeVisible({ timeout: 30_000 });
  const prev = page.getByTestId('export-preview');
  await expect(prev).toHaveAttribute('data-animated', 'false');
  await expect(prev).toHaveAttribute('src', /^data:image\/png/);
  await expect(page.getByTestId('export-dialog')).toContainText('movimiento reducido');
});

test('F-36: the export dialog offers the Python notebook of the sequence', async ({ page }) => {
  // Fixture mode has no backend: the notebook request is answered by the test.
  await page.route('**/api/v1/sequences/*/notebook', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/x-ipynb+json',
      headers: { 'Content-Disposition': 'attachment; filename="destello-x.ipynb"' },
      body: JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    }),
  );
  await page.goto('/t/barnard?play=0');
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId('export-btn').click();
  const link = page.getByTestId('export-python');
  await expect(link).toHaveAttribute('href', /\/api\/v1\/sequences\/[0-9a-f]{16}\/notebook$/);
  await expect(link).toHaveAttribute('download', /^destello-[0-9a-f]{16}\.ipynb$/);
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toMatch(/\.ipynb$/);
});
