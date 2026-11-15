import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

test.beforeEach(async ({ page }) => {
  // Specs assert fixture data; force fixtures even when the real backend is listening.
  await page.addInitScript(() => sessionStorage.setItem('destello.fx', 'fixtures'));
});

const OUT = path.resolve(process.cwd(), '../qa/screens/B5');

async function settle(page: Page) {
  await page.waitForTimeout(1200);
}
async function ready(page: Page) {
  await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
}

for (const w of [1440, 1280, 390]) {
  for (const lang of ['en', 'es']) {
    const mobile = w < 600;
    test(`shots ${w} ${lang}`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: mobile ? 844 : 900 });
      const shot = async (name: string) => {
        await settle(page);
        await page.screenshot({ path: path.join(OUT, `${name}-${w}-${lang}.png`), fullPage: false });
      };
      const q = `lang=${lang}&play=0`;
      await page.goto(`/t/barnard?${q}`);
      await ready(page);
      await shot('explorer');
      await page.goto(`/t/rdra?${q}`);
      await ready(page);
      await expect(page.getByTestId('spectrum-plot')).toHaveAttribute('data-state', 'ready', {
        timeout: 20_000,
      });
      await shot('spectrum');
      await page.goto(`/t/barnard?${q}&tab=measure`);
      await ready(page);
      await expect(page.getByTestId('residual-plot')).toHaveAttribute('data-state', 'ready', {
        timeout: 20_000,
      });
      await shot('measure');
      await page.goto(`/t/barnard?${q}&tab=context`);
      await ready(page);
      await expect(page.getByTestId('context-panel')).toHaveAttribute('data-state', /ready|failed/, {
        timeout: 30_000,
      });
      await page.waitForTimeout(2500);
      await shot('context');
      for (const p of ['validation', 'science', 'about']) {
        await page.goto(`/${p}?lang=${lang}`);
        await page.waitForTimeout(800);
        await shot(p);
      }
      await page.goto(`/embed?target=barnard&play=0&lang=${lang}`);
      await expect(page.getByTestId('btn-play')).toBeEnabled({ timeout: 20_000 });
      await shot('embed');
      await page.goto(`/t/barnard?${q}`);
      await ready(page);
      await page.getByTestId('share-btn').click();
      await expect(page.getByTestId('share-dialog')).toBeVisible();
      await shot('share');
      if (mobile) {
        await page.keyboard.press('Escape');
        await page.getByTestId('sheet-handle').click();
        await shot('mobile-sheet-half');
      }
    });
  }
}
