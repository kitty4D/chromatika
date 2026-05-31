import { test, expect } from './fixtures';

/**
 * F2 beginner-mode collapse, surface by surface. Uses the side-panel dev harness
 * (`?dev=1&unlocked=1&vaultExists=1&userMode=<tier>`) so the shell renders with
 * synthetic DEV_* data in each UX tier. Captures a screenshot per mode (for visual
 * review) and asserts the per-surface beginner invariants. Doubles as the roadmap's
 * required 3-mode snapshot coverage for F2.
 */

const MODES = ['beginner', 'advanced', 'pro'] as const;

function sidePanelUrl(extensionId: string, mode: string): string {
  const q = new URLSearchParams({
    dev: '1',
    unlocked: '1',
    vaultExists: '1',
    tab: 'vault',
    userMode: mode,
    // render synthetic dWallets so the populated account cards + switcher labels show.
    walletRecordingStub: '1',
  });
  return `chrome-extension://${extensionId}/side_panel.html?${q.toString()}`;
}

for (const mode of MODES) {
  test(`side panel renders + collapses correctly in ${mode} mode`, async ({ page, extensionId }) => {
    await page.goto(sidePanelUrl(extensionId, mode), { waitUntil: 'domcontentloaded' });

    // the account header is present in every tier (beginner just hides pieces of it).
    await expect(page.locator('.cv-contextHeader')).toBeVisible({ timeout: 20_000 });

    await page.screenshot({ path: `test-results/f2-usermode-${mode}.png`, fullPage: true });

    // Surface 1 (VaultContextHeader): beginner hides the raw fee-payer address row;
    // advanced + pro keep it.
    const feeRow = page.locator('.cv-contextFeeExplorer');
    await expect(feeRow).toHaveCount(mode === 'beginner' ? 0 : 1);

    // Surface 2 (VaultBaseCard): beginner hides the in-card mainnet/testnet totals panel
    // (the single balance lives in the header pill instead).
    const timeCircuits = page.locator('.cv-timeCircuits');
    await expect(timeCircuits).toHaveCount(mode === 'beginner' ? 0 : 1);

    // Surface (header pill): beginner drops the "MAIN" kicker so it doesn't duplicate the
    // network selector; the pill still shows the amount.
    await expect(page.locator('.cv-headerTotalPill-kicker')).toHaveCount(mode === 'beginner' ? 0 : 1);

    // Surface (network switching): beginner hides the per-account testnet/devnet switcher.
    if (mode === 'beginner') {
      await expect(page.getByText(/^signing:/i)).toHaveCount(0);
    }

    // Surface (nav): beginner hides the Policy Vault entry.
    await expect(page.locator('[data-nav="policy"]')).toHaveCount(mode === 'beginner' ? 0 : 1);

    // Surface (ika-lab drawer): hidden in beginner (IKA staking / Chroma Lab / x402 / agents).
    await expect(page.locator('.sp-bottomNavRevealToggle')).toHaveCount(mode === 'beginner' ? 0 : 1);
  });
}

for (const mode of MODES) {
  test(`settings hides advanced pages in ${mode} mode`, async ({ page, extensionId }) => {
    const q = new URLSearchParams({
      dev: '1',
      unlocked: '1',
      vaultExists: '1',
      tab: 'settings',
      userMode: mode,
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.sp-menuList')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: `test-results/f2-settings-${mode}.png`, fullPage: true });

    // beginner hides the advanced settings pages; advanced + pro keep them.
    const advancedRows = ['dWallet vaults', 'dWallet network', 'vault network', 'explorers & prices', 'payments (x402)', 'confidential compute'];
    for (const rowTitle of advancedRows) {
      await expect(page.getByText(rowTitle, { exact: true })).toHaveCount(mode === 'beginner' ? 0 : 1);
    }
    // the experience-mode switcher stays reachable in every tier (so beginners can leave beginner).
    await expect(page.getByText('experience mode', { exact: true })).toHaveCount(1);
  });
}

test('onboarding opens on the experience-tier picker', async ({ page, extensionId }) => {
  const q = new URLSearchParams({
    dev: '1',
    vaultExists: '0',
    unlocked: '0',
    setupStep: 'tier',
    setupIntent: 'create',
  });
  await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('.ws-tierChoice')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'test-results/f2-tier-choice.png', fullPage: true });
  await expect(page.locator('.ws-tierChoice-card')).toHaveCount(3);
  await expect(page.getByText('Just getting started')).toBeVisible();
});

test('picking Beginner drops the dWallet-Vault glossary on the choose step', async ({ page, extensionId }) => {
  const q = new URLSearchParams({
    dev: '1',
    vaultExists: '0',
    unlocked: '0',
    setupStep: 'tier',
    setupIntent: 'create',
  });
  await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('.ws-tierChoice')).toBeVisible({ timeout: 20_000 });
  // pick Beginner (first card) -> persists userMode=beginner + advances to the create/import chooser.
  await page.locator('.ws-tierChoice-card').first().click();
  await expect(page.locator('.ws-choose-btn').first()).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: 'test-results/f2-choose-beginner.png', fullPage: true });
  // beginner lead is jargon-free: no "dWallet Vault" glossary.
  await expect(page.locator('.ws-choose-lead')).not.toContainText('dWallet Vault');
});
