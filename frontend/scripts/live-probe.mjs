// Live probe against the real API through the dev server (pnpm dev). Reports load timing and ring-to-source offsets.
import { chromium } from '@playwright/test';
const base = process.env.BASE ?? 'http://localhost:5173';
const ids = (process.env.IDS ?? 'barnard,wise0855,epsindib,rwaur,rdra').split(',');
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 140)); });
page.on('response', (r) => { if (r.status() >= 400) errors.push(r.status() + ' ' + r.url().replace(base, '')); });
for (const id of ids) {
  await page.goto(base + '/about');
  await page.evaluate(() => sessionStorage.removeItem('destello.fx'));
  const t0 = Date.now();
  await page.goto(`${base}/t/${id}`);
  const ok = await page
    .waitForFunction(() => {
      const c = document.querySelector('canvas');
      if (!c || !window.__destello?.ring) return false;
      const g = c.getContext('2d');
      if (!g) return false;
      const d = g.getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i];
      return s > 500;
    }, null, { timeout: 30000, polling: 25 })
    .then(() => true, () => false);
  const tFrame = Date.now() - t0;
  await page.waitForTimeout(2200);
  const playing = await page.evaluate(() => document.querySelector('[data-testid=btn-play]')?.textContent?.trim());
  const res = await page.evaluate(async () => {
    const dbg = window.__destello;
    const seqId = location.pathname; 
    const targets = await (await fetch('/api/v1/targets')).json();
    const id = location.pathname.split('/').pop();
    const sid = targets.find((t) => t.id === id).sequence_id;
    const mf = await (await fetch(`/api/v1/sequences/${sid}`)).json();
    const m = await (await fetch(mf.manifest_url)).json();
    const out = [];
    for (const e of m.epochs) {
      const pos = dbg.epochPositions[e.index];
      for (const f of e.frames) {
        const bmp = await createImageBitmap(await (await fetch(f.url)).blob());
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const g = cv.getContext('2d');
        g.drawImage(bmp, 0, 0);
        const W = bmp.width;
        const px = g.getImageData(0, 0, W, bmp.height).data;
        const val = (x, y) => (px[(y * W + x) * 4 + 3] === 0 ? 0 : px[(y * W + x) * 4]);
        let best = -1, bx = 0, by = 0;
        const R = 6;
        for (let y = Math.round(pos.y) - R; y <= Math.round(pos.y) + R; y++)
          for (let x = Math.round(pos.x) - R; x <= Math.round(pos.x) + R; x++) {
            if (x < 1 || y < 1 || x >= W - 1 || y >= bmp.height - 1) continue;
            let s = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += val(x + dx, y + dy);
            if (s > best) { best = s; bx = x; by = y; }
          }
        // Centroid of the connected-ish blob above half of the local peak within 10 px of the ring.
        const pk = best / 9;
        let sw = 0, sx = 0, sy = 0;
        for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
          const x = Math.round(pos.x) + dx, y = Math.round(pos.y) + dy;
          if (x < 0 || y < 0 || x >= W || y >= bmp.height) continue;
          const v = val(x, y) - 0.5 * pk;
          if (v > 0 && Math.hypot(x - bx, y - by) <= 7) { sw += v; sx += v * x; sy += v * y; }
        }
        const cx = sx / sw + 0.5, cy = sy / sw + 0.5; // pixel centres at i+0.5, ring in edge coordinates
        // local background: median of whole frame
        const all = []; for (let i = 0; i < W * bmp.height; i += 7) all.push(px[i * 4]);
        all.sort((a, b) => a - b);
        out.push({ e: e.index + 1, det: f.detector, ring: [+pos.x.toFixed(1), +pos.y.toFixed(1)], dx: +(cx - pos.x).toFixed(2), dy: +(cy - pos.y).toFixed(2), off: +Math.hypot(cx - pos.x, cy - pos.y).toFixed(2), peak: Math.round(best / 9), med: all[all.length >> 1] });
      }
    }
    return { W: dbg.n, out };
  });
  console.log(JSON.stringify({ id, drawnMs: ok ? tFrame : null, playBtn: playing, n: res.W }));
  for (const r of res.out) console.log(' ', JSON.stringify(r));
}
console.log('console errors:', JSON.stringify(errors));
await browser.close();
