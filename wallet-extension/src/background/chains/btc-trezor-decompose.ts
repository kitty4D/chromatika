/**
 * PSBT -> Trezor `signTransaction` decomposition.
 *
 * Trezor (unlike Ledger which accepts a PSBT blob directly via `signPsbtBuffer`) requires
 * the host to break the PSBT down into:
 *   - `inputs: TxInputType[]` with `prev_hash`, `prev_index`, `amount`, `script_type`,
 *     `address_n` (BIP44 derivation path)
 *   - `outputs: TxOutputType[]` with `address` or `address_n`, `amount`, `script_type`
 *   - `refTxs: RefTransaction[]`: for each input, the prev tx whose UTXO is being spent.
 *     Trezor verifies the UTXO value by hashing the prev tx and matching against the
 *     input's `prev_hash`, so the host MUST fetch each referenced tx.
 *
 * this module is split into two layers:
 *   1. **pure parser** (`decomposeBtcPsbtForTrezor`): PSBT bytes in, Trezor input/output
 *      shape out. plus `decodeRawTxToRefTransaction` for parsing prev tx hex into the
 *      Trezor `RefTransaction` shape. both are unit-testable without the device.
 *   2. **I/O helper** (`fetchAndDecodeRefTxs`): wraps `decodeRawTxToRefTransaction` with
 *      Esplora `/tx/<hash>/hex` fetches. live network call, not unit-tested directly.
 *
 * scope (initial ship):
 *   - **P2WPKH** (segwit v0). the chromatika BTC send path produces P2WPKH PSBTs today.
 *   - single-account / single-derivation-path. multi-input txs are supported as long as
 *     all inputs spend from the same Trezor address.
 *   - mainnet + testnet (`coin` field maps via `bitcoinJsNetworkToTrezorCoin`).
 *
 * out of scope (future):
 *   - taproot (P2TR / SPENDTAPROOT): Trezor supports it but chromatika doesn't emit
 *     P2TR sends today.
 *   - multi-account inputs (would need per-input `address_n` resolution).
 *   - legacy P2PKH-only inputs (chromatika's BTC dWallet is segwit-native).
 *
 * caveat: this module is exercised end-to-end only with a real Trezor device. unit tests
 * cover the byte-level parser shapes, the round-trip (sign + broadcast) requires hardware
 * and is documented as a manual e2e in `wallet-extension/docs/STATUS.md` "Manual hardware
 * smoke tests."
 */

import { Psbt, Transaction, networks } from 'bitcoinjs-lib';

// we re-declare lightly-typed shapes here rather than importing the `@trezor/connect`
// types directly. Trezor's protobuf types in `lib/types/api/bitcoin` use opaque
// `TObject` schemas at the leaves, pulling them through tsc would double the build time
// (and they'd still need wider casts at the call site). the shapes below match the
// runtime contract of `@trezor/connect-web` `signTransaction({ inputs, outputs, refTxs, coin })`.

/** Trezor TxInputType (subset used by chromatika's segwit-v0 paths). */
export interface TrezorTxInput {
  /** BIP44-style path as number array (e.g. m/84'/0'/0'/0/0 -> [2147483732, 2147483648, 2147483648, 0, 0]). */
  address_n: number[];
  /** hex prev txid in BIG-endian display order (Trezor's expected format). */
  prev_hash: string;
  prev_index: number;
  /** UTXO value in sats. pass as string to be safe across u64 ranges. */
  amount: string;
  /** P2WPKH = SPENDWITNESS, P2SH-P2WPKH = SPENDP2SHWITNESS, legacy P2PKH = SPENDADDRESS. */
  script_type: 'SPENDWITNESS' | 'SPENDP2SHWITNESS' | 'SPENDADDRESS';
  sequence?: number;
}

