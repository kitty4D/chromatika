# Sui `signPersonalMessage` ika SHA-512 vs Mysten BLAKE2b divergence

`sui_signPersonalMessage` is where chromatika's ika signing path diverges from Mysten's native `signPersonalMessage`. the result: dapps that verify with `verifyPersonalMessageSignature` from `@mysten/sui` may **reject** chromatika's signatures even though the underlying ed25519 key is the same. this is a known gap; the fix is to add a parallel BLAKE2b-intent path.

## what Mysten does

Mysten's `signPersonalMessage`:

```
intent = [0x03, 0x00, 0x00]    // [PersonalMessage, V0, Sui]
intent_message = intent || bcs(PersonalMessage { message: bytes })
digest = blake2b_256(intent_message)
signature = ed25519_sign(digest, key)   // ed25519 sha-512s digest internally
```

dapp verification:

```
intent_message = intent || bcs(PersonalMessage { message: bytes })
expected_digest = blake2b_256(intent_message)
ed25519_verify(expected_digest, signature, pubkey)
```

the digest is BLAKE2b-256 of the intent-wrapped, BCS-encoded message. the signature is over that digest.

## what chromatika ika does today

`sui_signPersonalMessage` in chromatika hands ika the **raw user message bytes**:

```
signature = ed25519_sign(raw_message_bytes, key)   // ika sha-512s message internally
```

ika produces an ed25519 signature where the message is the **raw bytes** the user supplied. ika's protocol path doesn't yet support a "wrap in intent + BLAKE2b first" client-side preprocessing step.

## the verify mismatch

when a dapp tries to verify chromatika's signature with Mysten's helper:

```
expected_digest = blake2b_256(intent || bcs(PersonalMessage(raw)))
ed25519_verify(expected_digest, sig, pubkey)
// FAILS - sig was over sha512(raw), not sha512(blake2b(intent || bcs(raw)))
```

verification fails. the dapp sees "invalid signature" even though the key matches. user is stuck.

## what works today

dapps that verify the **raw bytes** (skip the intent wrapping) accept chromatika's signature. this includes some custom dapp logic, dev tooling, raw `tweetnacl.sign.detached.verify` calls, and anything that doesn't go through Mysten's `verifyPersonalMessageSignature`.

it's a coin flip per dapp. modern Sui dapps using the canonical Mysten verify will reject; older / custom code may accept.

## why ika is structured this way

ika's MPC protocol is curve+algorithm-driven. `(curve = ED25519, algorithm = EdDSA)` produces a standard RFC 8032 ed25519 signature where the implementation hashes with SHA-512. there's no parameter for "but first BLAKE2b the input on the client side before handing to MPC."

the fix is for chromatika to do the wrapping client-side and hand ika the **digest** (32-byte BLAKE2b output) instead of the raw message:

```
1. wrap: intent_message = [0x03, 0x00, 0x00] || bcs(PersonalMessage { message: raw })
2. digest = blake2b_256(intent_message)
3. ika.sign(message: digest, curve: ED25519, algorithm: EdDSA)
   - ika sha-512s the digest internally
   - signature is over sha512(digest)
4. verifier:
   - recomputes digest = blake2b_256(intent_message)
   - ed25519_verify(digest, signature, pubkey)
   - internal: ed25519_verify sha-512s the digest, matches what ika signed
```

so the **fix is doable client-side**: build the BLAKE2b-of-intent digest in chromatika, hand ika the 32-byte digest as the "message". ika sha-512s the digest, verifiers compute the same BLAKE2b digest and ed25519_verify also sha-512s it. same byte input to sha-512 → same signature.

## why we haven't shipped the fix yet

it's straightforward to implement but requires:

1. add a `wrapWithSuiPersonalMessageIntent` helper that BCS-encodes + prefixes
2. compute the BLAKE2b digest
3. hand the digest to ika instead of raw bytes
4. test against Mysten's verifier to confirm interop

the gap is tracked as **future hardening** in [WALLET_SECURITY.md](/library/tech/wallet_security). when it lands, the existing path stays available for back-compat with dapps that verify raw bytes; new path is opt-in or auto-detected per dapp.

## the related Sui transaction-data signing case

interestingly, Sui transaction signing **already** uses the BLAKE2b-of-intent path (see [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika)). there:

- chromatika BCS-serializes the TransactionData
- wraps with `[0x00, 0x00, 0x00]` intent
- BLAKE2b-256s the intent message
- hands ika the digest
- ika sha-512s the digest, signs

verifiers (Sui validators) recompute BLAKE2b of intent, ed25519_verify with sha-512 of digest. matches.

so the **mechanism is already proven** for transaction-data; we just need to extend it to PersonalMessage.

## what to tell users today

documented in [WALLET_SECURITY.md](/library/tech/wallet_security):

> Sui `signPersonalMessage` uses ika SHA-512 path, NOT Mysten's BLAKE2b PersonalMessage intent. some dapps may not verify until aligned. tracked future.

dapp-side workaround: use raw-message verification (e.g. `tweetnacl.sign.detached.verify(raw_message_bytes, signature, pubkey)`) instead of `verifyPersonalMessageSignature`.

chromatika-side fix: implement BLAKE2b-intent wrapping client-side, hand ika the digest. tracked future.

## library

- `@mysten/sui` `verifyPersonalMessageSignature` (the dapp side)
- `@noble/hashes/blake2b` `blake2b256` (when chromatika implements the fix)
- internal: `wallet-extension/src/background/chains/signing/sui.ts` for the current path

## related

- [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika) - the working BLAKE2b-of-intent flow for tx data
- [sha512-and-blake2b.md](/library/tech/sha512-and-blake2b) - the underlying hash function comparison
- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - the ed25519 path that does sha-512 internally
- [WALLET_SECURITY.md](/library/tech/wallet_security) - the user-facing disclaimer
