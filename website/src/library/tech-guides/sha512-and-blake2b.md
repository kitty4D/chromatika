# SHA-512 and BLAKE2b in chromatika

two hash functions that show up specifically around Sui personal-message signing - the place where ika's signing scheme and Mysten's native intent format diverge. understanding the gap matters because it's the reason some Sui dapps may not verify chromatika's `sui_signPersonalMessage` output.

## SHA-512 (used by ika ed25519 signing)

ika's ed25519 EdDSA implementation uses SHA-512 as its hash function in two places per RFC 8032:
1. expanding the secret seed into the secret scalar + nonce prefix
2. hashing `(R || A || M)` to produce the challenge scalar `k`

this is **standard ed25519** - the function that signs is `EdDSA(secret, message)` where the implementation hashes the message internally with SHA-512.

when chromatika's `sui_signPersonalMessage` runs, it hands ika the **raw user-supplied message bytes** (the actual UTF-8 of "I agree to the terms" or whatever). ika hashes those with SHA-512 as part of standard ed25519 signing, produces a 64-byte ed25519 signature, returns it.

## BLAKE2b (used by Mysten's PersonalMessage intent)

Mysten's wallet-side native primitive `signPersonalMessage` does **not** sign raw bytes. it wraps them in a Sui *intent*:

```
intent_message = [0x03, 0x00, 0x00] || bcs(PersonalMessage { message: bytes })
digest = blake2b_256(intent_message)
signature = ed25519_sign(digest, key)
```

the leading `[0x03, 0x00, 0x00]` is the intent prefix: scope=PersonalMessage, version=V0, app=Sui. the digest is **BLAKE2b-256** (32-byte output, the hash function bitcoin / monero / sui / aptos use widely; not the same as SHA-2 family). the signature is then over the BLAKE2b digest, not over the original bytes.

## the divergence

dapps that verify with `verifyPersonalMessageSignature` from `@mysten/sui` compute the **BLAKE2b-of-intent** digest first and then verify the ed25519 signature against that digest. when chromatika hands them an ika-produced sig (which is over `SHA512-of-raw-bytes` per standard ed25519), the verification fails - same key, same logical message, different digest input.

this is **intentional today** because ika's signing path doesn't yet produce intent-wrapped digests on its server side, and chromatika cannot post-hoc wrap a finished signature. dapps that verify with `tweetnacl-style` raw ed25519 (sign over the literal bytes) accept the signature; dapps that strictly use Mysten's intent flow do not.

tracked future: add a parallel "Mysten BLAKE2b path" that wraps the message in the intent client-side, hashes BLAKE2b-256, and asks ika to ed25519-sign the digest as if it were the message. when that lands, both paths exist; the user picks (or chromatika dispatches based on dapp metadata).

## SHA-512 elsewhere

SHA-512 also surfaces in:
- BIP39 → BIP39-seed: PBKDF2-HMAC-SHA512 with 2048 iterations against the password "mnemonic" || passphrase. produces the 64-byte BIP39 seed that BIP44 and SLIP10 derive from
- HMAC-SHA512 inside BIP32 (master key + chain-code derivation)
- HMAC-SHA512 inside SLIP10 ed25519 derivation

## BLAKE2b elsewhere

- Sui address derivation (32-byte address = `blake2b_256(scheme_flag || pubkey)`)
- passkey-vault Sui address derivation: `blake2b_256(0x06 || compressed_secp256r1_pubkey)` per SIP-9 (flag `0x06` distinguishes passkey from plain secp256r1)
- Sui object id derivation, transaction digesting (out of scope for chromatika - we don't compute these, the Sui client / GraphQL does)

## libraries

- SHA-512: `@noble/hashes/sha2` (`sha512`); used inside `@noble/ed25519` so we rarely call it directly
- BLAKE2b-256: `@noble/hashes/blake2b` (`blake2b256`); used in the address derivation helpers in `keyring/passkey-derive.ts` and the Sui SDK internally

## quick lookup

| where | hash | input | output | who calls it |
|-------|------|-------|--------|--------------|
| ika ed25519 sign | SHA-512 | raw msg bytes | 64-byte sig | ika MPC server |
| Sui native PersonalMessage | BLAKE2b-256 | intent || bcs(msg) | 32-byte digest, then ed25519 sign | dapps using `@mysten/sui` |
| Sui address | BLAKE2b-256 | scheme_flag || pubkey | 32-byte address | chromatika + Sui SDK |
| Passkey Sui addr | BLAKE2b-256 | 0x06 || pk_compressed | 32-byte address | chromatika passkey-derive |
| BIP39 seed | PBKDF2-HMAC-SHA512 | mnemonic + "mnemonic" || passphrase | 64-byte seed | `@scure/bip39` |
| BIP32 / SLIP10 master | HMAC-SHA512 | seed | 64 bytes (key + chain) | `@scure/bip32` / SLIP10 helper |
