import { test, expect } from './fixtures';

test.describe('onboarding tab', () => {
  /** full-tab onboarding waits on `walletExists` via tRPC; MV3 cold start can exceed short CI timeouts. dev harness covers setup CTAs in onboarding-wallet-surface + side-panel specs. */
  test('onboarding html loads and react shell mounts', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/onboarding.html`, {
      waitUntil: 'load',
    });
    await expect(page).toHaveTitle(/get started/i);
    await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 });
    await expect(
      page
        .getByText(
          /loading…|on the spectrum|couldn't reach the wallet background|create or restore|Something went wrong/i,
        )
        .first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
