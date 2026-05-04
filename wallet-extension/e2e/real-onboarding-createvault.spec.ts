import { test, expect } from './fixtures';

/**
 * real cold-SW onboarding: no dev harness params, no mocked state.
 *
 * exercises the full createVault + unlockVault tRPC round trip through a cold
 * MV3 service worker - the class of flake fixtures.ts explicitly calls out.
 *
 * local crypto only (BIP39 + AES-GCM + HD derive). no ika DKG, no RPC, no
 * network - DKG happens later when the user creates a dWallet inside the vault.
 */
test.describe('onboarding (real flow, cold SW)', () => {
  test('create new dWallet Vault -> unlocked wallet ready', async ({ page, extensionId }) => {
    test.setTimeout(120_000);

    await page.goto(`chrome-extension://${extensionId}/onboarding.html`, {
      waitUntil: 'load',
    });

    // ChooseStep primary CTAs are now passkey / waap / lazor / seeker (each pulls in heavy
    // SDKs we don't want this regression spec to exercise). the mnemonic-only create path
    // lives under the "advanced ▾" expander as "create new mnemonic vault (<chain> base)"
    // - that's what this spec drives so the createVault + unlockVault tRPC round-trip is
    // exercised without dragging in passkey / waap / lazor / seeker init code.
    const advancedToggle = page.getByRole('button', { name: /^advanced/i });
    await expect(advancedToggle).toBeVisible({ timeout: 45_000 });
    await advancedToggle.click();

    const createBtn = page.getByRole('button', { name: /create new mnemonic vault/i });
    await expect(createBtn).toBeVisible({ timeout: 5_000 });
    await createBtn.click();

    // password step (bootstrap mode shows confirm field)
    const password = 'e2e-correct-horse-battery';
    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs.nth(0)).toBeVisible({ timeout: 15_000 });
    await pwInputs.nth(0).fill(password);
    await pwInputs.nth(1).fill(password);
    await page.getByRole('button', { name: /proceed to create vault/i }).click();

    // backup step: mnemonic generated via tRPC.generateSetupMnemonic
    const savedCheckbox = page.getByRole('checkbox', { name: /i saved it somewhere safe/i });
    await expect(savedCheckbox).toBeVisible({ timeout: 30_000 });
    await savedCheckbox.check();

    const mnemonicField = page.locator('.ws-backup-mnemonic');
    const mnemonic = await mnemonicField.inputValue();
    expect(mnemonic.trim().split(/\s+/).length).toBeGreaterThanOrEqual(12);

    // "open wallet" kicks off createVault + unlockVault through cold SW.
    // the wasm-bindgen multi-MB data URL bug that used to break this path is
    // worked around in `service-worker-document-shim.ts` (URL + fetch
    // interception); see that file's comment for the full rationale.
    await page.getByRole('button', { name: /^open wallet$/i }).click();

    // celebration auto-advances (3.2s animated, 500ms reduced motion); assert
    // the post-celebration "wallet ready" state so we know unlockVault settled.
    await expect(page.getByRole('heading', { name: /wallet ready/i })).toBeVisible({
      timeout: 60_000,
    });
  });
});
