/**
 * WalletConnectSigner - shown in the hardware sign popup when vendor === 'walletconnect'.
 *
 * sibling of `MwaSigner.tsx` rather than an extension of it because the lifecycles diverge:
 *   - WC's relay session is keyed on `wcSessionTopic`; MWA's is keyed on `auth_token`.
 *   - WC errors with `getSdkError('USER_REJECTED')` / `'EXPIRED'` / "no matching session";
 *     MWA errors with `ERROR_AUTHORIZATION_FAILED`.
 *   - WC has no `transact()` Android-intent path - everything goes through the same relay.
 *
 * per-tx flow:
 *   1. background enqueues a sign request with `wcSessionTopic`, `wcChainId`, `wcAccountAddress`.
 *   2. popup mounts, fetches the request meta via tRPC.
 *   3. user clicks "sign on phone" -> we call `signClient.request({ topic, chainId, request })`.
 *   4. `solana_signTransaction` returns either `{ signature }` or `{ transaction }` depending
 *      on the wallet (spec is ambiguous; Phantom returns the latter, others vary). we handle
 *      both shapes, falling back to extracting the first signature off the deserialized
 *      VersionedTransaction.
 *   5. `solana_signMessage` returns `{ signature }` (base58 64-byte raw Ed25519). no payload
 *      suffix to strip - this is the cross-protocol gotcha vs MWA.
 *
 * needsRepair: when the wallet has revoked the session (user removed Chromatika from "connected
 * dapps") the relay rejects with "no matching session" / "session expired". we surface the
 * usual re-pair message and reject the sign request.
 */

import { useEffect, useState } from 'react';
import { VersionedTransaction } from '@solana/web3.js';
import { base58 } from '@scure/base';
import { trpc } from '@/lib/trpc';
import { getWcSignClient } from '@/ui/hardware/walletconnect-client';

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting_phone'; msg: string }
  | { kind: 'done'; sig: string }
  | { kind: 'error'; msg: string; needsRepair?: boolean };

type SignMeta = {
  id: string;
  vendor: 'ledger' | 'trezor' | 'mwa' | 'walletconnect';
  chain: 'evm' | 'bitcoin' | 'sui' | 'solana';
  derivationPath: string;
  payloadHex: string;
  kind: 'message' | 'tx' | 'typedData' | 'suiTx' | 'solanaTx' | 'solanaOffchain' | 'btcTx';
  wcSessionTopic?: string;
  wcChainId?: string;
  wcAccountAddress?: string;
  /** friendly cluster label (`'mainnet'` / `'devnet'`) populated by the enqueue site. */
  solanaCluster?: string;
};

/** heuristic: relay says "no matching session" / "session expired" -> user must re-pair. */
function isWcSessionRevokedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /no matching session|session expired|session not found|EXPIRED|UNAUTHORIZED/i.test(msg);
}

