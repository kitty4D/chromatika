/**
 * MwaSigner - shown in the hardware sign popup when vendor === 'mwa'.
 *
 * two transports:
 *   - 'local'  : `transact()` fires an Android intent (`solana-wallet://`) -
 *                only works on Android Chrome where the wallet app is installed.
 *   - 'remote' : `startRemoteScenario()` opens a wss to the reflector and we
 *                immediately re-authorize using the persisted `auth_token`.
 *                skips QR rescan when the wallet still trusts us. if the token
 *                is rejected (`ERROR_AUTHORIZATION_FAILED`), we surface a
 *                "re-pair required" message so the user can re-onboard.
 *
 * both routes signTransactions / signMessages the same way once `wallet` is in
 * hand - the dispatch is just transport selection.
 */

import { useEffect, useState } from 'react';
import {
  startRemoteScenario,
  transact,
  type Web3MobileWallet,
} from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { trpc } from '@/lib/trpc';
import { MWA_APP_IDENTITY } from '@/config/mwa';
import { buildRemoteMwaConfig, MWA_REMOTE_HOST_AUTHORITY } from '@/background/hardware/mwa-remote';

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting_phone'; msg: string }
  | { kind: 'done'; sig: string }
  | { kind: 'error'; msg: string; needsRepair?: boolean };

type SignMeta = {
  id: string;
  vendor: 'ledger' | 'trezor' | 'mwa';
  chain: 'evm' | 'bitcoin' | 'sui' | 'solana';
  derivationPath: string;
  payloadHex: string;
  kind: 'message' | 'tx' | 'typedData' | 'suiTx' | 'solanaTx' | 'solanaOffchain' | 'btcTx';
  mwaReflectorUrl?: string;
  mwaTransport?: 'local' | 'remote';
  mwaAuthToken?: string;
  mwaReflectorHost?: string;
  /** friendly cluster label (`'mainnet'` / `'devnet'`) populated by the enqueue site. */
  solanaCluster?: string;
};

/** heuristic for "the auth_token is no longer trusted on the phone, user must re-pair". */
function isAuthorizationFailedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ERROR_AUTHORIZATION_FAILED|auth_token|reauthorize/i.test(msg);
}

/**
 * run the body against an MWA wallet, picking transport from the request meta.
 * throws like `transact()` would on either path; the closure that signs gets
 * the same `Web3MobileWallet` shape regardless of transport.
 */
async function withMwaWallet<T>(
  meta: SignMeta,
  body: (wallet: Web3MobileWallet) => Promise<T>,
): Promise<T> {
  if (meta.mwaTransport === 'remote') {
    const scenario = await startRemoteScenario(
      buildRemoteMwaConfig({
        ...(meta.mwaReflectorHost ? { hostAuthority: meta.mwaReflectorHost } : {}),
      }),
    );
    try {
      const wallet = await scenario.wallet;
      // remote: we always have an auth_token from the original pairing - reauthorize
      // skips the QR rescan. without it the reflector would 404 and the user would
      // be stuck. if the wallet has revoked the token this rejects and we surface
      // a re-pair message.
      if (meta.mwaAuthToken) {
        await wallet.authorize({
          auth_token: meta.mwaAuthToken,
          chain: 'solana:mainnet',
          identity: MWA_APP_IDENTITY,
        });
      } else {
        await wallet.authorize({
          chain: 'solana:mainnet',
          identity: MWA_APP_IDENTITY,
        });
      }
      return await body(wallet);
    } finally {
      try {
        scenario.close();
      } catch {
        // ignore close errors after sign
      }
    }
  }
  // local: Android intent. body runs inside the `transact()` callback.
  return transact(async (wallet) => {
    await wallet.authorize({
      chain: 'solana:mainnet',
      identity: MWA_APP_IDENTITY,
    });
    return body(wallet);
  });
}

