import { test, expect } from './fixtures';

test.describe('onboarding wallet surface', () => {
  test('setup choose shows create vault CTA (dev harness, no cold trpc)', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      vaultExists: '0',
      unlocked: '0',
      setupStep: 'choose',
      setupIntent: 'create',
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('button', { name: /create new dWallet Vault/i })).toBeVisible({
      timeout: 20_000,
    });
  });
});
