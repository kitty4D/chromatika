/**
 * TrezorConnect - discover and register Trezor accounts (EVM, Bitcoin, Solana).
 * uses @trezor/connect-web in the popup context (iframe from connect.trezor.io).
 * Sui is NOT supported by Trezor Connect, the Sui tab is hidden.
 */

import { useState } from 'react';
import TrezorConnect from '@trezor/connect-web';
import { trpc } from '@/lib/trpc';

type TrezorFamily = 'evm' | 'bitcoin' | 'solana';

type DerivedAccount = {
  path: string;
  address: string;
  family: TrezorFamily;
};

const EVM_PATHS = [
  "m/44'/60'/0'/0/0",
  "m/44'/60'/0'/0/1",
  "m/44'/60'/0'/0/2",
];

const BTC_PATHS: Array<{ path: string; format: 'bech32' | 'legacy' }> = [
  { path: "m/84'/0'/0'/0/0", format: 'bech32' },
  { path: "m/84'/0'/0'/0/1", format: 'bech32' },
  { path: "m/44'/0'/0'/0/0", format: 'legacy' },
];

const SOLANA_PATHS = [
  "m/44'/501'/0'/0'",
  "m/44'/501'/1'/0'",
];

let trezorInitialized = false;
async function ensureTrezorInit() {
  if (trezorInitialized) return;
  await TrezorConnect.init({
    manifest: {
      appName: 'Chromatika',
      email: 'support@chromatika.xyz',
      appUrl: 'https://chromatika.xyz',
    },
    lazyLoad: false,
  });
  trezorInitialized = true;
}

export function TrezorConnect_({ onBack }: { onBack: () => void }) {
  const [family, setFamily] = useState<TrezorFamily>('evm');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DerivedAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  function resetState(nextFamily: TrezorFamily) {
    setFamily(nextFamily);
    setAccounts([]);
    setStatus(null);
    setError(null);
  }

  async function onConnect() {
    setBusy(true);
    setError(null);
    setStatus('opening Trezor Connect…');
    try {
      await ensureTrezorInit();
      const derived: DerivedAccount[] = [];

      if (family === 'evm') {
        for (const path of EVM_PATHS) {
          setStatus(`fetching ${path}…`);
          const result = await TrezorConnect.ethereumGetAddress({ path, showOnTrezor: false });
          if (!result.success) throw new Error(result.payload.error);
          derived.push({ path, address: result.payload.address, family: 'evm' });
        }
      } else if (family === 'bitcoin') {
        for (const { path, format } of BTC_PATHS) {
          setStatus(`fetching ${path} (${format})…`);
          const coin = format === 'bech32' ? 'btc' : 'btc';
          const result = await TrezorConnect.getAddress({ path, coin, showOnTrezor: false });
          if (!result.success) throw new Error(result.payload.error);
          derived.push({ path, address: result.payload.address, family: 'bitcoin' });
        }
      } else {
        // solana
        for (const path of SOLANA_PATHS) {
          setStatus(`fetching ${path}…`);
          const result = await TrezorConnect.solanaGetAddress({ path, showOnTrezor: false });
          if (!result.success) throw new Error(result.payload.error);
          derived.push({ path, address: result.payload.address, family: 'solana' });
        }
      }

      setAccounts(derived);
      setStatus('done - select accounts to add');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSave(acc: DerivedAccount) {
    try {
      await trpc['addHardwareAccount'].mutate({
        vendor: 'trezor',
        chain: acc.family === 'bitcoin' ? 'bitcoin' : acc.family === 'solana' ? 'solana' : 'evm',
        derivationPath: acc.path,
        address: acc.address,
      });
      setSaved((prev) => new Set([...prev, `${acc.family}:${acc.address}`]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const label: React.CSSProperties = {
    fontSize: 12,
    marginBottom: 6,
    color: 'var(--muted)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button type="button" className="wc-btn" onClick={onBack} style={{ padding: '6px 12px', fontSize: 12 }}>
          ← back
        </button>
        <div style={{ fontWeight: 800, fontSize: 15 }}>connect trezor</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          className={family === 'evm' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => resetState('evm')}
        >
          Ethereum
        </button>
        <button
          type="button"
          className={family === 'bitcoin' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => resetState('bitcoin')}
        >
          Bitcoin
        </button>
        <button
          type="button"
          className={family === 'solana' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => resetState('solana')}
        >
          Solana
        </button>
      </div>

      <p style={{ ...label, lineHeight: 1.5, marginBottom: 14 }}>
        plug in your Trezor (or connect via Trezor Bridge). Trezor Connect will open in an
        iframe - confirm the device prompt.{' '}
        <strong>Sui is not supported</strong> by Trezor Connect.
      </p>

      {error && (
        <p style={{ color: 'var(--theme-banner-error-fg, oklch(0.78 0.14 25))', fontSize: 13, marginBottom: 12, lineHeight: 1.4 }}>{error}</p>
      )}
      {status && !error && (
        <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 12 }}>{status}</p>
      )}

      {accounts.length === 0 && (
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          disabled={busy}
          onClick={onConnect}
          style={{ width: '100%' }}
        >
          {busy ? 'connecting…' : 'connect trezor'}
        </button>
      )}

      {accounts.length > 0 && (
        <div>
          <div style={{ ...label, marginBottom: 12 }}>
            derived {family.toUpperCase()} accounts - add to device list:
          </div>
          {accounts.map((acc) => (
            <div
              key={`${acc.family}:${acc.address}`}
              style={{
                padding: '10px 12px',
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.10)',
                background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 50%, transparent)',
                marginBottom: 8,
              }}
            >
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>
                {acc.path}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all', marginBottom: 8 }}>
                {acc.address}
              </div>
              {saved.has(`${acc.family}:${acc.address}`) ? (
                <span style={{ fontSize: 11, color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))' }}>added</span>
              ) : (
                <button
                  type="button"
                  className="wc-btn wc-btnPrimary"
                  style={{ fontSize: 12, padding: '6px 14px' }}
                  onClick={() => onSave(acc)}
                >
                  add account
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="wc-btn"
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => { setAccounts([]); setStatus(null); }}
          >
            refresh / reconnect
          </button>
        </div>
      )}

      <div
        style={{
          marginTop: 18,
          padding: 12,
          borderRadius: 12,
          background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 50%, transparent)',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          color: 'var(--faint)',
          lineHeight: 1.5,
        }}
      >
        <strong>note:</strong> Trezor accounts use Trezor Connect (iframe from connect.trezor.io).
        EVM, Bitcoin (native segwit + legacy), and Solana are supported.{' '}
        <strong>Sui is not supported by Trezor.</strong>
      </div>
    </div>
  );
}
