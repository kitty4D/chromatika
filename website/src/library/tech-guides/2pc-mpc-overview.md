# 2PC-MPC overview (ika protocol)

ika dWallets are 2-Party Computation MPC threshold wallets. the secret signing key is **never assembled**. instead, two parties (the user via chromatika, and the ika network) each hold a share, and they collaboratively produce signatures without ever materializing the full key. this doc gives the high-level picture; the protocol-step docs (DKG, accept-share, presign, sign, re-encrypt) cover specifics.

## the protocol family

ika implements a 2-party version of threshold ECDSA (for SECP256K1) and threshold EdDSA (for ED25519). the math comes from a body of MPC research; the exact references and security proofs live in the ika protocol papers / docs (see [ika cryptography.mdx](https://github.com/dwallet-labs/ika/blob/main/docs/content/docs/sdk/cryptography.mdx) for the canonical write-up).

key properties:
- **2 parties**: chromatika holds one share (the "user share"), ika network holds the other (the "network share")
- **threshold = 2 of 2**: both parties must cooperate to produce a signature. neither alone can sign
- **non-interactive use**: presign material is precomputed; the actual signing round is fast and online
- **signature is canonical**: the output looks identical to a centrally-produced ECDSA / EdDSA signature - verifiers can't distinguish 2PC-MPC sigs from regular ones

## the user-share encryption keys (USK)

chromatika's local share is wrapped in a `UserShareEncryptionKeys` object - the per-vault, per-curve key material that lets the user participate in the MPC protocol. derived from a 32-byte root seed (see [ika-seed-derivation-overview.md](/library/tech/ika-seed-derivation-overview)).

both curves (SECP256K1 + ED25519) get a USK from the same root seed - so one ika identity drives EVM (SECP256K1 ECDSA), Bitcoin (SECP256K1 ECDSA + Taproot Schnorr), Sui (ED25519 EdDSA), Solana (ED25519 EdDSA), and Aptos (ED25519 EdDSA).

## what's stored on-chain (Sui base)

each dWallet has on-chain state on Sui (when ika is anchored to Sui base):
- a `DWallet` object with the dWallet id, the current public key, owner cap, state machine state
- presign objects (precomputed signature material, one per future signature)
- encrypted user share objects (the user's share, encrypted to their encryption key, used for share transfer)

## what's stored on-chain (Solana base, pre-alpha)

Solana ika base is pre-alpha. the dWallet state lives in Solana program accounts:
- a dWallet account (analog to the Sui object)
- attestation bytes (`dwalletAttestationBytesB64` persisted in chromatika's `record.dwalletMeta`)
- presign accounts

**critical pre-alpha caveat**: all Solana ika signatures come from a **single mock signer** today, not real distributed MPC. the dWallet keys, trust model, and signing protocol are not final. the Solana program and all on-chain data will be wiped periodically and **everything will be deleted** when ika transitions to Alpha 1.

## the lifecycle

every dWallet goes through:

1. **DKG (distributed key generation)** - both parties run the keygen protocol, produce their shares, the network publishes the dWallet object. see [ika-dkg-flow.md](/library/tech/ika-dkg-flow)
2. **zero-trust accept-share** - the user's share is encrypted to their encryption key on-chain, the user calls `acceptEncryptedUserShare` to take ownership. see [ika-accept-share-zerotrust.md](/library/tech/ika-accept-share-zerotrust)
3. **presign** - the user + network precompute signature material into the per-vault presign pool. see [ika-presign-pool-impl.md](/library/tech/ika-presign-pool-impl)
4. **sign** - on demand, the user + network combine a presign with the message to produce a signature. see [ika-sign-flow.md](/library/tech/ika-sign-flow)
5. **re-encrypt (transfer)** - the user can re-encrypt their share to a new owner's encryption key, transferring the dWallet. see [ika-re-encrypt-transfer.md](/library/tech/ika-re-encrypt-transfer)

## why the indirection

a "normal" wallet has the user hold the full secret key. attacker compromising the user's storage gets the key. ika's 2PC-MPC means an attacker compromising the user gets only **half** - they can't sign without the network. attacker compromising the network gets only the network's half - they can't sign without the user. **both** parties have to be compromised, simultaneously, to forge a signature.

it's similar to threshold-ECDSA in custody applications (Fireblocks, Coinbase Custody) but with the user (via the wallet) as one of the parties instead of all parties being institutional.

## ika curve / signature-algorithm constants

| name | u8 (curve) / sigalgo | use |
|------|----------------------|-----|
| Curve.SECP256K1 = 0 | curve 0 | EVM, BTC |
| Curve.SECP256R1 = 1 | curve 1 | (not used by chromatika today) |
| Curve.ED25519 = 2 | curve 2 | Sui, Solana, Aptos |
| Curve.RISTRETTO = 3 | curve 3 | (not used by chromatika today) |
| SignatureAlgorithm.ECDSASecp256k1 = 0 | algo 0 | EVM, generic ECDSA |
| SignatureAlgorithm.Taproot = 1 | algo 1 | BTC P2TR |
| SignatureAlgorithm.ECDSASecp256r1 = 2 | algo 2 | (not used by chromatika today) |
| SignatureAlgorithm.EdDSA = 3 | algo 3 | Sui, Solana, Aptos |
| SignatureAlgorithm.SchnorrkelSubstrate = 4 | algo 4 | (not used by chromatika today) |

`fromCurveToNumber` is **not** exported from `@ika.xyz/sdk` main entry (it's internal to `hash-signature-validation.js`). hardcode the constants above; don't try to import the helper.

## the BaseChain abstraction (Sui vs Solana)

ika runs on both Sui and Solana. chromatika has `BaseChain = 'sui' | 'solana'` and `getIkaAdapter(session, baseChain)` in `@/background/ika/ika-adapter`. **never call `session.ikaClient.*` directly in signing / dWallet flows** - always go through the adapter. this lets the same chromatika code path drive different ika anchor chains without if-statements scattered everywhere.

`SolanaIkaAdapter` stubs Sui-only reads (`getPresignInParticularState`, `getEncryptedUserSecretKeyShare`, `getSign`, `executeTx`); they throw on Solana base. Solana-base DKG + sign bypass the adapter and go through `SolanaIkaGrpcClient` directly.

`DWalletMeta.baseChain` is **required** when initializing new entries - `getIkaAdapter` reads this.

## where to read more

- ika cryptography: https://github.com/dwallet-labs/ika/blob/main/docs/content/docs/sdk/cryptography.mdx
- ika SDK: `@ika.xyz/sdk` (Sui base) and `@ika.xyz/pre-alpha-solana-client` (Solana base, pre-alpha)
- chromatika ika adapter: `wallet-extension/src/background/ika/ika-adapter.ts`
- chromatika ika operations: `wallet-extension/src/background/ika/dwallet-lifecycle.ts`, `presign-pool.ts`, `signing.ts`
