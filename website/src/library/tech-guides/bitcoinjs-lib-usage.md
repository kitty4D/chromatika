# `bitcoinjs-lib` usage in chromatika

`bitcoinjs-lib` is chromatika's Bitcoin tx-building, sighash-computing, address-encoding library. used for P2WPKH segwit sends, P2TR taproot sends, BIP143 / BIP341 sighash computation, witness assembly, and address derivation. version pinned at ^7.0.1.

## what we use it for

| feature | bitcoinjs-lib API |
|---------|-------------------|
| build segwit tx | `Psbt`, `Psbt.addInput`, `addOutput` |
| compute BIP143 sighash | `Transaction.hashForWitnessV0(...)` |
| compute BIP341 sighash | `Transaction.hashForWitnessV1(...)` |
| derive P2WPKH address | `payments.p2wpkh({ pubkey, network })` |
| derive P2TR address | `payments.p2tr({ internalPubkey, network })` |
| encode DER ECDSA sig | `script.signature.encode(...)` |
| finalize PSBT input | `Psbt.finalizeInput(...)` |

## bech32 / bech32m address derivation

```ts
import * as bitcoin from 'bitcoinjs-lib';

// P2WPKH (segwit) - bech32
const p2wpkh = bitcoin.payments.p2wpkh({
  pubkey: dwalletSecpPubkey,                                // 33-byte compressed
  network: bitcoin.networks.bitcoin,                         // mainnet
});
// p2wpkh.address = "bc1q..."

// P2TR (taproot) - bech32m
const p2tr = bitcoin.payments.p2tr({
  internalPubkey: dwalletSecpPubkey.slice(1),                // 32-byte x-only (drop 0x02/0x03 prefix)
  network: bitcoin.networks.bitcoin,
});
// p2tr.address = "bc1p..."
```

bech32 = BIP173 (segwit v0). bech32m = BIP350 (segwit v1+, taproot). different checksum constants prevent address-format confusion.

## tx building (segwit P2WPKH)

```ts
const psbt = new bitcoin.Psbt({ network: bitcoin.networks.bitcoin });

// add input
psbt.addInput({
  hash: prevTxId,                                             // 32-byte tx id
  index: prevVout,
  witnessUtxo: {
    script: bitcoin.address.toOutputScript(senderAddress, network),
    value: prevAmountSats,                                    // input value in sats
  },
});

// add output
psbt.addOutput({
  address: recipientAddress,
  value: amountSats,
});

// add change output if needed
psbt.addOutput({
  address: senderAddress,
  value: changeSats,
});

// compute sighash for input 0
const sighash = psbt.__CACHE.__TX.hashForWitnessV0(
  0,                                                          // input index
  bitcoin.payments.p2wpkh({ pubkey: senderPubkey }).output,
  prevAmountSats,
  bitcoin.Transaction.SIGHASH_ALL,
);
```

`hashForWitnessV0` is the BIP143 sighash. signing this digest with secp256k1 ECDSA produces the witness signature.

## the ika MPC handoff

chromatika doesn't sign locally - hands sighash to ika MPC:

```ts
const presignId = takePresign('SECP256K1_ECDSA');
const sigBytes = await ikaSign({
  dwalletId: activeSecpDwalletId,
  curve: Curve.SECP256K1,
  algorithm: SignatureAlgorithm.ECDSASecp256k1,
  message: sighash,                                           // already-hashed digest
  presignId,
});
const { r, s } = parseSignatureFromSignOutput(sigBytes, ...);

// DER-encode for bitcoin
const derSig = bitcoin.script.signature.encode(
  Buffer.concat([r, s]),
  bitcoin.Transaction.SIGHASH_ALL,
);

// write into PSBT
psbt.data.inputs[0].partialSig = [{
  pubkey: senderPubkey,
  signature: derSig,
}];

psbt.finalizeInput(0);
const txHex = psbt.extractTransaction().toHex();
```

## the BIP341 taproot sighash

```ts
const sighash = psbt.__CACHE.__TX.hashForWitnessV1(
  0,
  prevoutScripts,                                             // ALL input scripts (not just current)
  prevoutAmounts,                                             // ALL input amounts
  bitcoin.Transaction.SIGHASH_DEFAULT,                        // 0x00 (default for taproot)
);
```

different from V0 (BIP143):
- takes **all** input scripts + amounts, not just the current input's
- uses tagged hash with `"TapSighash"` tag
- supports `SIGHASH_DEFAULT` (0x00) which is implicit and produces 64-byte signatures (no trailing sighash byte)

after signing via ika SECP256K1_TAPROOT pool, write the 64-byte signature directly into `psbt.data.inputs[i].tapKeySig`.

## broadcast

```ts
const txHex = psbt.extractTransaction().toHex();
const resp = await fetch(`${esploraUrl}/tx`, {
  method: 'POST',
  headers: { 'Content-Type': 'text/plain' },
  body: txHex,
});
const txid = await resp.text();
```

chromatika uses Esplora-compatible APIs (mempool.space, blockstream.info) for broadcasting + UTXO queries. configurable per-network in `chromatika_active_networks_v1`.

## the buffer dependency

bitcoinjs-lib uses Node `Buffer` extensively. chromatika's `buffer-polyfill.ts` (see [buffer-polyfill.md](/library/tech/buffer-polyfill)) shims it.

## library

- `bitcoinjs-lib` ^7.0.1
- `varuint-bitcoin` ^2.0.0 (transitive, varint encoding)
- `uint8array-tools` ^0.0.9 (transitive)
- internal: `wallet-extension/src/background/chains/bitcoin.ts` for build / send orchestration
- internal: `wallet-extension/src/background/chains/signing/btc.ts` for sighash + ika handoff

## related

- [secp256k1-ecdsa.md](/library/tech/secp256k1-ecdsa), [taproot-schnorr.md](/library/tech/taproot-schnorr) - the underlying signature math
- [btc-tx-sign-segwit-taproot.md](/library/tech/btc-tx-sign-segwit-taproot) - the full signing flow
- [buffer-polyfill.md](/library/tech/buffer-polyfill) - the Node Buffer shim