/** Trezor TxOutputType (subset). */
export interface TrezorTxOutput {
  /** external-address output: only `address` is set. */
  address?: string;
  /** change output to own address: `address_n` is set instead of `address`. */
  address_n?: number[];
  amount: string;
  /** PAYTOADDRESS for legacy/script outputs, PAYTOWITNESS for own-change to P2WPKH. */
  script_type: 'PAYTOADDRESS' | 'PAYTOWITNESS' | 'PAYTOP2SHWITNESS';
}

/** Trezor RefTransaction (the v0/segwit-v0 variant, non-shielded chains). */
export interface TrezorRefTransaction {
  /** hex tx hash in big-endian display order. */
  hash: string;
  version: number;
  inputs: Array<{
    prev_hash: string;
    prev_index: number;
    script_sig: string;
    sequence: number;
  }>;
  /** Trezor calls this `bin_outputs` for refTxs (vs `outputs` on the active tx). */
  bin_outputs: Array<{
    amount: string;
    script_pubkey: string;
  }>;
  lock_time: number;
}

/**
 * map a bitcoinjs `Network` to Trezor's coin string. Trezor's `coin` parameter is the
 * canonical lowercase name: `'btc'` for mainnet, `'test'` for testnet/signet.
 */
export function bitcoinJsNetworkToTrezorCoin(network: ReturnType<typeof getNetworkFromTransaction>): string {
  if (network === networks.bitcoin) return 'btc';
  if (network === networks.testnet) return 'test';
  // default to test for any non-mainnet network. Trezor will reject unknown coins.
  return 'test';
}

function getNetworkFromTransaction(): typeof networks.bitcoin {
  return networks.bitcoin;
}

/**
 * parse a BIP44-style derivation path string ("m/84'/0'/0'/0/0") into Trezor's number array.
 * hardened components (those ending in `'`) get `0x80000000` added.
 */
