import { defineConfig } from '@playwright/test';

// The guided tour opens by itself on a first visit (F-24). Specs start with it marked as seen so it never covers
// the page under test; tests/e2e/tour.spec.ts clears this state to test the tour itself.
export const TOUR_SEEN = {
  cookies: [],
  origins: [{ origin: 'http://localhost:5173', localStorage: [{ name: 'destello.tourSeen', value: '1' }] }],
};

// Screenshot run for qa/screens: pnpm exec playwright test -c playwright.shots.config.ts
export default defineConfig({
  testDir: './tests/shots',
  timeout: 120_000,
  workers: 1,
  use: { baseURL: 'http://localhost:5173', channel: 'chrome', storageState: TOUR_SEEN },
  webServer: {
    command: 'pnpm dev --port 5173 --strictPort',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
