# BTC taproot Schnorr (BIP340) in chromatika

BIP340 Schnorr signatures over secp256k1 are what bitcoin taproot (P2TR) outputs use. chromatika supports P2TR sends from the active SECP256K1 dWallet by routing through the **SECP256K1_TAPROOT** ika presign pool (separate from `SECP256K1_ECDSA`).

## why a separate pool

ECDSA and Schnorr produce different signature shapes from the same secp256k1 key:
- ECDSA: `(r, s)` where `r` is x-coordinate of `k*G mod n`, `s = k^(-1)(z + r*d) mod n`
- Schnorr (BIP340): `(R, s)` where `R = k*G` is a 32-byte x-only point, `s = k + e*d mod n`, `e = tagged_hash("BIP0340/challenge", R || P || m)`

ika MPC has different presign material per algorithm because the math during the presign phase differs - SECP256K1_TAPROOT presigns commit to the x-only `R` form Schnorr expects, while SECP256K1_ECDSA presigns work for the `(r, s)` form ECDSA expects.

## tagged hash

BIP340 introduced "tagged hashes" to give domain separation:
```
tagged_hash(tag, x) = SHA-256(SHA-256(tag) || SHA-256(tag) || x)
```

specific tags used in taproot:
- `"BIP0340/challenge"` for `e` in signing
- `"BIP0340/aux"` for the auxiliary RNG input
- `"TapLeaf"`, `"TapBranch"`, `"TapTweak"` for the script tree commitment / output-key tweak

ika handles the BIP340 challenge hash internally during taproot signing. chromatika hands it the BIP341 sighash (the bytes that the BIP340 challenge hashes over).

## BIP341 sighash

BIP341 defines the message format that taproot signs over:
```
sighash = tagged_hash("TapSighash", 0x00 || sighash_data)
sighash_data = (
  hash_type ||
  nVersion ||
  nLockTime ||
  sha256(amounts) ||  // sum of input amounts
  sha256(scriptPubKeys) ||  // input scripts
  sha256(sequences) ||
  sha256(outputs) ||
  spend_type ||
  input_index ||
  ...
)
```

bitcoinjs-lib computes this via `tx.hashForWitnessV1(...)` per input. chromatika builds the tx, computes one sighash per P2TR input, hands each to ika via SECP256K1_TAPROOT, and assembles the final witness.

## key tweaking (BIP341 output key)

a P2TR output key is **tweaked** from the internal key:
```
P_internal = derive_secp256k1_pubkey(secret)
t = tagged_hash("TapTweak", P_internal_x_only || merkle_root_of_script_tree)
P_output = P_internal + t * G
```

if there are no scripts (key-path-only), `merkle_root_of_script_tree` is empty and `t` is just `tagged_hash("TapTweak", P_internal_x_only)`.

chromatika derives the P2TR address by computing the tweaked output key and bech32m-encoding it (`bc1p…` mainnet, `tb1p…` testnet). signing uses the **tweaked secret** so the signature verifies against the tweaked output key.

## key path vs script path

chromatika today only does **key-path spending** - the simpler taproot mode where the user signs with their tweaked key directly, no merkle proof, no tapscript. script-path spends (locktime, multisig, miniscript) are out of scope. if you want to spend from a P2TR output that requires script-path, chromatika can't do it today.

## the chromatika BTC signing pipeline (P2TR)

```
1. build the BTC transaction via bitcoinjs-lib with a P2TR input
2. for each P2TR input, compute BIP341 sighash via tx.hashForWitnessV1(input_index, ...)
3. hand the sighash to ika as a SECP256K1_TAPROOT sign request
4. ika returns a 64-byte BIP340 Schnorr signature (R(32) || s(32))
5. write the signature into the input's witness:
   witness = [signature_64_bytes]   // key-path-only, no script
6. broadcast via the configured Esplora endpoint
```

if `hash_type` is non-default (e.g. SIGHASH_ALL with anyonecanpay), the sighash includes a 65-byte signature (`r || s || hashType`); for SIGHASH_DEFAULT (0x00) it's 64 bytes.

## the SECP256K1_TAPROOT presign pool

per CLAUDE.md, chromatika maintains three ika presign pools per active dWallet Vault:
- `SECP256K1_ECDSA` (EVM, generic ECDSA)
- `SECP256K1_TAPROOT` (BTC P2TR)
- `ED25519_EDDSA` (Sui, Solana, Aptos)

each pool stores presign material specific to the algorithm. the 5-min auto-refill alarm and manual `replenishPresign` ops apply per-pool.

## library

- `bitcoinjs-lib` for tx building, BIP341 sighash, P2TR address derivation, witness assembly
- `@noble/secp256k1` (or `@noble/curves`) for curve math (x-only point operations)
- ika MPC for the actual Schnorr signature production via the SECP256K1_TAPROOT presign pool

## P2TR address format

```
output_pubkey_x_only = (P_internal + t*G).x   // 32 bytes
witness_program = 0x51 0x20 || output_pubkey_x_only   // OP_1 PUSH32 <pubkey>
address = bech32m_encode(hrp="bc" or "tb", witness_version=1, output_pubkey_x_only)
```

bech32m is the post-BIP350 encoding (replaces bech32 for witness version >= 1 to fix a checksum vulnerability that affected the original bech32 with non-zero witness versions).

## what chromatika doesn't do for taproot

- script-path spends (no tapscript)
- multisig P2TR (no MuSig2 / FROST aggregation)
- inscriptions / ordinals (display only, no minting / transferring inscription content)
- silent payments (BIP352)
