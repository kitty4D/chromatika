/**
 * native BTC transfer from the P2WPKH dWallet address: esplora UTXOs, PSBT (segwit v0), ika SECP256K1 sign, broadcast.
 * when session.bitcoinLedgerFee is set, the PSBT is sent to the Ledger device via the hardware sign popup.
 */

import { Psbt, Transaction, address, networks, payments, script } from 'bitcoinjs-lib';
import { getSession } from '@/background/session';
import { getDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { BUILTIN_BITCOIN } from '@/config/networks';
import { getDwalletSecpPublicKey } from '@/background/chains/bitcoin';
import { signBitcoinTxSighashPreimage } from '@/background/chains/signing';
import { witnessV0Preimage } from '@/background/chains/btc-witness-preimage';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';

const DUST_SATS = 546n;

/** parse decimal BTC string to satoshis. */
export function parseDecimalBtcToSats(amount: string): bigint {
  const t = amount.trim();
  if (!t || t === '.') return 0n;
  const neg = t.startsWith('-');
  const u = neg ? t.slice(1) : t;
  const [wholeRaw, fracRaw = ''] = u.split('.');
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const frac = (fracRaw + '00000000').slice(0, 8);
  const sats = BigInt(whole) * 100_000_000n + BigInt(frac || '0');
  return neg ? -sats : sats;
}

function btcNetworkIdToBitcoinJs(id: string) {
  if (id === 'btc-mainnet') return networks.bitcoin;
  return networks.testnet;
}

type EsploraUtxo = {
  txid: string;
  vout: number;
  value: number;
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return (await r.json()) as T;
}

async function fetchFeeRateSatPerVb(esploraBase: string): Promise<number> {
  try {
    const j = await fetchJson<Record<string, number>>(`${esploraBase.replace(/\/$/, '')}/fee-estimates`);
    const rate = j['6'] ?? j['3'] ?? j['1'] ?? 2;
    return Math.max(1, Math.ceil(rate));
  } catch {
    return 2;
  }
}

function estimateVbytes(inputCount: number, outputCount: number): number {
  return 10 + 68 * inputCount + 31 * outputCount;
}

function pickUtxos(utxos: EsploraUtxo[], targetSats: bigint): EsploraUtxo[] {
  const sorted = [...utxos].sort((a, b) => b.value - a.value);
  const out: EsploraUtxo[] = [];
  let sum = 0n;
  for (const u of sorted) {
    out.push(u);
    sum += BigInt(u.value);
    if (sum >= targetSats) return out;
  }
  throw new Error('Insufficient balance for amount plus fee');
}


async function broadcastTxHex(txHex: string, esploraBase: string): Promise<string> {
  const br = await fetch(`${esploraBase}/tx`, {
    method: 'POST',
    body: txHex,
    headers: { 'Content-Type': 'text/plain' },
    signal: AbortSignal.timeout(60_000),
  });
  const bodyText = await br.text();
  if (!br.ok) throw new Error(bodyText || `Broadcast failed: HTTP ${br.status}`);
  return bodyText.trim();
}

/**
 * build, sign with ika (SECP256K1 presign pool), and broadcast a native BTC spend from P2WPKH.
 * when session.bitcoinLedgerFee is set, the PSBT is sent to the Ledger popup for signing.
 * returns the txid (hex string, explorer order).
 */
export async function sendBtcNativeTransfer(toAddress: string, amountBtc: string): Promise<string> {
  const sendSats = parseDecimalBtcToSats(amountBtc);
  if (sendSats <= 0n) throw new Error('Amount must be positive');

  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const dw = await getDwalletNetworkSettings(s.activeVaultId, {
    network: s.network,
    baseChain: s.activeVaultBaseChain,
  });
  const net = BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId);
  if (!net) throw new Error('Unknown Bitcoin network');

  const bitcoinJsNetwork = btcNetworkIdToBitcoinJs(dw.btcNetworkId);
  const esploraBase = net.esploraUrl.replace(/\/$/, '');

  // ledger path: build PSBT from the stored address, enqueue for device signing.
  // LedgerSigner fetches the compressed pubkey from the device and populates
  // knownAddressDerivations so signPsbtBuffer can sign all inputs.
  // the popup returns the finalized raw tx hex which we broadcast here.
  if (s.bitcoinLedgerFee) {
    const ledgerPsbt = await buildBtcPsbtForLedger(
      toAddress,
      sendSats,
      bitcoinJsNetwork,
      esploraBase,
      s.bitcoinLedgerFee.address,
    );

    const psbtHex = Buffer.from(ledgerPsbt.toBuffer()).toString('hex');
    // signPsbtBuffer returns the finalized tx hex when finalizePsbt:true in LedgerSigner.
    // for the parallel Trezor path we'd populate `bitcoinNetworkId` + `bitcoinEsploraBase`
    // so the signer can decompose the PSBT under the right network. ledger's
    // signPsbtBuffer is network-aware internally so we don't strictly need them here, but
    // we populate anyway to keep the meta record uniform across vendors.
    const txHex = await enqueueHardwareSign({
      vendor: 'ledger',
      chain: 'bitcoin',
      derivationPath: s.bitcoinLedgerFee.derivationPath,
      payloadHex: psbtHex,
      kind: 'btcTx',
      bitcoinNetworkId: dw.btcNetworkId === 'btc-mainnet' ? 'btc-mainnet' : 'btc-testnet',
      bitcoinEsploraBase: esploraBase,
    });
    const ledgerTxid = await broadcastTxHex(txHex, esploraBase);
    await recordBtcSendForOriginTracking(ledgerTxid, s.activeVaultId, dw.btcNetworkId);
    return ledgerTxid;
  }

  // ika path: sign each input's sighash preimage with SECP256K1 dWallet.
  const pubkey = await getDwalletSecpPublicKey();
  const pay = payments.p2wpkh({ pubkey: Buffer.from(pubkey), network: bitcoinJsNetwork });
  if (!pay.address || !pay.output) throw new Error('Could not derive P2WPKH payment');
  const fromAddress = pay.address;

  let toScript: Uint8Array;
  try {
    toScript = address.toOutputScript(toAddress.trim(), bitcoinJsNetwork);
  } catch {
    throw new Error('Invalid destination address for this network');
  }

  const utxoUrl = `${esploraBase}/address/${encodeURIComponent(fromAddress)}/utxo`;
  const utxos = await fetchJson<EsploraUtxo[]>(utxoUrl);
  if (!utxos.length) throw new Error('No UTXOs at this address - fund it first');

  const feeRate = await fetchFeeRateSatPerVb(esploraBase);
  const sighashType = Transaction.SIGHASH_ALL;
  const p2pkhSigningScript = payments.p2pkh({ hash: pay.output.slice(2), network: bitcoinJsNetwork }).output!;
  const feeBufferSats = BigInt(Math.max(500, feeRate * estimateVbytes(1, 2)));
  let selected = pickUtxos(utxos, sendSats + feeBufferSats);

  let txidOut: string | undefined;

  for (let round = 0; round < 12; round++) {
    const nIn = selected.length;
    let nOut = 2;
    let fee = BigInt(feeRate * estimateVbytes(nIn, nOut));
    const totalIn = selected.reduce((s, u) => s + BigInt(u.value), 0n);
    let change = totalIn - sendSats - fee;

    if (change < 0n) {
      selected = pickUtxos(utxos, sendSats + fee + 1n);
      continue;
    }
    if (change > 0n && change <= DUST_SATS) {
      nOut = 1;
      fee = BigInt(feeRate * estimateVbytes(nIn, nOut));
      change = totalIn - sendSats - fee;
      if (change < 0n) {
        selected = pickUtxos(utxos, sendSats + fee + 1n);
        continue;
      }
    }

    const psbt = new Psbt({ network: bitcoinJsNetwork });
    for (const u of selected) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: {
          script: pay.output,
          value: BigInt(u.value),
        },
      });
    }
    psbt.addOutput({ script: toScript, value: sendSats });
    if (change > DUST_SATS) {
      psbt.addOutput({ address: fromAddress, value: change });
    }

    const tx = (psbt.data.globalMap.unsignedTx as unknown as { tx: InstanceType<typeof Transaction> }).tx;

    // policy vault: declare the full sendSats value (in micro-USD) on the FIRST sign call
    // only, and 0 on subsequent ones. otherwise an N-input tx would accumulate N times its
    // actual value against the daily cap.
    //
    // hard-policy mode: when the user has opted into PolicyVault, also pass the BTC/USD
    // price (as micro-USD/sat) so the Move-side `sign_btc_with_policy` can decode the
    // BIP143 preimage's `amount` field and enforce the cap on chain-derived value. to
    // preserve the "only count once" property under the chain decoder, only the FIRST
    // sign call in the loop runs in hard mode, subsequent inputs use the soft path with
    // declaredValueMicros = 0n. net cap impact: identical to the soft-policy path, but
    // the FIRST input's value is enforced from chain bytes (not the caller's claim).
    const { resolveBtcDeclaredValueMicros, resolveBtcPriceMicrosPerSatoshi } = await import(
      '@/background/policy-vault/policy-vault-btc-value'
    );
    const totalDeclaredValueMicros = await resolveBtcDeclaredValueMicros(sendSats);
    const btcPriceMicrosPerSatoshi = await resolveBtcPriceMicrosPerSatoshi();

    for (let i = 0; i < nIn; i++) {
      const u = selected[i];
      const preimage = witnessV0Preimage(tx, i, p2pkhSigningScript, BigInt(u.value), sighashType);
      const { signature: sigHex } = await signBitcoinTxSighashPreimage(preimage, {
        declaredValueMicros: i === 0 ? totalDeclaredValueMicros : 0n,
        // hard-policy on first input only, when price resolved successfully (>0). subsequent
        // inputs always go through soft (declaredValueMicros=0n) so they don't double-count.
        isBtcTx: i === 0 && btcPriceMicrosPerSatoshi > 0n,
        priceMicrosPerSatoshi: i === 0 ? btcPriceMicrosPerSatoshi : undefined,
      });
      const hex = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
      if (hex.length !== 128) throw new Error('Unexpected ika signature length for BTC tx');
      const sig64 = Uint8Array.from(hex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      const encodedSig = script.signature.encode(sig64, sighashType);
      psbt.updateInput(i, {
        partialSig: [{ pubkey: Buffer.from(pubkey), signature: encodedSig }],
      });
    }

    psbt.finalizeAllInputs();
    const extracted = psbt.extractTransaction();
    const txHex = extracted.toHex();

    const br = await fetch(`${esploraBase}/tx`, {
      method: 'POST',
      body: txHex,
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(60_000),
    });
    const bodyText = await br.text();
    if (!br.ok) {
      if (/fee|insufficient|too low|sat\/vbyte/i.test(bodyText) && selected.length < utxos.length) {
        selected = pickUtxos(utxos, totalIn + 20_000n);
        continue;
      }
      throw new Error(bodyText || `Broadcast failed: HTTP ${br.status}`);
    }

    txidOut = bodyText.trim() || extracted.getId();
    break;
  }

  if (!txidOut) throw new Error('Could not broadcast transaction');
  await recordBtcSendForOriginTracking(txidOut, s.activeVaultId, dw.btcNetworkId);
  return txidOut;
}

