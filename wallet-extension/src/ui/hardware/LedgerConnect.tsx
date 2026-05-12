/**
 * LedgerConnect - allows the user to connect a Ledger and derive addresses.
 * only used in the popup/side panel (WebHID lives here).
 */

import { useState } from 'react';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import EthApp from '@ledgerhq/hw-app-eth';
import BtcLedger from '@ledgerhq/hw-app-btc';
import { compressPublicKey } from '@ledgerhq/hw-app-btc/lib/compressPublicKey.js';
import { trpc } from '@/lib/trpc';
import { deriveLedgerSuiAccounts } from '@/ui/hardware/ledger-sui-derive';
import { deriveLedgerSolanaAccounts } from '@/ui/hardware/ledger-solana-derive';
import { MwaConnect } from '@/ui/hardware/MwaConnect';
import { TrezorConnect_ } from '@/ui/hardware/TrezorConnect';

type LedgerFamily = 'evm' | 'sui' | 'solana' | 'bitcoin';

/** Bitcoin BIP84 (native segwit / bech32) and BIP44 (legacy) derivation paths. */
const BTC_PATHS: Array<{ path: string; format: 'bech32' | 'legacy' }> = [
  { path: "m/84'/0'/0'/0/0", format: 'bech32' },
  { path: "m/84'/0'/0'/0/1", format: 'bech32' },
  { path: "m/44'/0'/0'/0/0", format: 'legacy' },
];

type DerivedAccount = {
  path: string;
  address: string;
  family: LedgerFamily;
  ed25519PublicKeyB64?: string;
};

/** EVM derivation paths to present to the user */
const EVM_PATHS = [
  "m/44'/60'/0'/0/0",
  "m/44'/60'/0'/0/1",
  "m/44'/60'/0'/0/2",
  "m/44'/60'/1'/0/0", // ledger live legacy
];

export function LedgerConnect({ onBack }: { onBack: () => void }) {
  const [subView, setSubView] = useState<'ledger' | 'mwa' | 'trezor'>('ledger');
  const [family, setFamily] = useState<LedgerFamily>('evm');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DerivedAccount[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  if (subView === 'mwa') return <MwaConnect onBack={() => setSubView('ledger')} />;
  if (subView === 'trezor') return <TrezorConnect_ onBack={() => setSubView('ledger')} />;

  async function onConnect() {
    setBusy(true);
    setError(null);
    setStatus('requesting WebHID permission…');
    try {
      const transport = await TransportWebHID.create();
      setStatus('fetching addresses from Ledger…');
      const derived: DerivedAccount[] = [];
      if (family === 'evm') {
        const eth = new EthApp(transport);
        for (const path of EVM_PATHS) {
          const hwPath = path.startsWith("m/") ? path.slice(2) : path;
          const { address } = await eth.getAddress(hwPath, false);
          derived.push({ path, address, family: 'evm' });
        }
      } else if (family === 'sui') {
        const suiRows = await deriveLedgerSuiAccounts(transport);
        for (const row of suiRows) {
          derived.push({
            path: row.path,
            address: row.address,
            family: 'sui',
            ed25519PublicKeyB64: row.ed25519PublicKeyB64,
          });
        }
      } else if (family === 'bitcoin') {
        const btcApp = new BtcLedger({ transport });
        for (const { path, format } of BTC_PATHS) {
          const hwPath = path.startsWith("m/") ? path.slice(2) : path;
          const walletInfo = await btcApp.getWalletPublicKey(hwPath, { format });
          derived.push({ path, address: walletInfo.bitcoinAddress, family: 'bitcoin' });
        }
        void compressPublicKey; // imported for LedgerSigner; suppress unused warning in this file
      } else {
        const solRows = await deriveLedgerSolanaAccounts(transport);
        for (const row of solRows) {
          derived.push({ path: row.path, address: row.address, family: 'solana' });
        }
      }

      await transport.close();
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
        vendor: 'ledger',
        chain: acc.family === 'sui' ? 'sui' : acc.family === 'solana' ? 'solana' : acc.family === 'bitcoin' ? 'bitcoin' : 'evm',
        derivationPath: acc.path,
        address: acc.address,
        ed25519PublicKeyB64: acc.ed25519PublicKeyB64,
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
        <div style={{ fontWeight: 800, fontSize: 15 }}>connect ledger</div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <button
          type="button"
          className={family === 'evm' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => {
            setFamily('evm');
            setAccounts([]);
            setStatus(null);
            setError(null);
          }}
        >
          Ethereum app
        </button>
        <button
          type="button"
          className={family === 'sui' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => {
            setFamily('sui');
            setAccounts([]);
            setStatus(null);
            setError(null);
          }}
        >
          Sui app
        </button>
        <button
          type="button"
          className={family === 'solana' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => {
            setFamily('solana');
            setAccounts([]);
            setStatus(null);
            setError(null);
          }}
        >
          Solana app
        </button>
        <button
          type="button"
          className={family === 'bitcoin' ? 'wc-btn wc-btnPrimary' : 'wc-btn'}
          style={{ flex: 1, fontSize: 12, padding: '8px 10px' }}
          onClick={() => {
            setFamily('bitcoin');
            setAccounts([]);
            setStatus(null);
            setError(null);
          }}
        >
          Bitcoin app
        </button>
      </div>

      <p style={{ ...label, lineHeight: 1.5, marginBottom: 14 }}>
        plug in your Ledger, open the{' '}
        <strong>{family === 'sui' ? 'Sui' : family === 'solana' ? 'Solana' : family === 'bitcoin' ? 'Bitcoin' : 'Ethereum'}</strong> app, then click
        connect. WebHID needs a user gesture (this screen counts).
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
          {busy ? 'connecting…' : 'connect ledger (WebHID)'}
        </button>
      )}

      {accounts.length > 0 && (
        <div>
          <div style={{ ...label, marginBottom: 12 }}>
            derived {family === 'sui' ? 'Sui' : family === 'solana' ? 'Solana' : family === 'bitcoin' ? 'Bitcoin' : 'EVM'} accounts — add to device list:
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

      <div style={{ marginTop: 14, display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="wc-btn"
          style={{ flex: 1, fontSize: 11, padding: '8px 10px' }}
          onClick={() => setSubView('mwa')}
        >
          + Solana Mobile (MWA)
        </button>
        <button
          type="button"
          className="wc-btn"
          style={{ flex: 1, fontSize: 11, padding: '8px 10px' }}
          onClick={() => setSubView('trezor')}
        >
          + Trezor
        </button>
      </div>

      <div style={{ marginTop: 12, padding: 12, borderRadius: 12, background: 'color-mix(in oklch, var(--surface, oklch(0.22 0.045 285)) 50%, transparent)', border: '1px solid rgba(255,255,255,0.08)', fontSize: 11, color: 'var(--faint)', lineHeight: 1.5 }}>
        <strong>note:</strong> ledger accounts are display-only; signing routes through the Ledger device. Bitcoin on Ledger uses the Bitcoin app with native segwit (bech32) or legacy P2PKH paths. Trezor and Solana Mobile (MWA) accounts are added via the buttons above.
      </div>
    </div>
  );
}
