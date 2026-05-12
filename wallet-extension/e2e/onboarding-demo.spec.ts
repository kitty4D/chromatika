/**
 * scripted walk-through of the full onboarding flow using dev urls. zero real vault
 * creation, zero solana txns, zero tRPC - pure UI screenshots via the dev harness.
 *
 * ```
 * cd wallet-extension
 * pnpm run demo:onboarding
 * ```
 *
 * screenshots land under test-results/onboarding-demo-screenshots/.
 * with PLAYWRIGHT_DEMO=1, also records video to test-results/policy-demo-recordings/.
 */

import { test, expect } from './fixtures';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REC = !!process.env.PLAYWRIGHT_DEMO;
const SCREENSHOTS_DIR = path.resolve(__dirname, '..', 'test-results', 'onboarding-demo-screenshots');

function dwell() {
  return REC ? 2400 : 300;
}

function sidePanel(extensionId: string, q: Record<string, string | number>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) p.set(k, String(v));
  return `chrome-extension://${extensionId}/side_panel.html?${p.toString()}`;
}

test.describe('onboarding demo (dev harness)', () => {
  test.describe.configure({ timeout: REC ? 240_000 : 120_000 });

  test.beforeAll(() => {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  });

  test('capture every onboarding screen', async ({ page, extensionId }) => {
    const setup = { dev: '1', vaultExists: '0' } as const;
    const locked = { dev: '1', vaultExists: '1', unlocked: '0' } as const;
    const home = { dev: '1', vaultExists: '1', unlocked: '1', walletRecordingStub: '1' } as const;
    const screenshots: { file: string; label: string }[] = [];

    async function snap(name: string, label: string) {
      const file = `${name}.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, file) });
      screenshots.push({ file, label });
      await page.waitForTimeout(dwell());
    }

    // 1 - choose step (sui base, default)
    await page.goto(sidePanel(extensionId, { ...setup, setupStep: 'choose' }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.locator('.ws-choose-brand')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(300);
    await snap('01-choose-sui', 'Choose Entry Point (Sui Base)');

    // 2 - choose step with advanced panel open
    await page.getByRole('button', { name: /advanced/i }).click();
    await expect(page.locator('#ws-choose-advanced-panel')).toBeVisible();
    await page.waitForTimeout(200);
    await snap('02-choose-advanced', 'Advanced Options (Seed / Import / Key)');

    // 3 - choose step (solana base via addVault mode)
    await page.goto(
      sidePanel(extensionId, { ...setup, setupStep: 'choose', setupMode: 'addVault', solanaIka: '1' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.locator('.ws-choose-brand')).toBeVisible({ timeout: 15_000 });
    const solToggle = page.getByRole('button', { name: /show solana/i });
    if (await solToggle.isVisible({ timeout: 3000 }).catch(() => false)) {
      await solToggle.click();
      await page.waitForTimeout(400);
    }
    await snap('03-choose-solana', 'Choose Entry Point (Solana Base)');

    // 4 - password step (create intent)
    await page.goto(
      sidePanel(extensionId, { ...setup, setupStep: 'password', setupIntent: 'create' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.locator('.ws-password-brand')).toBeVisible({ timeout: 15_000 });
    const pwInputs = page.locator('input[type="password"]');
    const count = await pwInputs.count();
    if (count >= 2) {
      await pwInputs.nth(0).fill('demo12345');
      await pwInputs.nth(1).fill('demo12345');
    }
    await page.waitForTimeout(200);
    await snap('04-password', 'Set Password');

    // 5 - backup step (mnemonic display)
    await page.goto(
      sidePanel(extensionId, { ...setup, setupStep: 'backup' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.locator('.ws-backup-brand')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(200);
    await snap('05-backup', 'Recovery Phrase Backup');

    // 6 - backup step (confirmed)
    const checkbox = page.locator('.ws-backup-confirm input[type="checkbox"]');
    if (await checkbox.isVisible()) {
      await checkbox.check();
      await page.waitForTimeout(200);
    }
    await snap('06-backup-confirmed', 'Backup Confirmed');

    // 7 - import step (recovery phrase paste)
    await page.goto(
      sidePanel(extensionId, { ...setup, setupStep: 'import' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.locator('.ws-import-brand')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(200);
    await snap('07-import-phrase', 'Import Recovery Phrase');

    // 8 - import private key step
    await page.goto(
      sidePanel(extensionId, { ...setup, setupStep: 'importKey' }),
      { waitUntil: 'domcontentloaded', timeout: 60_000 },
    );
    await expect(page.locator('.ws-import-brand')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(200);
    await snap('08-import-key', 'Import Private Key');

    // 9 - unlock screen (returning user)
    await page.goto(sidePanel(extensionId, locked), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.locator('.sp-unlockScreen')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(200);
    await snap('09-unlock', 'Unlock Screen');

    // 10 - wallet home (vault tab with stub dWallet)
    await page.goto(sidePanel(extensionId, { ...home, tab: 'vault' }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await expect(page.locator('.cv-dwalletBar-label').first()).toBeVisible({ timeout: 25_000 });
    await page.waitForTimeout(500);
    await snap('10-wallet-home', 'Wallet Home');

    // 11 - dwallet management tab
    await page.goto(sidePanel(extensionId, { ...home, tab: 'dwallet' }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(500);
    await snap('11-dwallet-tab', 'dWallet Management');

    // 12 - settings
    await page.goto(sidePanel(extensionId, { ...home, tab: 'settings' }), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForTimeout(500);
    await snap('12-settings', 'Settings');

    // generate an HTML viewer with all screenshots
    const html = buildGalleryHtml(screenshots);
    writeFileSync(path.join(SCREENSHOTS_DIR, 'index.html'), html, 'utf-8');
  });
});

function buildGalleryHtml(screenshots: { file: string; label: string }[]): string {
  const cards = screenshots
    .map(
      (s, i) => `
    <div class="card">
      <div class="step-num">${i + 1}</div>
      <img src="${s.file}" alt="${s.label}" loading="lazy" />
      <div class="label">${s.label}</div>
    </div>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Chromatika Onboarding Demo</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    padding: 40px 20px;
  }
  h1 {
    text-align: center;
    font-size: 28px;
    font-weight: 600;
    margin-bottom: 8px;
    background: linear-gradient(135deg, #8b5cf6, #ec4899);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .subtitle {
    text-align: center;
    font-size: 14px;
    color: #888;
    margin-bottom: 40px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 28px;
    max-width: 1400px;
    margin: 0 auto;
  }
  .card {
    position: relative;
    background: #16161f;
    border: 1px solid rgba(139, 92, 246, 0.15);
    border-radius: 14px;
    overflow: hidden;
    transition: transform 0.2s, border-color 0.2s;
  }
  .card:hover {
    transform: translateY(-4px);
    border-color: rgba(139, 92, 246, 0.4);
  }
  .card img {
    width: 100%;
    height: auto;
    display: block;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .step-num {
    position: absolute;
    top: 10px;
    left: 10px;
    background: rgba(139, 92, 246, 0.85);
    color: #fff;
    font-size: 13px;
    font-weight: 700;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
  }
  .label {
    padding: 14px 16px;
    font-size: 14px;
    font-weight: 500;
    color: #ccc;
  }
  @media (max-width: 720px) {
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<h1>Chromatika Onboarding</h1>
<p class="subtitle">Simulated walkthrough - ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
<div class="grid">
${cards}
</div>
</body>
</html>`;
}