export function MwaSigner({ requestId }: { requestId: string }) {
  const [meta, setMeta] = useState<SignMeta | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    trpc['getHardwareSignRequest'].query({ id: requestId })
      .then((m) => setMeta(m as SignMeta))
      .catch((e) => setStatus({ kind: 'error', msg: e instanceof Error ? e.message : String(e) }));
  }, [requestId]);

  async function onSign() {
    if (!meta) return;
    setStatus({ kind: 'connecting' });
    try {
      const transportLabel = meta.mwaTransport === 'remote' ? 'phone (Seeker / remote)' : 'phone (Android intent)';
      setStatus({ kind: 'waiting_phone', msg: `authorize chromatika on your ${transportLabel}…` });

      const sig = await withMwaWallet(meta, async (wallet) => {
        let signature: string;
        if (meta.kind === 'solanaTx') {
          setStatus({ kind: 'waiting_phone', msg: 'approve transaction on your phone…' });
          const txBytes = Buffer.from(meta.payloadHex, 'hex');
          const tx = VersionedTransaction.deserialize(txBytes);
          const [signedTx] = await wallet.signTransactions({ transactions: [tx] });
          if (!signedTx) throw new Error('No signed transaction returned from phone');
          const sigBytes = signedTx.signatures[0];
          if (!sigBytes) throw new Error('Signed transaction has no signature');
          signature = Buffer.from(sigBytes).toString('hex');
        } else if (meta.kind === 'solanaOffchain') {
          setStatus({ kind: 'waiting_phone', msg: 'approve message signing on your phone…' });
          // get the address from the wallet to address the signMessages call. for remote
          // we already authorized above so the wallet handle has the account list.
          // for local we authorize inside `transact()` (see `withMwaWallet` local branch),
          // but the result isn't exposed here - so we re-derive via the active account
          // surfaced through `wallet.authorize` re-call. cheaper: use the first signing
          // account by re-authorizing. MWA spec returns a fresh accounts list each call.
          const auth = await wallet.authorize({
            chain: 'solana:mainnet',
            identity: MWA_APP_IDENTITY,
          });
          if (!auth.accounts.length) throw new Error('No accounts returned from mobile wallet');
          const pubkeyB58 = new PublicKey(auth.accounts[0]!.address).toBase58();
          const msgBytes = Buffer.from(meta.payloadHex, 'hex');
          const [signed] = await wallet.signMessages({
            addresses: [pubkeyB58],
            payloads: [msgBytes],
          });
          if (!signed) throw new Error('No signed message returned from phone');
          signature = Buffer.from(signed).toString('hex');
        } else {
          throw new Error(`MwaSigner: unsupported kind ${meta.kind}`);
        }
        return signature;
      });

      await trpc['resolveHardwareSign'].mutate({ id: meta.id, signature: sig });
      setStatus({ kind: 'done', sig });
      setTimeout(() => window.close(), 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const needsRepair = meta.mwaTransport === 'remote' && isAuthorizationFailedError(e);
      setStatus({ kind: 'error', msg, needsRepair });
      try {
        await trpc['rejectHardwareSign'].mutate({
          id: requestId,
          reason: needsRepair
            ? 'MWA remote auth_token rejected - re-pair Seeker required'
            : msg,
        });
      } catch (rejectErr) {
        console.error('[MwaSigner] rejectHardwareSign after sign failure:', rejectErr);
      }
    }
  }

  async function onReject() {
    try {
      await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: 'user rejected' });
      window.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // already gone (onSign auto-rejected after a sign failure), just close.
      if (/No pending hardware sign request/i.test(msg)) {
        window.close();
        return;
      }
      console.error('[MwaSigner] rejectHardwareSign (user reject):', e);
      setStatus({ kind: 'error', msg: `could not cancel request: ${msg}` });
    }
  }

  if (!meta) {
    return (
      <div className="wc-approvalSheet">
        {status.kind === 'error' ? (
          <p style={{ color: 'var(--theme-banner-error-fg, oklch(0.78 0.14 25))' }}>{status.msg}</p>
        ) : (
          <p>loading request…</p>
        )}
      </div>
    );
  }

  const isBusy =
    status.kind === 'connecting' || status.kind === 'waiting_phone' || status.kind === 'done';

  const transportLabel =
    meta.mwaTransport === 'remote'
      ? `Seeker / remote (${meta.mwaReflectorHost ?? MWA_REMOTE_HOST_AUTHORITY})`
      : 'Android intent (local)';

  return (
    <div className="wc-approvalSheet">
      <div style={{ fontWeight: 800, marginBottom: 16 }}>mobile wallet sign request</div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>chain</div>
      <div style={{ marginBottom: 12, fontWeight: 600 }}>
        SOLANA (MWA)
        {meta.solanaCluster && (
          <span
            style={{
              marginLeft: 8,
              fontSize: 11,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background:
                meta.solanaCluster === 'mainnet'
                  ? 'color-mix(in oklch, oklch(0.7 0.18 152) 30%, transparent)'
                  : 'color-mix(in oklch, oklch(0.76 0.18 80) 30%, transparent)',
              color:
                meta.solanaCluster === 'mainnet'
                  ? 'oklch(0.7 0.18 152)'
                  : 'oklch(0.76 0.18 80)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            {meta.solanaCluster}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>transport</div>
      <div style={{ marginBottom: 12, fontWeight: 600, fontSize: 12 }}>{transportLabel}</div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>type</div>
      <div style={{ marginBottom: 16, fontWeight: 600 }}>{meta.kind}</div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>payload</div>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          wordBreak: 'break-all',
          background: 'color-mix(in oklch, var(--ink, oklch(0.18 0.04 280)) 65%, transparent)',
          padding: 10,
          borderRadius: 10,
          marginBottom: 18,
          maxHeight: 80,
          overflow: 'auto',
        }}
      >
        {meta.payloadHex}
      </div>

      {status.kind === 'error' && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ color: 'var(--theme-banner-error-fg, oklch(0.78 0.14 25))', fontSize: 13, marginBottom: 6 }}>{status.msg}</p>
          {status.needsRepair && (
            <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 12, lineHeight: 1.5 }}>
              your phone wallet revoked Chromatika's pairing token. open the wallet on your
              Seeker, remove Chromatika from trusted apps if needed, then return to the
              extension and run "Connect Seeker (QR pair)" again from the hardware step.
            </p>
          )}
        </div>
      )}
      {status.kind === 'waiting_phone' && (
        <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
      )}
      {status.kind === 'connecting' && (
        <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 14 }}>
          authorize chromatika in your mobile wallet…
        </p>
      )}
      {status.kind === 'done' && (
        <p style={{ color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))', fontSize: 13, marginBottom: 14 }}>signed! closing…</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          disabled={isBusy}
          onClick={onSign}
        >
          {isBusy && status.kind !== 'done' ? 'waiting…' : 'sign on phone'}
        </button>
        <button
          type="button"
          className="wc-btn"
          disabled={status.kind === 'done'}
          onClick={onReject}
        >
          reject
        </button>
      </div>
    </div>
  );
}
