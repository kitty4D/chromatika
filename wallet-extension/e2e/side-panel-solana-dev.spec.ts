import { test, expect } from './fixtures';

test.describe('side panel dev solana ika', () => {
  test('smoke: solana ika dev query loads shell without crash', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      unlocked: '1',
      vaultExists: '1',
      tab: 'vault',
      solanaIka: '1',
    });
    const resp = await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    expect(resp?.ok()).toBeTruthy();
    await expect(page.locator('body')).toBeVisible();
  });

  test('shows pre-alpha disclaimer when solanaIka=1', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      unlocked: '1',
      vaultExists: '1',
      tab: 'vault',
      solanaIka: '1',
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/ika Solana pre-alpha/i)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Solana devnet fee payer/i)).toBeVisible({ timeout: 15_000 });
  });
});
