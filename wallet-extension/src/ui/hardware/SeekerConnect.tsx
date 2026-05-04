/**
 * SeekerConnect - desktop Chromium pairing flow for a Solana Seeker (or any
 * MWA-compliant phone wallet). runs `startRemoteScenario` from the side panel
 * / popup so the wss reflector handshake gets a real `window.btoa`/`window.atob`
 * - the MV3 service worker can't host this lib (uses `window` global).
 *
 * flow:
 *   1. user clicks "start pairing" - we open a wss to the reflector and get
 *      back an `associationUrl` shaped `solana-wallet:/v1/associate/remote?...`
 *   2. we render that URL as a QR; user scans with the Seeker camera (or pastes
 *      it into the MWA wallet's "scan link" input).
 *   3. wallet on the phone connects to the reflector, ECDH handshake completes,
 *      `wallet` Promise resolves.
 *   4. we call `wallet.authorize({ chain: 'solana:mainnet', identity })` and
 *      receive `{ accounts: [{ address }], auth_token }`. base64-encoded address
 *      bytes get re-encoded to base58 (Solana standard surface).
 *   5. parent receives `{ address, authToken, reflectorHost }` via `onPaired`
 *      and persists them on the next "add hardware vault" mutation. we close
 *      the scenario so the wss does not leak.
 *
 * error paths:
 *   - if the user closes the QR before scan, `scenario.close()` and idle.
 *   - if `wallet.authorize` rejects (user denied on phone), surface the error
 *     and let them retry without re-rendering the QR if the wss is still up.
 *
 * see `wallet-extension/docs/future/SEEKER_REMOTE_MWA.md` for the wire format.
 */

import { useEffect, useRef, useState } from 'react';
import { startRemoteScenario, type Web3RemoteScenario } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import QRCode from 'qrcode';
import { trpc } from '@/lib/trpc';
import { MWA_APP_IDENTITY } from '@/config/mwa';
import { buildRemoteMwaConfig, MWA_REMOTE_HOST_AUTHORITY } from '@/background/hardware/mwa-remote';
import { IKA_USK_DERIVATION_MESSAGE, IKA_USK_DOMAIN } from '@/background/keyring/hd';

/** standard Solana BIP44 derivation path - logical label for MWA accounts (the wallet, not us, holds the key). */
const SOLANA_MWA_DERIVATION_PATH = "m/44'/501'/0'/0'";

type Status =
  | { kind: 'idle' }
  | { kind: 'opening'; msg: string }
  | { kind: 'awaiting_scan'; associationUrl: string; qrDataUrl: string }
  | { kind: 'authorizing'; msg: string }
  | { kind: 'signing_usk'; msg: string }
  | { kind: 'done'; address: string }
  | { kind: 'error'; msg: string };

export type SeekerPairResult = {
  address: string;
  authToken: string;
  reflectorHost: string;
  /**
   * base64 of the Seeker's signature over `IKA_USK_DERIVATION_MESSAGE`. used by
   * `addVaultHardware` to seed ika `UserShareEncryptionKeys` deterministically, same
   * Seeker on a different device -> same signature -> same ika seed -> same dWallet.
   */
  ikaUskSignatureB64: string;
};

