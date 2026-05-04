import { defineConfig, devices } from '@playwright/test';

/**
 * e2e tests load the built MV3 extension from `dist/` via `e2e/fixtures.ts`
 * (headed `launchPersistentContext` + --load-extension). run `pnpm run build` first
 * or use `pnpm run test:e2e` which builds then runs Playwright.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    headless: false,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        headless: false,
      },
    },
  ],
});
