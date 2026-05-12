/**
 * LedgerSigner - shown in a popup opened by background when a hardware sign is pending.
 * WebHID runs here (popup context), never in the service worker.
 */

import { useEffect, useState } from 'react';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import EthApp from '@ledgerhq/hw-app-eth';
import SuiLedger from '@ledgerhq/hw-app-sui';
import SolanaLedger from '@ledgerhq/hw-app-solana';
import BtcLedger from '@ledgerhq/hw-app-btc';
import { compressPublicKey } from '@ledgerhq/hw-app-btc/lib/compressPublicKey.js';
import { Psbt } from 'bitcoinjs-lib';
import { toSerializedSignature } from '@mysten/sui/cryptography';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { hash160 as btcHash160 } from 'bitcoinjs-lib/src/crypto';
import { trpc } from '@/lib/trpc';
import { reportLedgerSignFailure } from '@/background/hw-telemetry';

type Status =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'waiting_device'; msg: string }
  | { kind: 'done'; sig: string }
  | { kind: 'error'; msg: string };

type SignMeta = {
  id: string;
  vendor: 'ledger' | 'trezor' | 'mwa';
  chain: 'evm' | 'bitcoin' | 'sui' | 'solana';
  derivationPath: string;
  payloadHex: string;
  kind: 'message' | 'tx' | 'typedData' | 'suiTx' | 'solanaTx' | 'solanaOffchain' | 'btcTx';
  ed25519PublicKeyB64?: string;
};

