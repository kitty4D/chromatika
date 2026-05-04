import { test, expect } from './fixtures';

/**
 * Seeker (remote MWA) onboarding wiring spec.
 *
 * real Seed Vault + reflector pairing can't run in headless Chromium - that
 * needs a phone running an MWA wallet on the same network. what we CAN cover
 * end-to-end without re-implementing the MWA wire protocol:
 *
 *   1. UA gate: on desktop Chromium (Playwright default UA has no `Android`
 *      token), the hardware step shows "Seeker (QR pair)" as enabled and
 *      "Solana Mobile (this phone)" as disabled.
 *   2. click "Seeker (QR pair)" - the SeekerConnect component renders inline
 *      with the start-pairing CTA, the reflector host disclosure, and the
 *      pre-alpha devnet notice.
 *
 * the full pair -> vault -> sign loop is hands-on territory (manual runbook in
 * docs/SEEKER_REMOTE_PAIRING.md). unit tests in src/background/hardware/mwa-remote.test.ts
 * cover the helper module; src/background/wallet-service.test.ts covers the
 * auto-seed addHardwareVault path.
 */
test.describe('hardware step: Seeker (remote MWA) entry on desktop', () => {
  test('renders the Seeker (QR pair) entry and gates Solana Mobile (this phone) off', async ({
    page,
    extensionId,
    backgroundWorker,
  }) => {
    test.setTimeout(60_000);

    // hardware step's "mwa" / "mwa-remote" rows are gated on `effectiveIkaBase === 'solana'`.
    // pre-seed the persisted ika base mode in chrome.storage.local so the side panel reads
    // 'solana' on first render.
    await backgroundWorker.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        chrome.storage.local.set(
          { chromatika_ika_base_mode_v1: 'solana' },
          () => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve();
          },
        );
      });
    });

    // drop directly into the hardware step via the dev harness. `vaultExists=0` keeps
    // App.tsx on the bootstrap path so it renders WalletSetupFlow; `setupMode=addVault`
    // is what causes the hardware step to actually fire its tRPC fetch (errors are
    // surfaced inline but the device-option buttons render either way).
    const q = new URLSearchParams({
      dev: '1',
      vaultExists: '0',
      unlocked: '0',
      setupMode: 'addVault',
      setupStep: 'hardware',
    });
    await page.goto(`chrome-extension://${extensionId}/side_panel.html?${q.toString()}`, {
      waitUntil: 'domcontentloaded',
    });

    const ledger = page.getByRole('button', { name: /^Ledger$/ });
    const trezor = page.getByRole('button', { name: /^Trezor$/ });
    const mwaLocal = page.getByRole('button', { name: /Solana Mobile \(this phone\)/i });
    const mwaRemote = page.getByRole('button', { name: /Seeker \(QR pair\)/i });

    await expect(ledger).toBeVisible({ timeout: 30_000 });
    await expect(trezor).toBeVisible();
    await expect(mwaLocal).toBeVisible();
    await expect(mwaRemote).toBeVisible();

    // default Playwright Chromium UA contains no `Android` token, so the local-MWA
    // (Android intent) entry must be disabled and the Seeker (remote) entry enabled.
    await expect(mwaLocal).toBeDisabled();
    await expect(mwaRemote).toBeEnabled();

    // click into Seeker (QR pair) - the inline SeekerConnect component should render.
    await mwaRemote.click();

    await expect(page.getByRole('button', { name: /^start pairing$/i })).toBeVisible({
      timeout: 10_000,
    });
    // reflector host is disclosed in the bottom note so the user knows where the wss
    // session terminates - if this string moves we want the test to fail loud.
    await expect(page.getByText(/reflect\.solanamobile\.com/i)).toBeVisible();
    // pre-alpha disclaimer per CLAUDE.md "ika solana pre-alpha - disclaimer (canonical)"
    await expect(page.getByText(/pre-alpha ika Solana flows are devnet only/i)).toBeVisible();
  });
});
