# secp256k1 ECDSA in chromatika

secp256k1 is the elliptic curve that bitcoin and ethereum sign on. ECDSA is the signature scheme. chromatika uses ECDSA-secp256k1 for **all EVM signing** (transactions, `personal_sign`, EIP-712 typed data) and for **Bitcoin segwit P2WPKH** sends. the actual signing happens via ika MPC (2PC-MPC SECP256K1 ECDSA), not locally.

## the curve

- secp256k1 order: `n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141`
- generator: standard secp256k1 generator G
- public key: 32-byte x + 32-byte y (uncompressed = 65 bytes with 0x04 prefix; compressed = 33 bytes with 0x02 / 0x03 prefix indicating y parity)
- secret key: 32-byte scalar in `[1, n-1]`

## signature shape

a raw ECDSA signature is `(r, s)` where each is a 32-byte scalar mod `n`. ika returns these as a 64-byte compact `r || s`. EVM additionally wants a recovery byte `v` so verifiers can recover the public key from the signature - chromatika picks `v` after the fact.

## the chromatika EVM signing pipeline

```
1. build the unsigned transaction via ethers
   tx_unsigned = Transaction.from({ to, value, data, chainId, nonce, gas... })
2. compute the preimage bytes
   preimage = tx_unsigned.unsignedSerialized
3. hand ika the PREIMAGE (not the digest!)
   sig_64bytes = await ika.sign(preimage, dwallet, SECP256K1, ECDSASecp256k1)
4. ika hashes preimage with KECCAK256 once internally and signs
5. parse the response with parseSignatureFromSignOutput(Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1)
   → asserts 64-byte compact r||s
6. compute digest yourself: digest = keccak256(preimage)
7. try both v values:
   addr_27 = recoverAddress(digest, { r, s, v: 27 })
   addr_28 = recoverAddress(digest, { r, s, v: 28 })
   pick the v whose recovered addr matches the dWallet's known EVM address
8. assemble final 65-byte sig: r || s || (v + chainId * 2 + 35)  // EIP-155 v adjustment for tx
   or: r || s || v  // for personal_sign (no chain mixing)
```

step 3 is **the rule**: pass preimage, not hash. ika internally does `digest = keccak256(preimage)` and signs `(r, s)` over `digest`. if you pass the digest already-keccaked, ika hashes the digest again, signs the wrong thing, and the recovered address won't match.

step 7 is the v-recovery dance. ECDSA's recovery byte distinguishes between the two possible public-key candidates that satisfy `r`. EVM's convention is `v ∈ {27, 28}` (or the EIP-155 chain-mixed equivalent for transactions); we pick whichever recovers to our known address.

## `personal_sign` vs typed-data v4

`personal_sign` per EIP-191:

```
preimage_msg = "\x19Ethereum Signed Message:\n" + len(message) + message
preimage_to_sign = preimage_msg
sig = ecdsa_sign(keccak256(preimage_msg), key)
```

chromatika builds `preimage_msg` (the EIP-191 wrapped form), hands it to ika as the preimage, ika keccak256s + signs.

typed-data v4 per EIP-712:

```
preimage_typed = TypedDataEncoder.encode(domain, types, value)
                 = 0x1901 || domainSeparator || hashStruct(message)
sig = ecdsa_sign(keccak256(preimage_typed), key)
```

`TypedDataEncoder.encode(...)` from ethers v6 returns the encoded preimage - the bytes that should be keccak256'd to get the EIP-712 digest. chromatika hands ika **`encode(...)`**, not `hash(...)`. ika keccak256s + signs.

if you ever see code that calls `TypedDataEncoder.hash(...)` and passes the result to ika, that's a double-hash bug.

## bitcoin secp256k1 signing

P2WPKH signing uses ECDSA-secp256k1 against the segwit transaction sighash (BIP143). chromatika builds the transaction with bitcoinjs-lib, computes the BIP143 sighash (a `SHA256(SHA256(...))` double-hash over the witness preimage), and hands that **digest** to ika.

wait - if EVM passes preimage and bitcoin passes digest, what's the rule?

the rule is: ika hashes its input **once with KECCAK256** before signing for SECP256K1_ECDSA. so:

- for EVM, the natural digest is keccak256(preimage) → pass preimage, let ika hash
- for Bitcoin BIP143 sighash, the natural digest is `SHA256(SHA256(preimage))` (NOT keccak256) → there's no way to pre-keccak the input to land on the right sha256 digest, so chromatika passes the **already-double-sha256'd** digest as the "preimage" (which ika will then keccak256 a third time) - or more practically, chromatika uses the SECP256K1_ECDSA path for EVM only and SECP256K1_TAPROOT for Bitcoin where the hash function differs (see [taproot-schnorr.md](/library/tech/taproot-schnorr)).

actually, for Bitcoin P2WPKH chromatika still uses SECP256K1_ECDSA but with a wrapper that handles the SHA-256 sighash differently - check `wallet-extension/src/background/chains/signing/btc.ts` for the exact path. don't infer from this doc; the BTC signing helper has the canonical implementation.

## library

- `@noble/secp256k1` for the curve math + signature verification
- ethers v6 `Transaction`, `TypedDataEncoder`, `recoverAddress`, `SigningKey.recoverPublicKey` for EVM tx + sig handling
- `bitcoinjs-lib` for BIP143 sighash, transaction serialization, address encoding
- `@ika.xyz/sdk` `parseSignatureFromSignOutput` for normalizing ika output into `(r, s)`

## the v=0/1 vs 27/28 convention

different sources serialize `v` differently:

- raw ECDSA recovery: `v ∈ {0, 1}` (which y candidate)
- ethereum classic / EIP-155 transactions: `v = 35 + chainId * 2 + (0 or 1)`
- ethereum personal sign: `v ∈ {27, 28}` (the historical bitcoin-message-signing offset)

chromatika handles all three. ethers does most of the conversion; you only see raw `{0, 1}` if you're unwrapping ika output by hand.