/** convert a BIP32 path string like "m/84'/0'/0'/0/0" to a number[] for Ledger knownAddressDerivations. */
function pathStringToNumbers(path: string): number[] {
  return path
    .replace(/^m\//, '')
    .split('/')
    .map((seg) => {
      const hardened = seg.endsWith("'");
      const n = parseInt(hardened ? seg.slice(0, -1) : seg, 10);
      return hardened ? n + 0x80000000 : n;
    });
}

/** infer account path (strip last 2 segments: change + index) and address format from full derivation path. */
function btcLedgerAccountPath(fullPath: string): { accountPath: string; addressFormat: 'legacy' | 'p2sh' | 'bech32' | 'bech32m' } {
  const segs = fullPath.replace(/^m\//, '').split('/');
  const accountPath = 'm/' + segs.slice(0, -2).join('/');
  const purpose = parseInt(segs[0]?.replace("'", '') ?? '44', 10);
  const addressFormat =
    purpose === 84 ? 'bech32'
    : purpose === 86 ? 'bech32m'
    : purpose === 49 ? 'p2sh'
    : 'legacy';
  return { accountPath, addressFormat };
}

export function LedgerSigner({ requestId }: { requestId: string }) {
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
      const transport = await TransportWebHID.create();
      setStatus({ kind: 'waiting_device', msg: 'confirm on ledger device…' });

      let sig: string;
      if (meta.chain === 'evm') {
        const eth = new EthApp(transport);
        if (meta.kind === 'message') {
          const r = await eth.signPersonalMessage(meta.derivationPath, meta.payloadHex);
          // EthApp returns { v, r, s } components
          const v = r.v.toString(16).padStart(2, '0');
          sig = `0x${r.r}${r.s}${v}`;
        } else if (meta.kind === 'typedData') {
          // EIP-712: pass preimage bytes (background already encoded "\x19\x01" + domain + struct)
          const r = await eth.signEIP712HashedMessage(meta.derivationPath, meta.payloadHex.slice(0, 66), meta.payloadHex.slice(66, 132));
          const v = r.v.toString(16).padStart(2, '0');
          sig = `0x${r.r}${r.s}${v}`;
        } else {
          // raw RLP transaction
          const r = await eth.signTransaction(meta.derivationPath, meta.payloadHex);
          sig = `0x${r.r}${r.s}${r.v}`;
        }
      } else if (meta.chain === 'sui' && meta.kind === 'suiTx') {
        if (!meta.ed25519PublicKeyB64) {
          throw new Error('missing ed25519 public key for Sui Ledger sign');
        }
        const suiApp = new SuiLedger(transport);
        const rawTxn = Buffer.from(meta.payloadHex, 'hex');
        const { signature } = await suiApp.signTransaction(meta.derivationPath, rawTxn);
        const pk = new Ed25519PublicKey(meta.ed25519PublicKeyB64);
        const sigBytes = new Uint8Array(signature);
        sig = toSerializedSignature({
          signature: sigBytes,
          signatureScheme: 'ED25519',
          publicKey: pk,
        });
      } else if (meta.chain === 'solana' && (meta.kind === 'solanaTx' || meta.kind === 'solanaOffchain')) {
        const solApp = new SolanaLedger(transport);
        const raw = Buffer.from(meta.payloadHex, 'hex');
        const { signature } =
          meta.kind === 'solanaTx'
            ? await solApp.signTransaction(meta.derivationPath, raw)
            : await solApp.signOffchainMessage(meta.derivationPath, raw);
        sig = Buffer.from(signature).toString('hex');
      } else if (meta.chain === 'bitcoin' && meta.kind === 'btcTx') {
        const btcApp = new BtcLedger({ transport });
        const psbtBuf = Buffer.from(meta.payloadHex, 'hex');

        // fetch the compressed pubkey from device so we can build knownAddressDerivations.
        setStatus({ kind: 'waiting_device', msg: 'fetching bitcoin key from device…' });
        const walletInfo = await btcApp.getWalletPublicKey(meta.derivationPath, { format: 'bech32' });
        const rawPubkeyBuf = Buffer.from(walletInfo.publicKey, 'hex');
        const compressedPubkey = compressPublicKey(rawPubkeyBuf);
        const h160 = btcHash160(compressedPubkey);
        const h160hex = Buffer.from(h160).toString('hex');

        const { accountPath, addressFormat } = btcLedgerAccountPath(meta.derivationPath);
        const fullPathNums = pathStringToNumbers(meta.derivationPath);

        const knownAddressDerivations = new Map<string, { pubkey: Buffer; path: number[] }>();
        knownAddressDerivations.set(h160hex, { pubkey: compressedPubkey, path: fullPathNums });

        setStatus({ kind: 'waiting_device', msg: 'confirm bitcoin transaction on ledger device…' });
        const result = await btcApp.signPsbtBuffer(psbtBuf, {
          finalizePsbt: true,
          accountPath,
          addressFormat,
          knownAddressDerivations,
        });

        // signPsbtBuffer with finalizePsbt:true returns the raw tx hex in result.tx
        if (!result.tx) {
          // fallback: parse the finalized PSBT and extract the tx manually
          const finalPsbt = Psbt.fromBuffer(result.psbt);
          finalPsbt.finalizeAllInputs();
          sig = finalPsbt.extractTransaction().toHex();
        } else {
          sig = result.tx;
        }
      } else {
        throw new Error(`Unsupported sign request: chain=${meta.chain} kind=${meta.kind}`);
      }

      await transport.close();
      await trpc['resolveHardwareSign'].mutate({ id: meta.id, signature: sig });
      setStatus({ kind: 'done', sig });
      setTimeout(() => window.close(), 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      reportLedgerSignFailure(msg, { chain: meta?.chain ?? 'unknown', kind: meta?.kind ?? 'unknown' });
      setStatus({ kind: 'error', msg });
      try {
        await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: msg });
      } catch (rejectErr) {
        // reject RPC failure is secondary - the original sign error is already
        // in status. log so the background can be fixed if it's unreachable.
        console.error('[LedgerSigner] rejectHardwareSign after sign failure:', rejectErr);
      }
    }
  }

  async function onReject() {
    try {
      await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: 'user rejected' });
      window.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // already gone (onSign auto-rejected after a sign failure, or a sibling
      // popup handled it) → just close. only surface "could not cancel" when it's
      // a genuinely different failure (e.g. background SW unreachable) so a
      // pending request never silently hangs.
      if (/No pending hardware sign request/i.test(msg)) {
        window.close();
        return;
      }
      console.error('[LedgerSigner] rejectHardwareSign (user reject):', e);
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

  return (
    <div className="wc-approvalSheet">
        <div style={{ fontWeight: 800, marginBottom: 16 }}>ledger sign request</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>chain</div>
        <div style={{ marginBottom: 12, fontWeight: 600 }}>{meta.chain.toUpperCase()}</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>derivation path</div>
        <div style={{ marginBottom: 12, fontFamily: 'monospace', fontSize: 13 }}>{meta.derivationPath}</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>type</div>
        <div style={{ marginBottom: 16, fontWeight: 600 }}>{meta.kind}</div>

        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 4 }}>payload</div>
        <div style={{ fontFamily: 'monospace', fontSize: 11, wordBreak: 'break-all', background: 'color-mix(in oklch, var(--ink, oklch(0.18 0.04 280)) 65%, transparent)', padding: 10, borderRadius: 10, marginBottom: 18, maxHeight: 80, overflow: 'auto' }}>
          {meta.payloadHex}
        </div>

        {status.kind === 'error' && (
          <p style={{ color: 'var(--theme-banner-error-fg, oklch(0.78 0.14 25))', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
        )}
        {status.kind === 'waiting_device' && (
          <p style={{ color: 'var(--theme-banner-warn-fg, oklch(0.78 0.18 80))', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
        )}
        {status.kind === 'done' && (
          <p style={{ color: 'var(--theme-banner-success-fg, oklch(0.78 0.16 152))', fontSize: 13, marginBottom: 14 }}>signed! closing…</p>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <button
            type="button"
            className="wc-btn wc-btnPrimary"
            disabled={status.kind === 'connecting' || status.kind === 'waiting_device' || status.kind === 'done'}
            onClick={onSign}
          >
            {status.kind === 'connecting' || status.kind === 'waiting_device' ? 'signing…' : 'sign'}
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
