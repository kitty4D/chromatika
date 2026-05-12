/**
 * scripted walk-through for turning on Policy Vault using dev urls (frozen panel +
 * simulated wrap). add `walletRecordingStub=1` so the chrome shows a seeded dWallet.
 *
 * ```
 * cd wallet-extension
 * pnpm run demo:policy-record
 * ```
 *
 * This spec always enables Playwright video + light slowMo via `e2e/fixtures.ts` (no env var).
 * Videos land under wallet-extension/test-results/policy-demo-recordings/ after the run finishes
 * (often two `page@*.webm` files when Chromium has multiple pages open; pick the larger one).
 */

import { test, expect } from './fixtures';

const REC = !!process.env.PLAYWRIGHT_DEMO;

function dwellScene() {
  return REC ? 2400 : 400;
}

function dwellAction() {
  return REC ? 500 : 300;
}

function sidePanel(extensionId: string, q: Record<string, string | number>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    p.set(k, String(v));
  }
  return `chrome-extension://${extensionId}/side_panel.html?${p.toString()}`;
}

test.describe('policy vault demo (dev harness recordings)', () => {
  test.describe.configure({
    timeout: REC ? 240_000 : 90_000,
  });

  test('turning policy on walkthrough clip', async ({ page, extensionId }) => {
    const base = {
      dev: '1',
      vaultExists: '1',
      unlocked: '1',
      walletRecordingStub: '1',
    } as const;

    // post-create modal on wallet home
    await page.goto(
      sidePanel(extensionId, {
        ...base,
        tab: 'vault',
        policyPromptDemo: 'SECP256K1',
        simulatePolicyWrap: '1',
      }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('.cv-dwalletBar-label').first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(dwellScene());
    await expect(page.getByText(/wrap this dWallet with Policy Vault/i)).toBeVisible();
    await page.waitForTimeout(dwellScene());

    await page.getByRole('button', { name: /wrap with these defaults/i }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(dwellAction());
    await page.getByRole('button', { name: /wrap with these defaults/i }).click();
    await expect(page.getByRole('button', { name: /wrapped/i })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(dwellScene());

    // frozen policy panel: browse opt-in defaults
    await page.goto(
      sidePanel(extensionId, {
        ...base,
        tab: 'policy',
        policyPanelDemo: '1',
      }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.getByRole('heading', { name: /^policy vault$/i })).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(dwellScene());

    await page.getByRole('button', { name: /opt in: wrap dWallet cap/i }).click();
    await expect(page.getByText(/configure policy/i)).toBeVisible();
    await page.waitForTimeout(dwellScene());

    const capInput = page.locator('.sp-settingsSection').getByRole('textbox').first();
    await capInput.fill('850');
    await page.waitForTimeout(dwellAction());
    await capInput.press('Tab');
    await page.waitForTimeout(dwellScene());

    await page.getByRole('button', { name: /^opt in \(sign Sui tx\)$/i }).focus();
    await page.waitForTimeout(REC ? 1000 : 500);
    await page.locator('.sp-settingsSection').getByRole('button', { name: /^cancel$/i }).click();
    await page.waitForTimeout(dwellAction());

    await page.goto(sidePanel(extensionId, { ...base, tab: 'policy' }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(dwellScene());
    await expect(page.getByRole('heading', { name: /^policy vault$/i })).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(REC ? 2200 : 400);
  });
});