export function SeekerConnect({
  onBack,
  onPaired,
}: {
  onBack: () => void;
  onPaired: (r: SeekerPairResult) => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  /** keep a ref so unmount can `close()` the wss even if React swapped state. */
  const scenarioRef = useRef<Web3RemoteScenario | null>(null);

  useEffect(() => {
    return () => {
      try {
        scenarioRef.current?.close();
      } catch {
        // ignore close errors on unmount
      }
      scenarioRef.current = null;
    };
  }, []);

  async function onCancel() {
    try {
      scenarioRef.current?.close();
    } catch {
      // ignore - reflector may already be closed
    }
    scenarioRef.current = null;
    setStatus({ kind: 'idle' });
  }

  async function onStart() {
    setStatus({ kind: 'opening', msg: 'opening secure channel to reflector…' });
    try {
      const scenario = await startRemoteScenario(buildRemoteMwaConfig());
      scenarioRef.current = scenario;
      const associationUrl = scenario.associationUrl.toString();
      const qrDataUrl = await QRCode.toDataURL(associationUrl, {
        margin: 1,
        width: 256,
        errorCorrectionLevel: 'M',
      });
      setStatus({ kind: 'awaiting_scan', associationUrl, qrDataUrl });

      const wallet = await scenario.wallet;
      setStatus({ kind: 'authorizing', msg: 'approve in your Seed Vault…' });

      const auth = await wallet.authorize({
        chain: 'solana:mainnet',
        identity: MWA_APP_IDENTITY,
      });
      if (!auth.accounts.length) throw new Error('No accounts returned from mobile wallet');
      const account = auth.accounts[0]!;
      const pubkey = new PublicKey(account.address);
      const address = pubkey.toBase58();

      // capture the ika USK derivation signature now (wss session is open + already authorized).
      // re-deriving on a new device requires re-running this same signature, so we ask the
      // wallet once during pairing rather than every unlock. determinism (Ed25519 RFC 8032)
      // is what makes Seeker-only restore possible, same Seeker, same domain string, same
      // signature, same ika seed, same dWallet.
      setStatus({ kind: 'signing_usk', msg: 'sign the chromatika ika derivation message in your Seed Vault…' });
      const sigPayloads = await wallet.signMessages({
        addresses: [account.address],
        payloads: [IKA_USK_DERIVATION_MESSAGE],
      });
      if (!sigPayloads.length || !(sigPayloads[0] instanceof Uint8Array)) {
        throw new Error(
          `Mobile wallet did not return a signature for the ika derivation message ("${IKA_USK_DOMAIN}")`,
        );
      }
      const sigBytes = sigPayloads[0];
      // the MWA spec returns the original message bytes prefixed with the 64-byte Ed25519
      // signature. strip the prefix so the seed derivation hashes only the signature.
      const sigOnly =
        sigBytes.length > IKA_USK_DERIVATION_MESSAGE.length
          ? sigBytes.subarray(0, sigBytes.length - IKA_USK_DERIVATION_MESSAGE.length)
          : sigBytes;
      const ikaUskSignatureB64 = btoa(String.fromCharCode(...sigOnly));

      await trpc['addHardwareAccount'].mutate({
        vendor: 'mwa',
        chain: 'solana',
        derivationPath: SOLANA_MWA_DERIVATION_PATH,
        address,
      });

      setStatus({ kind: 'done', address });
      onPaired({
        address,
        authToken: auth.auth_token,
        reflectorHost: MWA_REMOTE_HOST_AUTHORITY,
        ikaUskSignatureB64,
      });

      // tear down the wss now that we have the auth_token; subsequent signs
      // open their own scenarios from the signer popup.
      try {
        scenario.close();
      } catch {
        // ignore close errors after a successful pair
      }
      scenarioRef.current = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        scenarioRef.current?.close();
      } catch {
        // ignore - reflector may already be closed
      }
      scenarioRef.current = null;
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
        <div style={{ fontWeight: 800, fontSize: 15 }}>connect Seeker (QR pair)</div>
      </div>

      <p style={{ ...label, lineHeight: 1.5, marginBottom: 14 }}>
        Pair your <strong>Solana Seeker</strong> (or any MWA-compliant phone wallet) with
        Chromatika running on this desktop. We open a secure channel to the Solana Mobile
        reflector and render a QR code; <strong>scan it with the Seeker</strong> and approve in
        Seed Vault. Your secret never leaves the phone - every sign re-prompts on the device.
      </p>

      {status.kind === 'awaiting_scan' && (
        <div
          style={{
            padding: 14,
            borderRadius: 14,
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
            marginBottom: 14,
            textAlign: 'center',
          }}
        >
          <img
            src={status.qrDataUrl}
            alt="Seeker pairing QR"
            width={256}
            height={256}
            style={{ width: 256, height: 256, borderRadius: 10, background: '#fff', padding: 6 }}
          />
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', marginTop: 10, lineHeight: 1.5 }}>
            scan with your Seeker camera, or paste this URL into your wallet's <em>scan link</em> input:
          </div>
          <div
            style={{
              fontFamily: 'monospace',
              fontSize: 10,
              wordBreak: 'break-all',
              marginTop: 6,
              color: 'rgba(234,240,255,0.7)',
              userSelect: 'all',
            }}
          >
            {status.associationUrl}
          </div>
        </div>
      )}

      {status.kind === 'opening' && (
        <p style={{ color: 'rgba(245,158,11,0.95)', fontSize: 13, marginBottom: 12 }}>{status.msg}</p>
      )}
      {status.kind === 'authorizing' && (
        <p style={{ color: 'rgba(245,158,11,0.95)', fontSize: 13, marginBottom: 12 }}>{status.msg}</p>
      )}
      {status.kind === 'signing_usk' && (
        <p style={{ color: 'rgba(245,158,11,0.95)', fontSize: 13, marginBottom: 12 }}>{status.msg}</p>
      )}
      {status.kind === 'error' && (
        <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, marginBottom: 12, lineHeight: 1.4 }}>
          {status.msg}
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
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.65)', marginBottom: 2 }}>paired Seed Vault address</div>
          <div style={{ fontSize: 12, fontFamily: 'monospace', wordBreak: 'break-all' }}>{status.address}</div>
        </div>
      )}

      {status.kind === 'idle' && (
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          onClick={() => void onStart()}
          style={{ width: '100%' }}
        >
          start pairing
        </button>
      )}

      {(status.kind === 'awaiting_scan'
        || status.kind === 'opening'
        || status.kind === 'authorizing'
        || status.kind === 'signing_usk') && (
        <button
          type="button"
          className="wc-btn"
          onClick={() => void onCancel()}
          style={{ width: '100%' }}
        >
          cancel pairing
        </button>
      )}

      {status.kind === 'error' && (
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          onClick={() => void onStart()}
          style={{ width: '100%' }}
        >
          retry pairing
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
        <strong>note:</strong> the reflector is hosted by Solana Mobile at{' '}
        <code>{MWA_REMOTE_HOST_AUTHORITY}</code>. the <code>auth_token</code> we get back from
        your wallet is encrypted with your Chromatika password and lets us skip QR rescan on
        every sign - the Seed Vault still prompts on the phone for each approval.{' '}
        <strong>pre-alpha ika Solana flows are devnet only</strong> - do not use with real
        mainnet assets until ika ships mainnet.
      </div>
    </div>
  );
}
