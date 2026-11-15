// F-33 comet page on the dev fixtures: exposure blink by keyboard, aligned stack, spectrum panel, NEOSSat panel
// and its empty state, EN and ES, axe and the 390 px layout. Fixture frames are synthetic, not SPHEREx data.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

async function audit(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .exclude('[data-testid="mover-spectrum-plot"]')
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual(
    [],
  );
}

async function open(page: Page, q = 'lang=en') {
  await page.goto(`/comet?${q}`);
  await expect(page.getByTestId('comet-frame')).toBeVisible({ timeout: 20_000 });
}

test('exposures follow the comet, step by keyboard, one detector at a time', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('comet-follows')).toContainText('follow the comet');
  const hud = page.getByTestId('comet-hud');
  await expect(hud).toContainText('Frame 1 of 8');
  await expect(hud).toContainText('µm');
  const ra0 = await page.getByTestId('comet-reticle').getAttribute('data-ra');
  await page.getByTestId('comet-slider').focus();
  await page.keyboard.press('ArrowRight');
  await expect(hud).toContainText('Frame 2 of 8');
  // Each frame uses its own center: the reticle position follows the frame.
  expect(await page.getByTestId('comet-reticle').getAttribute('data-ra')).not.toBe(ra0);
  await page.keyboard.press('End');
  await expect(hud).toContainText('Frame 8 of 8');
  await page.getByTestId('comet-det-3').click();
  await expect(page.getByTestId('comet-obs')).toContainText('D3');
  // No autoplay.
  await expect(page.getByTestId('comet-play')).toHaveAttribute('aria-pressed', 'false');
  await expect(page).toHaveURL(/det=3/);
});

test('aligned stack view', async ({ page }) => {
  await open(page);
  await page.getByTestId('comet-mode-stack').click();
  await expect(page.getByTestId('comet-frame')).toHaveAttribute('data-frame-kind', 'stack');
  await expect(page.getByTestId('comet-follows')).toContainText('stars trail');
});

test('spectrum panel states the aperture, the bands and that V-13 is not measurable', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('mover-spectrum-plot')).toHaveAttribute('data-state', 'ready', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('mover-aperture')).toContainText('24.8');
  await expect(page.getByTestId('band-CO2')).toHaveAttribute('data-state', 'not_measurable');
  await expect(page.getByTestId('band-CO2')).toContainText('No detection is claimed');
  await expect(page.getByTestId('mover-positions')).toContainText('JPL Horizons');
  await expect(page.getByTestId('mover-positions')).toContainText('parallax');
  await expect(page.getByTestId('comet-co2')).toContainText('no detection of CO2 is claimed');
  await expect(page.getByTestId('mover-ephemeris-check')).toContainText('48 of 48');
});

test('NEOSSat panel shows the nearest frame and the empty state', async ({ page }) => {
  await open(page);
  const p = page.getByTestId('neossat-panel');
  await expect(p).toContainText('Optical view: NEOSSat (Canadian Space Agency)');
  await expect(page.getByTestId('neossat-different')).toContainText('not SPHEREx data');
  await expect(page.getByTestId('neossat-image')).toBeVisible();
  await expect(page.getByTestId('neossat-dt')).toContainText('6.0 hours');
  await expect(page.getByTestId('neossat-approx')).toContainText('approximate');
  await expect(page.getByTestId('neossat-credit')).toHaveText(
    'NEOSSat, Canadian Space Agency; Canadian Astronomy Data Centre',
  );
  await page.getByTestId('comet-slider').focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('neossat-empty')).toContainText('No NEOSSat frames for this object and time');
});

test('preset chip opens the comet page', async ({ page }) => {
  await page.goto('/?lang=en');
  await page.getByTestId('chip-comet').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3I/ATLAS, an interstellar comet');
});

for (const lang of ['en', 'es']) {
  test(`axe (${lang})`, async ({ page }) => {
    await open(page, `lang=${lang}`);
    await expect(page.getByTestId('mover-spectrum-plot')).toHaveAttribute('data-state', 'ready', {
      timeout: 20_000,
    });
    await audit(page);
    await page.screenshot({ path: `../qa/screens/sprint/comet/comet-${lang}-1440.png`, fullPage: true });
  });
}

test('Spanish copy', async ({ page }) => {
  await open(page, 'lang=es');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('3I/ATLAS, un cometa interestelar');
  await expect(page.getByTestId('comet-hud')).toContainText('Cuadro 1 de 8');
  await expect(page.getByTestId('neossat-panel')).toContainText('NEOSSat (Agencia Espacial Canadiense)');
  await expect(page.getByTestId('band-CO2')).toContainText('No se afirma ninguna detección');
});

test('390 px layout has no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(over).toBe(false);
  await audit(page);
  await page.screenshot({ path: '../qa/screens/sprint/comet/comet-390.png', fullPage: true });
});
