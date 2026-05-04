/**
 * WalletConnectConnect: pairing flow for a Solana wallet over WalletConnect v2 (Reown).
 * sibling of `SeekerConnect.tsx`; same lifecycle (start -> QR -> approval -> ika USK signature
 * -> onPaired), different SDK and different relay protocol.
 *
 * why a sibling component instead of folding into SeekerConnect:
 * - WC's lifecycle is `signClient.connect()` -> `approval()`; MWA's is `startRemoteScenario()`
 *   -> `scenario.wallet`. forcing one component to branch on transport just relocates the
 *   divergence into a switch.
 * - WC's `solana_signMessage` returns a **raw 64-byte Ed25519 signature in base58** with no
 *   trailing payload bytes, unlike MWA's `signMessages` which appends the original payload.
 *   **do not** copy MWA's strip-suffix step here - hashing 64 bytes minus 64 bytes of payload
 *   would land on `keccak256(empty)` and silently brick restore.
 *
 * half-pair safety: if the user dismisses (or the popup closes) between session approval and
 * the ika USK signature step, we'd otherwise leave a topic on the relay that the wallet thinks
 * is live. the `useEffect` cleanup calls `signClient.disconnect({ topic, reason })` for any
 * topic captured before `onPaired` fires, and we only call `onPaired` once both the session
 * AND the seed-signature are in hand.
 */

import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { PublicKey } from '@solana/web3.js';
import { base58 } from '@scure/base';
import { trpc } from '@/lib/trpc';
import {
  WC_SOLANA_CHAIN_ID_DEVNET,
  WC_SOLANA_CHAIN_ID_MAINNET,
  WC_SOLANA_METHODS,
} from '@/config/wc';
import { getWcSignClient } from '@/ui/hardware/walletconnect-client';
import { IKA_USK_DERIVATION_MESSAGE, IKA_USK_DOMAIN } from '@/background/keyring/hd';

/** logical label for the WC vendor (no BIP44 path concept; the wallet manages its own keys). */
const WC_DERIVATION_PATH_LABEL = 'wc:solana';

type Status =
  | { kind: 'idle' }
  | { kind: 'opening'; msg: string }
  | { kind: 'awaiting_scan'; uri: string; qrDataUrl: string }
  | { kind: 'authorizing'; msg: string }
  | { kind: 'signing_usk'; msg: string }
  | { kind: 'done'; address: string }
  | { kind: 'error'; msg: string };

export type WalletConnectPairResult = {
  address: string;
  sessionTopic: string;
  chainId: string;
  /**
   * base64 of the wallet's signature over `IKA_USK_DERIVATION_MESSAGE` (64-byte raw Ed25519).
   * same property the MWA path produces, used by `addVaultHardware` / `createVaultHardware`
   * to seed `UserShareEncryptionKeys` deterministically.
   */
  ikaUskSignatureB64: string;
};

/** convert a base58 string to base64. WC sends sigs as base58; we persist as base64. */
function base58ToBase64(b58: string): string {
  const bytes = base58.decode(b58);
  return btoa(String.fromCharCode(...bytes));
}

