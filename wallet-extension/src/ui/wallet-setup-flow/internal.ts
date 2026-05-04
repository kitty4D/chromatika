import type { CSSProperties } from 'react';
import TrezorConnect from '@trezor/connect-web';
import type { trpc } from '@/lib/trpc';

export type WalletSetupSurface = 'onboarding' | 'sidepanel';

/** `bootstrap` = first vault (no blob yet). `addVault` = another vault; same screens, calls `addVault` + existing password. */
export type WalletSetupMode = 'bootstrap' | 'addVault';

/**
 * `passkey` / `waap` / `lazor` / `seeker` are the four primary "create with X" ctas that flank
 * the legacy mnemonic-create / mnemonic-import / private-key-import options (now hidden under
 * the "advanced ▾" disclosure on the choose step).
 *
 * - `passkey` (sui base): webauthn / sip-9 + ika dwallet, prf-derived seed.
 * - `waap` (sui base): `@human.tech/waap-sdk` + ika dwallet, deterministic-signature-or-recovery-words seed.
 * - `lazor` (solana base): `@lazorkit/wallet` + ika dwallet via deterministic session key.
 * - `seeker` (solana base): existing mwa-hardware path, just promoted to a top-level cta so users
 *   don't have to drill through "use hardware wallet → mwa → seeker."
 */
export type WalletSetupStep =
  | 'choose'
  | 'password'
  | 'backup'
  | 'import'
  | 'importKey'
  | 'hardware'
  | 'passkey'
  | 'waap'
  | 'lazor'
  | 'seeker';

export type WalletSetupIntent =
  | 'create'
  | 'import'
  | 'importPrivateKey'
  | 'hardware'
  | 'passkey'
  | 'waap'
  | 'lazor'
  | 'seeker';

export type VaultListRow = Awaited<ReturnType<typeof trpc.listVaults.query>>[number];
export type HardwareRow = Awaited<ReturnType<typeof trpc.getHardwareAccounts.query>>[number];

let trezorSetupInitialized = false;
export async function ensureTrezorSetupInit() {
  if (trezorSetupInitialized) return;
  await TrezorConnect.init({
    manifest: { appName: 'Chromatika', email: 'support@chromatika.xyz', appUrl: 'https://chromatika.xyz' },
    lazyLoad: false,
  });
  trezorSetupInitialized = true;
}

export function cardStyle(surface: WalletSetupSurface): CSSProperties {
  const borderBox = { boxSizing: 'border-box' as const };
  if (surface === 'onboarding') {
    return {
      ...borderBox,
      fontFamily: 'var(--ob-font-body, ui-sans-serif, system-ui, sans-serif)',
      padding: 24,
      maxWidth: 440,
      width: '100%',
      color: 'var(--theme-page-text, rgba(234, 240, 255, 0.95))',
      borderRadius: 'var(--theme-radius-surface)',
      background: 'var(--theme-setup-card-bg-onboard)',
      border: '1px solid var(--theme-chain-border)',
      boxShadow: '0 24px 80px rgba(0,0,0,0.55)',
      backdropFilter: 'blur(16px)',
    };
  }
  return {
    ...borderBox,
    fontFamily: 'var(--theme-font-body)',
    padding: 20,
    maxWidth: 'min(480px, 100%)',
    width: '100%',
    margin: '0 auto',
    color: 'var(--theme-page-text)',
    borderRadius: 'var(--theme-radius-surface)',
    background: 'var(--theme-setup-card-bg-side)',
    border: '1px solid var(--theme-chain-border)',
    boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
    backdropFilter: 'blur(12px)',
  };
}
