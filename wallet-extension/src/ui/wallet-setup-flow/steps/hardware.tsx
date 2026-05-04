import type { CSSProperties } from 'react';
import type { WalletSetupSurface } from '../internal';
import type { WalletSetupHook } from '../use-wallet-setup';
import { SeekerConnect } from '@/ui/hardware/SeekerConnect';
import { WalletConnectConnect } from '@/ui/hardware/WalletConnectConnect';
import { isWcEnabled } from '@/config/wc';

export function HardwareStep({
  surface,
  box,
  onDismiss,
  hook,
}: {
  surface: WalletSetupSurface;
  box: CSSProperties;
  onDismiss?: () => void;
  hook: WalletSetupHook;
}) {
  const {
    mode,
    setStep,
    setError,
    error,
    effectiveIkaBase,
    hardwareVaultOptions,
    hardwareAccounts,
    hardwareIkaSourceId,
    setHardwareIkaSourceId,
    hardwareAccountSelect,
    setHardwareAccountSelect,
    hardwarePairBusy,
    hardwareSubmitBusy,
    hardwareDeviceSelect,
    setHardwareDeviceSelect,
    pairLedgerSuiForHardwareVault,
    pairLedgerSolanaForHardwareVault,
    pairTrezorSolanaForHardwareVault,
    pairMwaForHardwareVault,
    onAddLedgerHardwareVault,
    onSeekerPaired,
    seekerPair,
    onWalletConnectPaired,
    walletConnectPair,
    isMwaSolanaAutoSeedEligible,
  } = hook;

  const hwCls = `ws-import ws-import--${surface}`;
  const inputCls = surface === 'sidepanel' ? 'sp-input' : undefined;

  const ikaSources = hardwareVaultOptions.filter((v) => v.ikaKeysReady);

  // mwa-remote (Seeker QR) and mwa (Android intent) both store accounts under vendor='mwa' -
  // the discriminator is on the vault record (mwaTransport), not on the account row.
  // walletconnect stores its own vendor ('walletconnect') since the relay session lives in a
  // different SDK and the vault record uses a different field block.
  const hardwareDeviceVendor: 'ledger' | 'trezor' | 'mwa' | 'walletconnect' =
    hardwareDeviceSelect === 'mwa-remote' ? 'mwa' : hardwareDeviceSelect;
  // which hardware accounts are eligible as fee payers for the current ika base + device
  const hwChoices = hardwareAccounts.filter(
    (a) => a.vendor === hardwareDeviceVendor && a.chain === (effectiveIkaBase === 'solana' ? 'solana' : 'sui'),
  );

  // trezor is Solana-only (no Sui support in Trezor Connect).
  // Solana phone paths split into three sibling entries:
  //   - 'mwa'           : local Android intent (`solana-wallet://`) - only works when this
  //                       extension page is loaded on the same Android device as the wallet app.
  //   - 'mwa-remote'    : desktop to phone via Solana Mobile's wss reflector + QR scan (Seeker etc).
  //                       hidden by default (`VITE_ENABLE_MWA_REMOTE=true` to re-enable) because
  //                       Solana Mobile's reflector demo is currently unreliable for everyone.
  //   - 'walletconnect' : WalletConnect v2 relay + QR. works on all platforms (incl. Android,
  //                       where it covers WC-only Solana wallets like Jupiter Mobile that don't
  //                       ship MWA support). disabled until `VITE_WC_PROJECT_ID` is set.
  // **bootstrap (first-vault) mode**: phase 1 only supports phone-Solana auto-seed (MWA or WC),
  // so Ledger / Trezor are disabled there - those vendors need a separate auto-seed pattern that
  // has not shipped.
  const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
  const isBootstrap = mode === 'bootstrap';
  const wcEnabled = isWcEnabled();
  const mwaRemoteEnabled = (import.meta.env.VITE_ENABLE_MWA_REMOTE as string | undefined) === 'true';
  const deviceOptions: Array<{ id: 'ledger' | 'trezor' | 'mwa' | 'mwa-remote' | 'walletconnect'; label: string; available: boolean; unavailableReason?: string; hidden?: boolean }> = [
    {
      id: 'ledger',
      label: 'Ledger',
      available: !isBootstrap,
      unavailableReason: isBootstrap
        ? 'first-vault hardware needs an extension-generated ika keypair pattern that has not shipped for Ledger yet — create an HD vault first, then add Ledger from settings'
        : undefined,
    },
    {
      id: 'trezor',
      label: 'Trezor',
      available: !isBootstrap && effectiveIkaBase === 'solana',
      unavailableReason: isBootstrap
        ? 'first-vault hardware does not support Trezor yet — create an HD vault first, then add Trezor from settings'
        : 'requires Solana ika base (Trezor Connect has no Sui app)',
    },
    {
      id: 'mwa',
      label: 'Solana Mobile (this phone)',
      available: effectiveIkaBase === 'solana' && isAndroid,
      unavailableReason:
        effectiveIkaBase !== 'solana'
          ? 'requires Solana ika base'
          : 'this path uses an Android intent — open Chromatika on your Seeker / Android phone, or use WalletConnect on desktop',
    },
    {
      id: 'walletconnect',
      label: 'WalletConnect',
      available: effectiveIkaBase === 'solana' && wcEnabled,
      unavailableReason:
        effectiveIkaBase !== 'solana'
          ? 'requires Solana ika base'
          : 'set VITE_WC_PROJECT_ID at build time to enable WalletConnect — register a free project at cloud.reown.com',
    },
    {
      id: 'mwa-remote',
      label: 'Seeker (QR pair, legacy)',
      available: effectiveIkaBase === 'solana' && !isAndroid && mwaRemoteEnabled,
      // hidden entirely by default; the flag exists so we can re-enable it cheaply when Solana
      // Mobile fixes their reflector demo. until then the option does not appear in the picker.
      hidden: !mwaRemoteEnabled,
      unavailableReason:
        effectiveIkaBase !== 'solana'
          ? 'requires Solana ika base'
          : 'MWA QR pairing is currently disabled — Solana Mobile\'s reflector demo is unreliable. Use WalletConnect instead.',
    },
  ];
  const visibleDeviceOptions = deviceOptions.filter((d) => !d.hidden);

  // device-specific pair button label and action.
  // mwa-remote uses inline <SeekerConnect> below - no pair button needed there.
  let pairLabel = '';
  let pairHint = '';
  let pairAction: () => void = () => {};
  if (hardwareDeviceSelect === 'ledger') {
    const appLabel = effectiveIkaBase === 'solana' ? 'Solana' : 'Sui';
    pairLabel = hardwarePairBusy ? 'scanning ledger…' : `scan Ledger (${appLabel} app)`;
    pairHint = `plug in your Ledger and open the ${appLabel} app, then click scan.`;
    pairAction = () => void (effectiveIkaBase === 'solana' ? pairLedgerSolanaForHardwareVault() : pairLedgerSuiForHardwareVault());
  } else if (hardwareDeviceSelect === 'trezor') {
    pairLabel = hardwarePairBusy ? 'connecting trezor…' : 'scan Trezor (Solana accounts)';
    pairHint = 'connect your Trezor via USB or Trezor Bridge, then click scan — Trezor Connect iframe will open.';
    pairAction = () => void pairTrezorSolanaForHardwareVault();
  } else if (hardwareDeviceSelect === 'mwa') {
    pairLabel = hardwarePairBusy ? 'waiting for phone…' : 'connect phone wallet (MWA)';
    pairHint = 'open this page in Chrome on the same Android phone that runs Phantom Mobile or Solflare, then tap connect — the mobile wallet launches via Android intent. Solana-only.';
    pairAction = () => void pairMwaForHardwareVault();
  }
  // mwa-remote: pair UI is rendered inline via <SeekerConnect>.

  const feeAccountLabel =
    hardwareDeviceSelect === 'walletconnect' ? 'WalletConnect Solana account'
    : hardwareDeviceSelect === 'mwa' ? 'mobile wallet (MWA local) Solana account'
    : hardwareDeviceSelect === 'mwa-remote' ? 'Seeker (MWA remote) Solana account'
    : hardwareDeviceSelect === 'trezor' ? 'Trezor Solana fee account'
    : `Ledger ${effectiveIkaBase === 'solana' ? 'Solana' : 'Sui'} fee account`;

  return (
    <div style={box} className={hwCls}>
      <div className="ws-import-brand">
        <img className="ws-import-logo" src="/chromatika-clean-key.png" alt="" width={100} height={100} />
        <h2 className="ws-import-title">
          {isBootstrap ? 'first vault: Solana Seeker (MWA)' : `hardware vault (${effectiveIkaBase} fee)`}
        </h2>
        <p className="ws-import-sub">
          we do not ask for a pasted <strong>suiprivkey</strong> or <strong>solana secret key</strong>.
          ika fees sign on your hardware device.{' '}
          {isBootstrap ? (
            <>
              for first-vault setup, only <strong>Solana Mobile</strong> (Seeker / Phantom Android /
              Solflare Android) is supported today — your phone signs every chain transaction, and
              the ika encryption keys derive from the wallet's signature over a deterministic
              chromatika message so the dWallet survives a re-install on another device.
            </>
          ) : (
            <>
              <strong>UserShareEncryptionKeys</strong> are copied from another vault that already
              finished ika setup (same chromatika password), or — for Solana Mobile — derived from
              the wallet's signature over a deterministic chromatika message.
            </>
          )}
        </p>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {visibleDeviceOptions.map((d) => (
          <button
            key={d.id}
            type="button"
            className={hardwareDeviceSelect === d.id ? 'ws-password-btn ws-password-btn--primary' : 'ws-password-btn ws-password-btn--ghost'}
            style={{ flex: 1, fontSize: 12, padding: '7px 10px', opacity: d.available ? 1 : 0.4 }}
            disabled={!d.available}
            title={d.available ? undefined : `${d.label} ${d.unavailableReason ?? 'unavailable'}`}
            onClick={() => {
              setHardwareDeviceSelect(d.id);
              setHardwareAccountSelect('');
              setError(null);
            }}
          >
            {d.label}
          </button>
        ))}
      </div>

      {hardwareDeviceSelect === 'walletconnect' ? (
        <div style={{ marginBottom: 14 }}>
          <WalletConnectConnect
            onBack={() => setHardwareDeviceSelect('ledger')}
            onPaired={(p) => void onWalletConnectPaired(p)}
          />
          {walletConnectPair && (
            <p style={{ fontSize: 11, color: 'rgba(16,185,129,0.85)', marginTop: 8, lineHeight: 1.5 }}>
              paired: {walletConnectPair.address.slice(0, 8)}…{walletConnectPair.address.slice(-6)} —
              review the fee account below and click "add hardware vault" to finish.
            </p>
          )}
        </div>
      ) : hardwareDeviceSelect === 'mwa-remote' ? (
        <div style={{ marginBottom: 14 }}>
          <SeekerConnect
            onBack={() => setHardwareDeviceSelect('ledger')}
            onPaired={(p) => void onSeekerPaired(p)}
          />
          {seekerPair && (
            <p style={{ fontSize: 11, color: 'rgba(16,185,129,0.85)', marginTop: 8, lineHeight: 1.5 }}>
              paired: {seekerPair.address.slice(0, 8)}…{seekerPair.address.slice(-6)} — review the
              fee account below and click "add hardware vault" to finish.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="ws-import-lead" style={{ marginBottom: 12, fontSize: 12 }}>
            {pairHint}
          </p>
          <button
            type="button"
            className="ws-password-btn ws-password-btn--primary"
            style={{ width: '100%', marginBottom: 14 }}
            disabled={hardwarePairBusy}
            onClick={pairAction}
          >
            {pairLabel}
          </button>
        </>
      )}

      <label className="ws-import-phrase-label" htmlFor="ws-hw-device-acct">
        {feeAccountLabel}
      </label>
      <select
        id="ws-hw-device-acct"
        className={['ws-import-mnemonic', inputCls].filter(Boolean).join(' ')}
        style={{ width: '100%', marginBottom: 12, padding: '10px 12px' }}
        value={hardwareAccountSelect}
        onChange={(e) => setHardwareAccountSelect(e.target.value)}
      >
        <option value="">select…</option>
        {hwChoices.map((a) => (
          <option key={a.id} value={a.id}>
            {a.address.slice(0, 10)}…{a.address.slice(-6)} — {a.derivationPath}
          </option>
        ))}
      </select>

      {isMwaSolanaAutoSeedEligible() ? (
        <div
          className="ws-password-hint"
          style={{
            fontSize: 12,
            marginBottom: 12,
            padding: '10px 12px',
            background: 'rgba(245, 158, 11, 0.08)',
            border: '1px solid rgba(245, 158, 11, 0.18)',
            borderRadius: 10,
            lineHeight: 1.5,
          }}
        >
          <strong>seeker-derived ika seed:</strong> your phone's Seed Vault never exposes secret
          bytes, so during pairing the wallet signs a deterministic chromatika message —
          <code>keccak256(signature)</code> seeds your <code>UserShareEncryptionKeys</code>.
          Same Seeker on a different install re-derives the same keys, so the dWallet survives
          re-installs and clean-machine restores. A separate in-extension keypair pays the
          <code> approve_message</code> gRPC fee on devnet (regenerated per install — fund it
          with ~0.1 devnet SOL after the vault is created). The Seed Vault on your phone still
          signs every <em>chain</em> transaction.
        </div>
      ) : isBootstrap ? (
        <div
          className="ws-password-hint"
          style={{
            fontSize: 12,
            marginBottom: 12,
            padding: '10px 12px',
            background: 'rgba(248, 113, 113, 0.08)',
            border: '1px solid rgba(248, 113, 113, 0.22)',
            borderRadius: 10,
            lineHeight: 1.5,
          }}
        >
          <strong>not available as first vault:</strong> first-vault hardware setup currently
          supports Solana Mobile (Seeker / Phantom Android / Solflare Android) only. switch ika
          base to <strong>Solana</strong> in the header above and pick{' '}
          <strong>Seeker (QR pair)</strong> or <strong>Solana Mobile (this phone)</strong>, or
          go back and create an HD vault first to unlock Ledger / Trezor.
        </div>
      ) : (
        <>
          <label className="ws-import-phrase-label" htmlFor="ws-hw-ika-src">
            copy ika keys from vault
          </label>
          <select
            id="ws-hw-ika-src"
            className={['ws-import-mnemonic', inputCls].filter(Boolean).join(' ')}
            style={{ width: '100%', marginBottom: 12, padding: '10px 12px' }}
            value={hardwareIkaSourceId}
            onChange={(e) => setHardwareIkaSourceId(e.target.value)}
          >
            <option value="">select…</option>
            {ikaSources.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} ({v.accountKind})
              </option>
            ))}
          </select>
          {ikaSources.length === 0 && (
            <p className="ws-password-hint" style={{ fontSize: 12, marginBottom: 10 }}>
              no vault with both ika curves yet — unlock an HD or imported vault, complete dWallet / encryption registration,
              then return here.
            </p>
          )}
        </>
      )}
      {error && <p className="ws-password-error">{error}</p>}
      <div className="ws-import-actions">
        <button
          type="button"
          className="ws-password-btn ws-password-btn--primary"
          disabled={hardwareSubmitBusy}
          onClick={() => void onAddLedgerHardwareVault()}
        >
          {hardwareSubmitBusy ? 'working…' : 'add hardware vault'}
        </button>
        <button
          type="button"
          className="ws-password-btn ws-password-btn--ghost"
          disabled={hardwareSubmitBusy}
          onClick={() => {
            setError(null);
            setStep('password');
          }}
        >
          back to password
        </button>
        {mode === 'addVault' && onDismiss && (
          <button type="button" className="ws-password-btn ws-password-btn--ghost" onClick={onDismiss}>
            cancel
          </button>
        )}
      </div>
    </div>
  );
}