export function WalletConnectConnect({
  onBack,
  onPaired,
}: {
  onBack: () => void;
  onPaired: (r: WalletConnectPairResult) => void;
}) {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  /**
   * if we get a session approved but the user dismisses before the USK sig completes, we owe
   * the relay a `disconnect()`. stored on a ref so unmount cleanup can reach it without
   * re-rendering. cleared after `onPaired` fires successfully.
   */
  const pendingTopicRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      const topic = pendingTopicRef.current;
      pendingTopicRef.current = null;
      if (!topic) return;
      // best-effort cleanup; ignore the result. errSrc shouldn't bubble - the popup is going away.
      void getWcSignClient()
        .then(async (client) => {
          const { getSdkError } = await import('@walletconnect/utils');
          await client.disconnect({ topic, reason: getSdkError('USER_REJECTED') });
        })
        .catch(() => {});
    };
  }, []);

  async function onCancel() {
    const topic = pendingTopicRef.current;
    pendingTopicRef.current = null;
    if (topic) {
      try {
        const client = await getWcSignClient();
        const { getSdkError } = await import('@walletconnect/utils');
        await client.disconnect({ topic, reason: getSdkError('USER_REJECTED') });
      } catch {
        // ignore - relay may already have torn the topic down
      }
    }
    setStatus({ kind: 'idle' });
  }

  async function onStart() {
    setStatus({ kind: 'opening', msg: 'opening relay channel…' });
    try {
      const client = await getWcSignClient();
      // WC v2 deprecated the required/optional distinction; use `optionalNamespaces` which
      // wallets reduce to a session at approval time. modern Solana wallets (Phantom, Solflare,
      // Seeker, Jupiter, etc.) all authorize the namespace they support and ignore the rest.
      //
      // advertise BOTH mainnet and devnet so per-request `chainId` switching works at sign
      // time. wallets bind the authorized account to user's mainnet pubkey regardless (the
      // Ed25519 secret key is the same on every cluster), but each sign request can pick a
      // different cluster, which matters for ika pre-alpha (devnet) vs x402 payments
      // (mainnet) inside the same paired session.
      const { uri, approval } = await client.connect({
        optionalNamespaces: {
          solana: {
            chains: [WC_SOLANA_CHAIN_ID_MAINNET, WC_SOLANA_CHAIN_ID_DEVNET],
            methods: [...WC_SOLANA_METHODS],
            events: [],
          },
        },
      });
      if (!uri) {
        throw new Error('WalletConnect relay returned no pairing URI - check your VITE_WC_PROJECT_ID');
      }
      const qrDataUrl = await QRCode.toDataURL(uri, {
        margin: 1,
        width: 256,
        errorCorrectionLevel: 'M',
      });
      setStatus({ kind: 'awaiting_scan', uri, qrDataUrl });

      const session = await approval();
      pendingTopicRef.current = session.topic;
      setStatus({ kind: 'authorizing', msg: 'session approved — preparing chromatika ika derivation message…' });

      // CAIP-10 account string: `solana:<chainId>:<base58Address>`. wallets always return at
      // least one Solana account when authorizing the namespace; if they don't, treat as a
      // hard fail (signing is impossible without a pubkey).
      const accounts = session.namespaces.solana?.accounts ?? [];
      if (!accounts.length) {
        throw new Error('WalletConnect session did not authorize any Solana accounts');
      }
      const caipAccount = accounts[0]!; // `solana:<chainId>:<addr>`
      const colonIdx = caipAccount.lastIndexOf(':');
      if (colonIdx === -1) {
        throw new Error(`Malformed CAIP-10 account from wallet: ${caipAccount}`);
      }
      const accountAddress = caipAccount.slice(colonIdx + 1);
      const chainId = caipAccount.slice(0, colonIdx);
      // sanity check the address parses as base58 / 32 bytes via PublicKey
      const pubkeyB58 = new PublicKey(accountAddress).toBase58();

      setStatus({
        kind: 'signing_usk',
        msg: `sign the chromatika ika derivation message ("${IKA_USK_DOMAIN}") on your phone…`,
      });
      // WC's `solana_signMessage` `message` param is base58-encoded raw bytes (NOT hex, NOT utf8).
      // the wallet base58-decodes, signs, and returns `{ signature: <base58 64-byte ed25519 sig> }`.
      const messageB58 = base58.encode(IKA_USK_DERIVATION_MESSAGE);
      const sigResp = (await client.request({
        topic: session.topic,
        chainId,
        request: {
          method: 'solana_signMessage',
          params: { message: messageB58, pubkey: pubkeyB58 },
        },
      })) as { signature?: string };
      if (!sigResp?.signature) {
        throw new Error('WalletConnect wallet did not return a signature for the ika derivation message');
      }
      // **Cross-protocol note:** WC returns the raw 64-byte Ed25519 signature only - no MWA-style
      // payload suffix to strip. Do NOT subarray here. `ikaRootSeedFromMwaSignature` hashes
      // whatever bytes you hand it and silently corrupts if you trim something that isn't there.
      const ikaUskSignatureB64 = base58ToBase64(sigResp.signature);

      await trpc['addHardwareAccount'].mutate({
        vendor: 'walletconnect',
        chain: 'solana',
        derivationPath: WC_DERIVATION_PATH_LABEL,
        address: pubkeyB58,
      });

      setStatus({ kind: 'done', address: pubkeyB58 });
      // session is "complete" now - clear the cleanup guard so unmount does not disconnect.
      pendingTopicRef.current = null;
      onPaired({
        address: pubkeyB58,
        sessionTopic: session.topic,
        chainId,
        ikaUskSignatureB64,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // half-pair cleanup runs on unmount via the useEffect return - leave the topic ref alone
      // here so a user retry doesn't double-disconnect.
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
        <div style={{ fontWeight: 800, fontSize: 15 }}>connect via WalletConnect</div>
      </div>

      <p style={{ ...label, lineHeight: 1.5, marginBottom: 14 }}>
        Pair a <strong>Solana wallet</strong> (Phantom Mobile, Solflare, Jupiter Mobile, Seeker, etc.)
        with Chromatika via <strong>WalletConnect v2</strong>. We open a relay channel and render a
        QR code; <strong>scan it with your wallet's WC scanner</strong>. Your secret never leaves the
        phone — every sign re-prompts on the device.
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
            alt="WalletConnect pairing QR"
            width={256}
            height={256}
            style={{ width: 256, height: 256, borderRadius: 10, background: '#fff', padding: 6 }}
          />
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.55)', marginTop: 10, lineHeight: 1.5 }}>
            scan with your wallet's WalletConnect scanner, or copy this URI into the wallet's WC input:
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
            {status.uri}
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
          <div style={{ fontSize: 11, color: 'rgba(234,240,255,0.65)', marginBottom: 2 }}>paired Solana address</div>
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
        <strong>note:</strong> WalletConnect uses a public relay; the relay only routes encrypted
        traffic between Chromatika and your wallet — neither side can read the plaintext. The
        wallet still prompts on the phone for every sign.{' '}
        <strong>pre-alpha ika Solana flows are devnet only</strong> — do not use with real mainnet
        assets until ika ships mainnet.
      </div>
    </div>
  );
}
