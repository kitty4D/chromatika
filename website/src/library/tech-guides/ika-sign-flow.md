# ika sign flow

producing a signature with an active dWallet. combines a precomputed presign with the message + user share to produce a canonical ECDSA / EdDSA / Taproot signature. the user share never leaves chromatika; the network share never leaves the ika network. neither party alone can produce the signature.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet is in `active` state for the curve you're signing on (DKG completed + accept-share completed)
- the matching presign pool has at least one entry (auto-refill keeps this topped up; see [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl))
- on Solana base: in-extension fee-payer has SOL for `approve_message` gRPC fees

## the call

per chain / message kind:

- `signEvm({ message, chainId })` - SECP256K1_ECDSA path with EIP-191 wrapping
- `signBtc({ messageHex })` - SECP256K1_ECDSA or SECP256K1_TAPROOT depending on address kind
- `signSol({ messageB64 })` - ED25519_EDDSA path
- `signAptos({ messageB64 })` - ED25519_EDDSA path
- internally for sends: `signAndBroadcastEvm({ to, value, data, chainId })` etc.

each maps to ika's underlying `requestSign` with the right curve / algorithm.

## the flow (Sui base, ECDSA example for EVM)

```
1. takePresign(SECP256K1_ECDSA) → presignId
   - pops one entry from the pool

2. assemble the message preimage
   for personal_sign: msg = "\x19Ethereum Signed Message:\n" + len(message) + message
   for typed_data_v4: msg = TypedDataEncoder.encode(domain, types, value)
   for tx send: msg = tx.unsignedSerialized
   // PASS PREIMAGE, not digest. ika hashes once with KECCAK256 internally.

3. build the sign PTB
   tx = new IkaTransaction()
   tx.requestSign({
     dwalletId,
     curve: Curve.SECP256K1,
     algorithm: SignatureAlgorithm.ECDSASecp256k1,
     message: msg,
     presignId,
     userPartialSignature,   // produced locally with USK
   })
   // requestSign returns void - no value to capture

4. simulate, submit, wait for sign output event

5. read the signature from the completion event
   // event.signature_bytes = 64-byte compact r||s for ECDSA

6. normalize via ika SDK helper
   { r, s } = parseSignatureFromSignOutput(
     event.signature_bytes,
     Curve.SECP256K1,
     SignatureAlgorithm.ECDSASecp256k1
   )
   // assert 64-byte total

7. compute v
   digest = keccak256(msg)
   for v_candidate in [27, 28]:
     recovered = recoverAddress(digest, { r, s, v: v_candidate })
     if recovered === knownEvmAddress:
       v = v_candidate
       break

8. assemble final EVM signature: r || s || v   (or r || s || (v + 35 + chainId*2) for EIP-155 tx)
```

## the flow (Solana base, ED25519 example)

```
1. takePresign(ED25519_EDDSA) → presignId
2. message = msg_bytes   // raw, not hashed - ika SHA-512s internally per RFC 8032
3. send sign request via gRPC
   await ikaClient.requestSign({
     dwalletId,
     curve: Curve.ED25519,
     algorithm: SignatureAlgorithm.EdDSA,
     message,
     presignId,
     userPartialSignature,
     dwalletAttestationBytes,   // for Solana
     approveMessage,            // signed by in-extension fee-payer
   })
4. await completion (gRPC stream)
5. read signature_bytes (64 bytes for ed25519)
6. parseSignatureFromSignOutput(sig, Curve.ED25519, SignatureAlgorithm.EdDSA) → (R, S)
7. signature is just R || S (64 bytes), no v needed
```

## preimage passthrough rule

a recurring rule across all signing paths:

> **hand ika the preimage bytes. ika hashes internally. never pre-hash.**

| sign type         | preimage you pass                                    | what ika hashes                                  |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------ |
| EVM personal_sign | `"\x19Ethereum Signed Message:\n" + len + msg`       | keccak256(preimage)                              |
| EVM typed_data_v4 | `TypedDataEncoder.encode(...)`                       | keccak256(preimage)                              |
| EVM tx send       | `tx.unsignedSerialized`                              | keccak256(preimage)                              |
| Sui personal      | raw msg bytes                                        | sha-512(preimage) per RFC 8032                   |
| Solana sign-msg   | raw msg bytes                                        | sha-512(preimage) per RFC 8032                   |
| BTC P2WPKH        | raw msg bytes (or BIP143 sighash, depending on path) | keccak256 (then chained?)                        |
| BTC P2TR          | BIP341 sighash                                       | tagged_hash("BIP0340/challenge", ...) per BIP340 |

if you double-hash (pass already-hashed bytes), ika hashes the digest itself, the resulting signature is over the wrong digest, and verification fails (or recovers a different address).

## signature normalization helpers

`parseSignatureFromSignOutput(sigBytes, curve, sigAlgorithm)` is the canonical helper. enforces:

- ECDSA: 64 bytes, returns (r, s) each 32 bytes; rejects non-64-byte input
- EdDSA: 64 bytes, returns (R, S)
- Taproot: 64 or 65 bytes (with optional sighash byte), returns (R, S) plus optional sighash flag

## v recovery for ECDSA-EVM

ika's ECDSA output is the bare 64-byte r||s. EVM verifiers want a 65-byte r||s||v signature with `v ∈ {27, 28}` (or `v ∈ {35 + chainId*2 + 0, 35 + chainId*2 + 1}` for EIP-155 transactions). chromatika picks `v` by trying both candidates against `recoverAddress(keccak256(preimage), { r, s, v })` and matching to the dWallet's known EVM address.

if neither v matches, something is wrong: either the preimage was hashed twice, or the dWallet pubkey doesn't match the signature, or the network produced a bad signature. all three are bugs.

## the EVM dapp-tx vs wallet-ui-tx split

- `eth_sendTransaction` from a dapp → `enqueueTxApproval` → approval popup → on approve, `signAndBroadcastEvm`
- wallet-ui `sendEvmTx` (tRPC from side panel) → `signAndBroadcastEvm` directly, no popup

both end up at `signAndBroadcastEvm`, which calls the ika sign flow above and then broadcasts via the EVM provider. **never add an approval gate to the wallet-ui flow** - the user is already in the wallet UI making an intentional action.

## what doesn't work

- signing on a locked wallet: tRPC fails with "wallet locked"
- signing on a dWallet not in `active` state: rejects with state error
- signing with no presigns available + can't refill (insufficient funds): pool-empty error, user must fund + refill
- signing with the wrong curve / algorithm combo (e.g. asking for Taproot on an ED25519 dWallet): rejects
- on Solana base today: signing produces a single-mock-signer output, not real distributed MPC. the signature is technically valid against the published dWallet pubkey but the trust model is **not** what production MPC will be

## library

- `@ika.xyz/sdk` `IkaTransaction.requestSign`, `parseSignatureFromSignOutput`
- `@ika.xyz/pre-alpha-solana-client` for Solana base sign over gRPC
- ethers v6 `recoverAddress`, `keccak256` for v-recovery
- internal: `wallet-extension/src/background/ika/signing.ts` orchestration
- internal: `wallet-extension/src/background/ika/presign-pool.ts` for `takePresign`
- internal: `wallet-extension/src/background/chains/signing/*` for per-chain message wrapping
