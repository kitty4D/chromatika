/**
 * MwaConnect - register a Solana Mobile phone as a "hardware" signer.
 * uses the local MWA association flow (Android intent) via
 * `@solana-mobile/mobile-wallet-adapter-protocol-web3js`. requires Chrome on
 * the same Android phone that hosts the MWA wallet. desktop -> phone pairing
 * (remote reflector + QR) is NOT shipped yet; the button is gated to Android
 * upstream in wallet-setup-flow, and this component no longer claims to
 * render a QR code.
 *
 * only Solana is supported (MWA spec covers Solana only).
 */

import { useState } from 'react';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { trpc } from '@/lib/trpc';
import { MWA_APP_IDENTITY } from '@/config/mwa';

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'done'; address: string }
  | { kind: 'error'; msg: string };

/** standard Solana BIP44 derivation path used as the hardware account's derivation key. */
const SOLANA_MWA_DERIVATION_PATH = "m/44'/501'/0'/0'";

export function MwaConnect({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [saved, setSaved] = useState(false);

  async function onConnect() {
    setStatus({ kind: 'connecting' });
    try {
      await transact(async (wallet) => {
        const { accounts } = await wallet.authorize({
          chain: 'solana:mainnet',
          identity: MWA_APP_IDENTITY,
        });

        if (!accounts.length) throw new Error('No accounts returned from mobile wallet');

        const account = accounts[0];
        // address is a Uint8Array (public key bytes), encode as base58
        const { PublicKey } = await import('@solana/web3.js');
        const pubkey = new PublicKey(account.address);
        const address = pubkey.toBase58();

        await trpc['addHardwareAccount'].mutate({
          vendor: 'mwa',
          chain: 'solana',
          derivationPath: SOLANA_MWA_DERIVATION_PATH,
          address,
        });

        setSaved(true);
        setStatus({ kind: 'done', address });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: 'error', msg });
    }
  }

  const label: React.CSSProperties = {
    fontSize: 12,
    marginBottom: 6,
    color: 'rgba(234, 240, 255, 0.62)',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button type="button" className="wc-btn" onClick={onBack} style={{ padding: '6px 12px', fontSize: 12 }}>
          ← back
        </button>
        <div style={{ fontWeight: 800, fontSize: 15 }}>connect solana mobile</div>
      </div>

      <p style={{ ...label, lineHeight: 1.5, marginBottom: 14 }}>
        open chromatika in <strong>Chrome on the same Android phone</strong> that runs a{' '}
        <strong>Solana Mobile Wallet Adapter</strong>-compatible wallet (Phantom Mobile,
        Solflare, etc.). the wallet launches via Android intent and approves every
        transaction - no seed phrase leaves the device. desktop → phone pairing over a QR
        reflector is not shipped yet.
      </p>

      {status.kind === 'error' && (
        <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, marginBottom: 12, lineHeight: 1.4 }}>
          {status.msg}
        </p>
      )}

      {status.kind === 'connecting' && (
        <p style={{ color: 'rgba(245,158,11,0.95)', fontSize: 13, marginBottom: 12 }}>
          authorize chromatika in your mobile wallet…
        </p>
      )}

      {status.kind === 'done' && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            border: '1px solid rgba(16,185,129,0.3)',
            background: 'rgba(16,185,129,0.08)',
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.65)', marginBottom: 2 }}>connected address</div>
          <div style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all', marginBottom: 6 }}>
            {status.address}
          </div>
          {saved && (
            <span style={{ fontSize: 11, color: 'rgba(16,185,129,0.9)' }}>
              added to hardware accounts
            </span>
          )}
        </div>
      )}

      {status.kind !== 'done' && (
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          disabled={status.kind === 'connecting'}
          onClick={onConnect}
          style={{ width: '100%' }}
        >
          {status.kind === 'connecting' ? 'waiting for phone…' : 'connect phone wallet (MWA)'}
        </button>
      )}

      <div
        style={{
          marginTop: 18,
          padding: 12,
          borderRadius: 12,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          fontSize: 11,
          color: 'rgba(234,240,255,0.55)',
          lineHeight: 1.5,
        }}
      >
        <strong>note:</strong> Solana Mobile Wallet Adapter (MWA) covers{' '}
        <strong>Solana only</strong>. every transaction is approved on your phone - the
        extension never holds your private key. requires Phantom Mobile, Solflare, or any
        MWA-compatible wallet. <strong>pre-alpha ika Solana flows are devnet only</strong> -
        do not use with real mainnet assets until ika ships mainnet.
      </div>
    </div>
  );
}
