import { test, expect } from './fixtures';

test.describe('side panel routes (dev harness)', () => {
  test('ika staking tab shows staking chrome', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      unlocked: '1',
      vaultExists: '1',
      tab: 'ikaStake',
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByRole('heading', { name: /IKA staking/i })).toBeVisible({ timeout: 20_000 });
  });

  test('settings dapps section is reachable', async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      unlocked: '1',
      vaultExists: '1',
      tab: 'settings',
      settingsTab: 'dapps',
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.getByText(/^connected dapps$/i)).toBeVisible({ timeout: 20_000 });
  });
});