export function parseBip44PathToNumbers(path: string): number[] {
  const trimmed = path.trim().replace(/^m\//i, '');
  if (!trimmed) return [];
  const parts = trimmed.split('/');
  const out: number[] = [];
  for (const p of parts) {
    const hardened = p.endsWith("'") || p.endsWith('h') || p.endsWith('H');
    const numStr = hardened ? p.slice(0, -1) : p;
    const n = Number.parseInt(numStr, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid derivation path component: ${p}`);
    }
    out.push(hardened ? n + 0x80000000 : n);
  }
  return out;
}

/**
 * detect script type from a `witnessUtxo.script` Buffer. P2WPKH starts with `0x00 0x14`
 * (OP_0 PUSH20). P2SH-P2WPKH wraps it in `0xa9 0x14 ... 0x87`. P2PKH is `0x76 0xa9 0x14 ... 0x88 0xac`.
 */
function detectInputScriptType(witnessScript: Uint8Array | undefined): TrezorTxInput['script_type'] {
  if (!witnessScript || witnessScript.length === 0) return 'SPENDADDRESS';
  // P2WPKH: 0x00 0x14 <20 bytes>
  if (witnessScript.length === 22 && witnessScript[0] === 0x00 && witnessScript[1] === 0x14) {
    return 'SPENDWITNESS';
  }
  // P2SH: 0xa9 0x14 <20 bytes> 0x87
  if (witnessScript.length === 23 && witnessScript[0] === 0xa9 && witnessScript[1] === 0x14 && witnessScript[22] === 0x87) {
    return 'SPENDP2SHWITNESS';
  }
  // default to legacy.
  return 'SPENDADDRESS';
}

/**
 * detect output script type from raw output script bytes.
 */
function detectOutputScriptType(outputScript: Uint8Array): TrezorTxOutput['script_type'] {
  // P2WPKH or P2WSH: 0x00 0x14|0x20 <hash>
  if (outputScript.length >= 22 && outputScript[0] === 0x00 && (outputScript[1] === 0x14 || outputScript[1] === 0x20)) {
    return 'PAYTOWITNESS';
  }
  if (outputScript.length === 23 && outputScript[0] === 0xa9 && outputScript[1] === 0x14 && outputScript[22] === 0x87) {
    return 'PAYTOP2SHWITNESS';
  }
  return 'PAYTOADDRESS';
}

export interface TrezorBtcDecomposed {
  inputs: TrezorTxInput[];
  outputs: TrezorTxOutput[];
  /** distinct prev txids (display-order hex) the caller must fetch + decode into refTxs. */
  refTxIds: string[];
  coin: string;
}

/**
 * decompose a PSBT for Trezor signing. pure: no I/O. caller fetches `refTxs` separately
 * via `fetchAndDecodeRefTxs(refTxIds, esploraBase)`.
 *
 * @param psbtHex hex-encoded PSBT
 * @param opts.signerAddress the Trezor address whose pubkey signs all inputs (chromatika's
 *   single-account model)
 * @param opts.signerDerivationPath BIP44-style path string for the signer (e.g. "m/84'/0'/0'/0/0")
 * @param opts.network bitcoinjs Network (mainnet or testnet)
 * @param opts.changeAddressDerivationPath optional path for change outputs back to own address.
 *   if not provided, all outputs are treated as external (`PAYTOADDRESS`).
 */
export function decomposeBtcPsbtForTrezor(
  psbtHex: string,
  opts: {
    signerAddress: string;
    signerDerivationPath: string;
    network: typeof networks.bitcoin;
    changeAddress?: string;
    changeAddressDerivationPath?: string;
  },
): TrezorBtcDecomposed {
  const psbt = Psbt.fromHex(psbtHex, { network: opts.network });
  const tx = (psbt.data.globalMap.unsignedTx as unknown as { tx: InstanceType<typeof Transaction> }).tx;
  const signerPath = parseBip44PathToNumbers(opts.signerDerivationPath);
  const changePath = opts.changeAddressDerivationPath
    ? parseBip44PathToNumbers(opts.changeAddressDerivationPath)
    : null;

  const inputs: TrezorTxInput[] = [];
  const refTxIdsSet = new Set<string>();

  for (let i = 0; i < tx.ins.length; i++) {
    const psbtInput = psbt.data.inputs[i];
    if (!psbtInput) throw new Error(`PSBT input ${i} missing`);
    const witnessUtxo = psbtInput.witnessUtxo;
    if (!witnessUtxo) {
      throw new Error(
        `PSBT input ${i} has no witnessUtxo. Trezor decomposition requires witness_utxo for each segwit input.`,
      );
    }
    const txin = tx.ins[i]!;
    // bitcoinjs `Transaction.ins[i].hash` is little-endian (storage order). Trezor expects
    // big-endian display order, reverse the bytes.
    const prevHashLe = txin.hash;
    const prevHashHex = bytesToHexBe(prevHashLe);
    refTxIdsSet.add(prevHashHex);

    inputs.push({
      address_n: signerPath,
      prev_hash: prevHashHex,
      prev_index: txin.index,
      amount: BigInt(witnessUtxo.value).toString(),
      script_type: detectInputScriptType(witnessUtxo.script),
      sequence: txin.sequence,
    });
  }

  const outputs: TrezorTxOutput[] = [];
  for (let j = 0; j < tx.outs.length; j++) {
    const txout = tx.outs[j]!;
    const scriptType = detectOutputScriptType(txout.script);
    // if the output script encodes the change address AND we have its path, mark it as
    // `address_n` (own-change) instead of `address` (external). Trezor confirms own-change
    // visually and never asks the user to confirm value flowing back to themselves.
    const decoded = tryDecodeOutputAddress(txout.script, opts.network);
    const isChange = !!(opts.changeAddress && changePath && decoded === opts.changeAddress);

    if (isChange && changePath) {
      outputs.push({
        address_n: changePath,
        amount: BigInt(txout.value).toString(),
        // change to own segwit address
        script_type: scriptType === 'PAYTOWITNESS' ? 'PAYTOWITNESS' : 'PAYTOADDRESS',
      });
    } else {
      if (!decoded) {
        throw new Error(
          `Output ${j} has no decodable address (script type ${scriptType}). Trezor requires decoded addresses for external outputs.`,
        );
      }
      outputs.push({
        address: decoded,
        amount: BigInt(txout.value).toString(),
        script_type: scriptType,
      });
    }
  }

  return {
    inputs,
    outputs,
    refTxIds: Array.from(refTxIdsSet),
    coin: opts.network === networks.bitcoin ? 'btc' : 'test',
  };
}

/**
 * decode a raw transaction hex string into Trezor's `RefTransaction` (bin_outputs variant).
 * pure: no network calls. caller passes the bytes already fetched.
 */
export function decodeRawTxToRefTransaction(rawHex: string): TrezorRefTransaction {
  const txBytes = Buffer.from(rawHex, 'hex');
  const tx = Transaction.fromBuffer(txBytes);
  // Trezor expects the txid in big-endian display order. bitcoinjs `tx.getHash()` returns
  // little-endian, reverse for display.
  const hashHex = bytesToHexBe(tx.getHash());

  return {
    hash: hashHex,
    version: tx.version,
    inputs: tx.ins.map((i) => ({
      prev_hash: bytesToHexBe(i.hash),
      prev_index: i.index,
      script_sig: bytesToHex(i.script),
      sequence: i.sequence,
    })),
    bin_outputs: tx.outs.map((o) => ({
      amount: BigInt(o.value).toString(),
      script_pubkey: bytesToHex(o.script),
    })),
    lock_time: tx.locktime,
  };
}

/**
 * fetch + decode every refTxId from Esplora. Trezor needs the prev tx data for every input.
 * sequential (not parallel) to be polite to public Esplora endpoints, chromatika BTC sends
 * are typically <10 inputs.
 */
export async function fetchAndDecodeRefTxs(
  refTxIds: string[],
  esploraBase: string,
): Promise<TrezorRefTransaction[]> {
  const base = esploraBase.replace(/\/$/, '');
  const out: TrezorRefTransaction[] = [];
  for (const id of refTxIds) {
    const url = `${base}/tx/${encodeURIComponent(id)}/hex`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      throw new Error(`Failed to fetch ref tx ${id}: HTTP ${res.status}`);
    }
    const rawHex = (await res.text()).trim();
    out.push(decodeRawTxToRefTransaction(rawHex));
  }
  return out;
}

// ─── helpers ─────────────────────────────────────────────────────────────────────

/** hex-encode a Uint8Array (lowercase, no 0x). */
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** hex-encode bytes after reversing them (little-endian -> big-endian display order). */
function bytesToHexBe(bytes: Uint8Array): string {
  const reversed = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) reversed[i] = bytes[bytes.length - 1 - i]!;
  return bytesToHex(reversed);
}

/**
 * decode an output script back to a base58check / bech32 address string. returns null
 * when the script can't be reversed to an address (e.g. OP_RETURN, custom scripts).
 *
 * defensive: bitcoinjs `address.fromOutputScript` throws on non-standard scripts, we
 * catch and return null so the caller can decide whether to error or accept it as a
 * non-addressable output.
 */
function tryDecodeOutputAddress(scriptBytes: Uint8Array, network: typeof networks.bitcoin): string | null {
  try {
    // dynamic import via require is awkward in browser, chromatika builds with bitcoinjs-lib
    // bundled, so we can use a synchronous decoder via `address.fromOutputScript`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { address } = require('bitcoinjs-lib');
    return address.fromOutputScript(Buffer.from(scriptBytes), network);
  } catch {
    return null;
  }
}

export const __test__ = {
  detectInputScriptType,
  detectOutputScriptType,
  bytesToHex,
  bytesToHexBe,
};
