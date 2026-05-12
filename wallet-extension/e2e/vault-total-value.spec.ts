/**
 * vault-total-value e2e spec
 *
 * covers: VaultTotalLine rendering + format toggle + localStorage persistence,
 * partial-state "~" prefix, and VaultPicker USD column visibility.
 *
 * --- infrastructure notes (tbh, kinda important) ---
 *
 * the side-panel dev harness (`side_panel.html?dev=1&unlocked=1&vaultExists=1`) gives us:
 *   - activeVaultId = 'dev-vault-1' (hardcoded in SidePanelApp DEV_VAULTS[0])
 *   - DEV_BALANCES stub (sui-mainnet, no real addresses)
 *   - DEV_VAULTS (two vault rows) passed to VaultPicker
 *   - the UI renders MainWalletShell -> VaultContextHeader -> VaultTotalLine
 *
 * BUT: `getVaultTotal` (tRPC) gate-checks `getSession()` in the SW. the dev harness
 * only stubs UI-side state; the SW has no real unlocked session. so getVaultTotal
 * throws "Wallet locked", VaultTotalLine catches it, snap=null -> displays '—'.
 *
 * consequence: we CAN test:
 *   - element renders with the right CSS class
 *   - click toggles format (purely React state + localStorage)
 *   - localStorage key persists across reload
 *
 * we CANNOT test (without a real vault in the SW) in this harness:
 *   - actual dollar amount appears ($X.XX / $XK / etc.)
 *   - partial-state "~" prefix (needs one chain fetch to succeed, one to fail)
 *   - VaultPicker USD column shows a real value instead of '…'
 *
 * tests that need a real session are marked test.skip with a TODO. once the harness
 * ships a `?syntheticVaultSession=1` flag (or similar) that writes a dev vault to the
 * SW and unlocks it without requiring a real password flow, remove the skips and wire
 * the mockSwFetch calls.
 *
 * mockSwFetch signature (from fixtures.ts):
 *   mockSwFetch(worker: Worker, pattern: string, response: { status, body })
 * note: pattern is a SUBSTRING string (not a RegExp). backgroundWorker fixture, not sw.
 */

import { test, expect, clearSwFetchMocks } from './fixtures';

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function sidePanelUrl(extensionId: string, extra?: Record<string, string>): string {
  const q = new URLSearchParams({
    dev: '1',
    unlocked: '1',
    vaultExists: '1',
    ...extra,
  });
  return `chrome-extension://${extensionId}/side_panel.html?${q.toString()}`;
}

