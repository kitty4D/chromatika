import { test, expect } from './fixtures';

test.describe('popup', () => {
  test('shows chromatika setup when vault is empty (dev harness)', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      vaultExists: '0',
      unlocked: '0',
    });
    await page.goto(`chrome-extension://${extensionId}/index.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/welcome to chromatika/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: /open full onboarding tab/i })).toBeVisible({
      timeout: 15_000,
    });
  });
});