/**
 * persist a `btc-send` tx-record so the activity feed picks up the wallet-ui send. origin is
 * `null` (wallet-ui-initiated). storage failures don't propagate, the broadcast already
 * succeeded by the time we get here.
 */
async function recordBtcSendForOriginTracking(
  txid: string,
  vaultId: string,
  btcNetworkId: string,
): Promise<void> {
  try {
    const { recordSignedTx } = await import('@/background/services/tx-record');
    await recordSignedTx({
      txHash: txid,
      origin: null,
      chainId: btcNetworkId,
      vaultId,
      timestampMs: Date.now(),
      kind: 'btc-send',
    });
  } catch (e) {
    console.warn('[chromatika tx-record] btc-send origin record failed', e);
  }
}

/**
 * build a fee-settled P2WPKH PSBT for Ledger signing from a known address (no pubkey needed).
 * LedgerSigner fetches the pubkey from the device during the signing popup flow.
 */
async function buildBtcPsbtForLedger(
  toAddress: string,
  sendSats: bigint,
  bitcoinJsNetwork: ReturnType<typeof btcNetworkIdToBitcoinJs>,
  esploraBase: string,
  ledgerAddress: string,
): Promise<Psbt> {
  let fromScript: Uint8Array;
  try {
    fromScript = address.toOutputScript(ledgerAddress.trim(), bitcoinJsNetwork);
  } catch {
    throw new Error('Invalid Ledger Bitcoin address');
  }

  let toScript: Uint8Array;
  try {
    toScript = address.toOutputScript(toAddress.trim(), bitcoinJsNetwork);
  } catch {
    throw new Error('Invalid destination address for this network');
  }

  const utxoUrl = `${esploraBase}/address/${encodeURIComponent(ledgerAddress)}/utxo`;
  const utxos = await fetchJson<EsploraUtxo[]>(utxoUrl);
  if (!utxos.length) throw new Error('No UTXOs at Ledger Bitcoin address - fund it first');

  const feeRate = await fetchFeeRateSatPerVb(esploraBase);
  const feeBufferSats = BigInt(Math.max(500, feeRate * estimateVbytes(1, 2)));
  let selected = pickUtxos(utxos, sendSats + feeBufferSats);

  for (let round = 0; round < 12; round++) {
    const nIn = selected.length;
    let nOut = 2;
    let fee = BigInt(feeRate * estimateVbytes(nIn, nOut));
    const totalIn = selected.reduce((s, u) => s + BigInt(u.value), 0n);
    let change = totalIn - sendSats - fee;

    if (change < 0n) {
      selected = pickUtxos(utxos, sendSats + fee + 1n);
      continue;
    }
    if (change > 0n && change <= DUST_SATS) {
      nOut = 1;
      fee = BigInt(feeRate * estimateVbytes(nIn, nOut));
      change = totalIn - sendSats - fee;
      if (change < 0n) {
        selected = pickUtxos(utxos, sendSats + fee + 1n);
        continue;
      }
    }

    const psbt = new Psbt({ network: bitcoinJsNetwork });
    for (const u of selected) {
      psbt.addInput({
        hash: u.txid,
        index: u.vout,
        witnessUtxo: { script: fromScript, value: BigInt(u.value) },
      });
    }
    psbt.addOutput({ script: toScript, value: sendSats });
    if (change > DUST_SATS) {
      psbt.addOutput({ address: ledgerAddress, value: change });
    }
    return psbt;
  }

  throw new Error('Could not settle Ledger BTC fee after 12 attempts');
}