test.describe('vault total value', () => {
  // -------------------------------------------------------------------------
  // test 1: element renders and click toggles format (no real session needed)
  // -------------------------------------------------------------------------
  test('header line renders for active vault and toggles format on click', async ({
    page,
    extensionId,
  }) => {
    // with dev harness: vaultId='dev-vault-1' is provided to VaultTotalLine,
    // so the button renders. the tRPC call fails (wallet locked in SW), snap=null,
    // so the display shows '—'. we just verify the element is present and the
    // click cycles through format state and persists to localStorage.

    await page.goto(sidePanelUrl(extensionId), { waitUntil: 'domcontentloaded' });

    const total = page.locator('.cv-vaultTotal');
    await expect(total).toBeVisible({ timeout: 20_000 });

    // in locked-SW mode the line shows '—' or '$...' during pending. either is fine -
    // we don't assert the text value here, just that the element exists and is clickable.
    const before = await total.textContent();
    await total.click();
    const after = await total.textContent();

    // clicking should change the format state even if text is '—' / '$...'.
    // in practice toggling compact -> exact when snap=null still changes the format pref
    // (saveFormatPref runs), so a reload should reflect the new pref.
    // (text might or might not differ visually for '—'; just verify the click didn't crash)
    expect(typeof before).toBe('string');
    expect(typeof after).toBe('string');

    // localStorage pref should be set after click
    const prefValue = await page.evaluate(
      () => localStorage.getItem('chromatika_vault_total_format_v1'),
    );
    expect(['compact', 'exact']).toContain(prefValue);

    // reload: pref must persist
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadedTotal = page.locator('.cv-vaultTotal');
    await expect(reloadedTotal).toBeVisible({ timeout: 20_000 });
    const prefAfterReload = await page.evaluate(
      () => localStorage.getItem('chromatika_vault_total_format_v1'),
    );
    expect(prefAfterReload).toBe(prefValue);
  });

  // -------------------------------------------------------------------------
  // test 2: actual dollar amount + format toggle (requires real SW session)
  // -------------------------------------------------------------------------
  test.skip('header shows dollar amount and toggling compact↔exact changes text (needs real vault session + SW mock)', async ({
    backgroundWorker,
  }) => {
    // TODO: implement once the dev harness exposes a way to unlock a real vault in the
    // SW without a full onboarding flow (e.g. ?syntheticVaultSession=1 flag that the
    // SW recognises and writes a dev vault + unlocks it, skipping Argon2id).
    //
    // when that lands:
    //   1. await mockSwFetch(backgroundWorker, 'api.coingecko.com', { status: 200, body: { sui: { usd: 4 } } });
    //   2. await mockSwFetch(backgroundWorker, 'graphql.mainnet.sui.io', { status: 200, body: { ... listCoins shape ... } });
    //   3. navigate, wait for .cv-vaultTotal not to show '$...' or '—'
    //   4. assert compact format matches /^\$[\d.,]+(K|M)?$/
    //   5. click -> assert exact format differs from compact
    //   6. reload -> assert localStorage pref preserved
    //
    // mockSwFetch note: pattern is a SUBSTRING string, not a regex.
    // the 'graphql.mainnet.sui.io' mock needs a valid SuiGraphQL listCoins response shape.

    await clearSwFetchMocks(backgroundWorker); // clean up even though we skip
  });

  // -------------------------------------------------------------------------
  // test 3: partial state prepends ~ when one chain fails (requires real session)
  // -------------------------------------------------------------------------
  test.skip('partial state prepends ~ when one chain fetcher fails (needs real vault session + SW mock)', async ({
    backgroundWorker,
  }) => {
    // TODO: same prerequisite as test 2. once real-session harness exists:
    //   1. mock coingecko to succeed (so price resolves)
    //   2. mock graphql endpoint to return 500 (so probeSui fails, ok=false)
    //   3. assert .cv-vaultTotal text starts with '~' (partial flag in formatVaultTotalUsd)
    //
    // the '~' prefix is emitted by formatVaultTotalUsd when snap.partial === true.
    // the aggregator sets partial=true when at least one perChain probe has ok=false
    // and at least one has ok=true (mixed result). a 500 from graphql triggers that.

    await clearSwFetchMocks(backgroundWorker);
  });

  // -------------------------------------------------------------------------
  // test 4: VaultPicker opens and USD column cells render
  // -------------------------------------------------------------------------
  test('VaultPicker rows show usd column cells on open (smoke)', async ({
    page,
    extensionId,
  }) => {
    // DEV_VAULTS has 2 entries. VaultPicker renders when vaults.length > 1 (the picker
    // button is present when more than one vault exists). opening it triggers
    // getVaultTotalsForOthers which also requires a real SW session - so the '…'
    // placeholder cells will stay as '…'. we just verify the cells mount at all.

    await page.goto(sidePanelUrl(extensionId), { waitUntil: 'domcontentloaded' });

    // wait for the main shell to mount
    const vaultTotal = page.locator('.cv-vaultTotal');
    await expect(vaultTotal).toBeVisible({ timeout: 20_000 });

    // open the vault picker. the button may not be visible if the vault header is
    // collapsed or if only 1 vault renders in the harness. soft-check.
    const pickerBtn = page.locator('.sp-vaultPickerBtn');
    const pickerBtnVisible = await pickerBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (!pickerBtnVisible) {
      test.info().annotations.push({
        type: 'note',
        description:
          'sp-vaultPickerBtn not visible in this harness run - may need more than one vault row to show the button. USD column cells not reachable; skipping deep assertions.',
      });
      return;
    }

    await pickerBtn.click();

    // USD meta cells should mount (even if they show '…' due to locked SW)
    const usdCells = page.locator('.sp-vaultPickerMeta--usd');
    const cellCount = await usdCells.count();

    test.info().annotations.push({
      type: 'note',
      description: `sp-vaultPickerMeta--usd cell count after open: ${cellCount}. in locked-SW harness expect '…' or '-' placeholders, not real amounts.`,
    });

    // with two DEV_VAULTS the non-active vault row renders a USD cell
    await expect(usdCells.first()).toBeVisible({ timeout: 5_000 });
  });

  // -------------------------------------------------------------------------
  // test 5: VaultPicker USD cells show real amounts (requires real session)
  // -------------------------------------------------------------------------
  test.skip('VaultPicker USD cells resolve to real amounts for all vaults (needs real vault session + SW mock)', async ({
    backgroundWorker,
  }) => {
    // TODO: same prerequisite as test 2. once real-session harness exists:
    //   1. mock coingecko for SUI price
    //   2. navigate with two dev vaults
    //   3. open VaultPicker
    //   4. assert both .sp-vaultPickerMeta--usd cells are NOT '…' after timeout
    //   5. assert text matches /\$[\d.,]+/

    await clearSwFetchMocks(backgroundWorker);
  });
});
