/**
 * TrezorSigner - shown in the hardware sign popup when vendor === 'trezor'.
 * uses @trezor/connect-web in the popup context (iframe from connect.trezor.io).
 * supported chains: evm (message / tx / typedData), bitcoin (btcTx), solana (solanaTx / solanaOffchain).
 * Sui is NOT supported by Trezor Connect.
 */

import { useEffect, useState } from 'react';
import TrezorConnect from '@trezor/connect-web';
import { networks } from 'bitcoinjs-lib';
import { trpc } from '@/lib/trpc';
import {
  decomposeBtcPsbtForTrezor,
  fetchAndDecodeRefTxs,
} from '@/background/chains/btc-trezor-decompose';

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
  bitcoinNetworkId?: 'btc-mainnet' | 'btc-testnet';
  bitcoinEsploraBase?: string;
};

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

/** strip 0x prefix if present. */
function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function TrezorSigner({ requestId }: { requestId: string }) {
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
      await ensureTrezorInit();
      setStatus({ kind: 'waiting_device', msg: 'confirm on Trezor device…' });

      let sig: string;

      if (meta.chain === 'evm') {
        if (meta.kind === 'message') {
          const result = await TrezorConnect.ethereumSignMessage({
            path: meta.derivationPath,
            message: meta.payloadHex,
            hex: true,
          });
          if (!result.success) throw new Error(result.payload.error);
          sig = `0x${result.payload.signature}`;
        } else if (meta.kind === 'typedData') {
          // payloadHex is the full JSON-encoded EIP-712 typed data string (hex-encoded UTF-8)
          const jsonStr = Buffer.from(meta.payloadHex, 'hex').toString('utf8');
          const typedData = JSON.parse(jsonStr) as object;
          const result = await TrezorConnect.ethereumSignTypedData({
            path: meta.derivationPath,
            data: typedData as Parameters<typeof TrezorConnect.ethereumSignTypedData>[0]['data'],
            metamask_v4_compat: true,
          });
          if (!result.success) throw new Error(result.payload.error);
          sig = `0x${result.payload.signature}`;
        } else {
          // tx, payloadHex is a serialized unsigned EVM transaction hex
          // trezor expects the transaction fields decomposed; for now we pass the raw hex
          // as a message sign fallback until full EVM tx decomposition is wired.
          // TODO: parse RLP fields and call ethereumSignTransaction with proper tx object.
          throw new Error(
            'EVM transaction signing via Trezor requires RLP field decomposition — use the ika dWallet path for now.'
          );
        }
      } else if (meta.chain === 'bitcoin' && meta.kind === 'btcTx') {
        // PSBT -> Trezor TxInputType[] / TxOutputType[] / RefTransaction[] decomposition.
        // trezor `signTransaction` requires:
        //   1. inputs with `script_type` + `prev_hash` + `prev_index` + `amount` + `address_n`
        //   2. outputs with `script_type` + `amount` + (`address` external | `address_n` change)
        //   3. refTxs: every prev tx whose UTXO is being spent, fetched from Esplora and
        //      reshaped into Trezor's bin_outputs/inputs format so the device can verify
        //      input values by hashing the prev tx and matching against `prev_hash`.
        if (!meta.bitcoinNetworkId) {
          throw new Error('Trezor BTC signing requires bitcoinNetworkId in the sign meta');
        }
        if (!meta.bitcoinEsploraBase) {
          throw new Error('Trezor BTC signing requires bitcoinEsploraBase in the sign meta');
        }
        const network = meta.bitcoinNetworkId === 'btc-mainnet' ? networks.bitcoin : networks.testnet;
        // decompose. the Trezor account address comes from the device at sign time, but
        // for the PSBT decomposition we just need the BIP44 path, no address comparison.
        // change-output detection is best-effort: if the PSBT has a change output that
        // round-trips to the same `address_n`-derived address, the user sees "change to
        // own account" rather than "external send."
        setStatus({ kind: 'waiting_device', msg: 'fetching ref txs from Esplora…' });
        const decomposed = decomposeBtcPsbtForTrezor(strip0x(meta.payloadHex), {
          signerAddress: '', // change-detection skipped without it; chromatika may pass via meta in future
          signerDerivationPath: meta.derivationPath,
          network,
        });
        const refTxs = await fetchAndDecodeRefTxs(decomposed.refTxIds, meta.bitcoinEsploraBase);
        setStatus({ kind: 'waiting_device', msg: 'confirm on Trezor device…' });
        // cast inputs/outputs/refTxs through `unknown` to satisfy Trezor's deeply-typed
        // protobuf shapes, chromatika's narrower interfaces match the runtime contract
        // but TS can't prove it without importing the full schema chain.
        const result = await TrezorConnect.signTransaction({
          coin: decomposed.coin,
          inputs: decomposed.inputs as unknown as Parameters<
            typeof TrezorConnect.signTransaction
          >[0]['inputs'],
          outputs: decomposed.outputs as unknown as Parameters<
            typeof TrezorConnect.signTransaction
          >[0]['outputs'],
          refTxs: refTxs as unknown as Parameters<typeof TrezorConnect.signTransaction>[0]['refTxs'],
        });
        if (!result.success) throw new Error(result.payload.error);
        // Trezor returns the finalized serialized tx hex; chromatika's btc-send-native
        // path expects the broadcast-ready hex (matches Ledger's signPsbtBuffer return).
        sig = result.payload.serializedTx;
      } else if (meta.chain === 'solana') {
        if (meta.kind === 'solanaTx') {
          const result = await TrezorConnect.solanaSignTransaction({
            path: meta.derivationPath,
            serializedTx: strip0x(meta.payloadHex),
          });
          if (!result.success) throw new Error(result.payload.error);
          sig = result.payload.signature;
        } else if (meta.kind === 'solanaOffchain') {
          // off-chain message bytes, Trezor doesn't have a dedicated off-chain message
          // RPC, so we sign as a raw message using solanaSignTransaction with a note.
          throw new Error('Trezor does not support Solana off-chain message signing. Use a Ledger or MWA wallet for this operation.');
        } else {
          throw new Error(`TrezorSigner: unsupported solana kind ${meta.kind}`);
        }
      } else {
        throw new Error(`TrezorSigner: unsupported chain=${meta.chain} kind=${meta.kind}`);
      }

      await trpc['resolveHardwareSign'].mutate({ id: meta.id, signature: sig });
      setStatus({ kind: 'done', sig });
      setTimeout(() => window.close(), 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: 'error', msg });
      try {
        await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: msg });
      } catch (rejectErr) {
        console.error('[TrezorSigner] rejectHardwareSign after sign failure:', rejectErr);
      }
    }
  }

  async function onReject() {
    try {
      await trpc['rejectHardwareSign'].mutate({ id: requestId, reason: 'user rejected' });
      window.close();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // already gone (onSign auto-rejected after a sign failure) → just close.
      if (/No pending hardware sign request/i.test(msg)) {
        window.close();
        return;
      }
      console.error('[TrezorSigner] rejectHardwareSign (user reject):', e);
      setStatus({ kind: 'error', msg: `could not cancel request: ${msg}` });
    }
  }

  if (!meta) {
    return (
      <div className="wc-approvalSheet">
        {status.kind === 'error' ? (
          <p style={{ color: 'rgba(255,99,132,0.95)' }}>{status.msg}</p>
        ) : (
          <p>loading request…</p>
        )}
      </div>
    );
  }

  const isBusy =
    status.kind === 'connecting' || status.kind === 'waiting_device' || status.kind === 'done';

  return (
    <div className="wc-approvalSheet">
      <div style={{ fontWeight: 800, marginBottom: 16 }}>trezor sign request</div>

      <div style={{ fontSize: 12, color: 'rgba(234,240,255,0.6)', marginBottom: 4 }}>chain</div>
      <div style={{ marginBottom: 12, fontWeight: 600 }}>{meta.chain.toUpperCase()}</div>

      <div style={{ fontSize: 12, color: 'rgba(234,240,255,0.6)', marginBottom: 4 }}>derivation path</div>
      <div style={{ marginBottom: 12, fontFamily: 'monospace', fontSize: 13 }}>{meta.derivationPath}</div>

      <div style={{ fontSize: 12, color: 'rgba(234,240,255,0.6)', marginBottom: 4 }}>type</div>
      <div style={{ marginBottom: 16, fontWeight: 600 }}>{meta.kind}</div>

      <div style={{ fontSize: 12, color: 'rgba(234,240,255,0.6)', marginBottom: 4 }}>payload</div>
      <div
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          wordBreak: 'break-all',
          background: 'rgba(0,0,0,0.25)',
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
        <p style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
      )}
      {status.kind === 'waiting_device' && (
        <p style={{ color: 'rgba(245,158,11,0.95)', fontSize: 13, marginBottom: 14 }}>{status.msg}</p>
      )}
      {status.kind === 'done' && (
        <p style={{ color: 'rgba(16,185,129,0.95)', fontSize: 13, marginBottom: 14 }}>signed! closing…</p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button
          type="button"
          className="wc-btn wc-btnPrimary"
          disabled={isBusy}
          onClick={onSign}
        >
          {isBusy && status.kind !== 'done' ? 'signing…' : 'sign'}
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