function bytesToHex(u8: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u8.length; i++) {
    out += u8[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function WalletConnectSigner({ requestId }: { requestId: string }) {
  const [meta, setMeta] = useState<SignMeta | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    trpc['getHardwareSignRequest'].query({ id: requestId })
      .then((m) => setMeta(m as SignMeta))
      .catch((e) => setStatus({ kind: 'error', msg: e instanceof Error ? e.message : String(e) }));
  }, [requestId]);

  async function onSign() {
    if (!meta) return;
    if (!meta.wcSessionTopic || !meta.wcChainId || !meta.wcAccountAddress) {
      setStatus({
        kind: 'error',
        msg: 'WalletConnect sign request is missing wcSessionTopic / wcChainId / wcAccountAddress — re-pair from settings',
        needsRepair: true,
      });
      return;
    }
    setStatus({ kind: 'connecting' });
    try {
      const client = await getWcSignClient();
      let signature: string;
      if (meta.kind === 'solanaTx') {
        setStatus({ kind: 'waiting_phone', msg: 'approve transaction on your phone…' });
        // serialize for `solana_signTransaction`. WC param is base58 of the VersionedTransaction
        // wire bytes; the wallet deserializes, prompts, signs, and returns either:
        //   - `{ signature: <base58 64-byte sig> }`           ← Phantom-style (most common)
        //   - `{ transaction: <base58 signed-tx bytes> }`     ← spec ambiguity allows this too
        // we handle both, falling back to extracting the first signature off the round-tripped tx.
        const txBytes = Uint8Array.from(Buffer.from(meta.payloadHex, 'hex'));
        const txB58 = base58.encode(txBytes);
        const resp = (await client.request({
          topic: meta.wcSessionTopic,
          chainId: meta.wcChainId,
          request: {
            method: 'solana_signTransaction',
            params: { transaction: txB58, pubkey: meta.wcAccountAddress },
          },
        })) as { signature?: string; transaction?: string };
        if (resp?.signature) {
          signature = bytesToHex(base58.decode(resp.signature));
        } else if (resp?.transaction) {
          const signedBytes = base58.decode(resp.transaction);
          const signedTx = VersionedTransaction.deserialize(signedBytes);
          const sigBytes = signedTx.signatures[0];
          if (!sigBytes) throw new Error('Signed transaction from wallet has no signatures');
          signature = bytesToHex(sigBytes);
        } else {
          throw new Error('WalletConnect wallet returned neither signature nor transaction for solana_signTransaction');
        }
      } else if (meta.kind === 'solanaOffchain') {
        setStatus({ kind: 'waiting_phone', msg: 'approve message signing on your phone…' });
        // WC's `solana_signMessage` `message` param is base58-encoded raw bytes (NOT hex).
        const msgBytes = Uint8Array.from(Buffer.from(meta.payloadHex, 'hex'));
        const messageB58 = base58.encode(msgBytes);
        const resp = (await client.request({
          topic: meta.wcSessionTopic,
          chainId: meta.wcChainId,
          request: {
            method: 'solana_signMessage',
            params: { message: messageB58, pubkey: meta.wcAccountAddress },
          },
        })) as { signature?: string };
        if (!resp?.signature) {
          throw new Error('WalletConnect wallet did not return a signature for solana_signMessage');
        }
        // **DO NOT strip a payload suffix.** WC returns a raw 64-byte Ed25519 signature only,
        // unlike MWA's `signMessages` which appends the original payload bytes. If a future
        // refactor unifies the two flows, do not re-introduce a suffix-strip here - it would
        // hash 0 bytes and silently brick downstream verification.
        signature = bytesToHex(base58.decode(resp.signature));
      } else {
        throw new Error(`WalletConnectSigner: unsupported kind ${meta.kind}`);
      }

      await trpc['resolveHardwareSign'].mutate({ id: meta.id, signature });
      setStatus({ kind: 'done', sig: signature });
      setTimeout(() => window.close(), 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const needsRepair = isWcSessionRevokedError(e);
      setStatus({ kind: 'error', msg, needsRepair });
      try {
        await trpc['rejectHardwareSign'].mutate({
          id: requestId,
          reason: needsRepair
            ? 'WalletConnect session revoked - re-pair required'
            : msg,
        });
      } catch (rejectErr) {
        console.error('[WalletConnectSigner] rejectHardwareSign after sign failure:', rejectErr);
      }
    }
  }

  async function onReject() {
    try {
      await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: 'user rejected' });
      window.close();
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      // if the request is already gone (onSign auto-rejected after a sign failure,
      // or a sibling popup handled it) the user's intent is already satisfied;
      // just close. only surface "could not cancel" when it's a genuinely different
      // failure (e.g. background SW unreachable).
      if (/No pending hardware sign request/i.test(errMsg)) {
        window.close();
        return;
      }
      console.error('[WalletConnectSigner] rejectHardwareSign (user reject):', e);
      setStatus({ kind: 'error', msg: `could not cancel request: ${errMsg}` });
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

  return (
    <div className="wc-approvalSheet">
      <div style={{ fontWeight: 800, marginBottom: 16 }}>WalletConnect sign request</div>

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>chain</div>
      <div style={{ marginBottom: 12, fontWeight: 600 }}>
        SOLANA (WalletConnect v2)
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

      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>account</div>
      <div style={{ marginBottom: 12, fontWeight: 600, fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
        {meta.wcAccountAddress}
      </div>

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
              your wallet has revoked the WalletConnect session for Chromatika. open the wallet,
              clear Chromatika from connected dapps if needed, then return to the extension and
              run "WalletConnect" pairing again from the hardware step.
            </p>
          )}
        </div>
      )}
      {status.kind === 'waiting_phone' && (
        <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
      )}
      {status.kind === 'connecting' && (
        <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 14 }}>
          opening relay session…
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
