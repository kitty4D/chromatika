# ika re-encrypt and dWallet transfer

a dWallet can move from one user to another by **re-encrypting the user share** to the new owner's encryption key. the dWallet itself stays at the same address; only "who can sign with it" changes. neither party ever sees the unencrypted share.

## the model

each dWallet has an **encrypted user share** stored on-chain (in the Sui object graph or Solana program account). that share is encrypted to the **owner's encryption key** (registered via `registerEncryptionKey`). to transfer:

1. sender re-encrypts their share to the recipient's encryption key
2. on-chain transition: dWallet is now "owned" by the recipient (in the sense that the encrypted share is theirs to decrypt)
3. recipient calls `acceptTransferredDWallet` to verify + finalize

the underlying ika MPC protocol is unchanged; only the user-share custody moves.

## prerequisites for sender

- vault unlocked
- the dWallet to transfer is `active` for its curve and the sender controls it
- recipient's Sui address is known
- recipient has registered their encryption key on-chain via `registerEncryptionKey({ curve })`

## prerequisites for recipient

- vault unlocked
- recipient has registered their encryption key for the matching curve **before** the transfer is initiated (otherwise the sender's `requestReEncryptUserShareFor` has nowhere to encrypt to)

## the sender flow

```
1. lookup recipient's encryption key on-chain
   recipientPubkey = await ikaClient.getSenderEncryptionKeyAddress(recipientSuiAddress)
   // throws if recipient hasn't registered

2. transferDWallet({ curve, recipientSuiAddress })
   - resolves to ikaClient.requestReEncryptUserShareFor with curve, dwalletId, recipientPubkey
3. build PTB
   tx = new IkaTransaction()
   tx.requestReEncryptUserShareFor({
     dwalletId,
     curve,
     recipientEncryptionKeyAddress: recipientPubkey,
   })
   // requestReEncryptUserShareFor returns void

4. fund + simulate + submit
5. on success, the recipient now has an encrypted-share-for-them on-chain
6. send the recipient: tx digest + curve + dWallet id (off-chain channel - email, signal, etc.)
```

## the recipient flow

```
1. recipient receives: digest, curve, dwalletId from sender (off-chain)

2. parse hints from the digest
   hints = await parseTransferTxDigest({ digest })
   // returns { encryptedShareId, senderEncryptionKeyAddress, ... }

3. complete the accept call
   await acceptTransferredDWallet({
     curve,
     dwalletId,
     senderEncryptionKeyAddress: hints.senderEncryptionKeyAddress,
     encryptedShareId: hints.encryptedShareId,
   })

4. internally:
   - read encrypted share from chain
   - decrypt with recipient's USK (their own UserShareEncryptionKeys)
   - validate decrypted share matches dWallet's published public key (zero-trust check)
   - if validation passes, build PTB to call ikaClient.acceptEncryptedUserShare
   - submit, wait for state to flip to 'active' (for the recipient)

5. setActiveDwallet(dwalletId) to wire it up as the active signer
```

after step 4, the **sender** can no longer sign with the dWallet - their share is no longer the canonical one for this dWallet. the recipient is now the sole signer.

## why re-encryption and not "send the secret"

in a normal wallet, transfer means "give the recipient the secret key". this is bad because:

- the recipient now holds plaintext key material
- the sender either keeps a copy (= both can sign, no clean handoff) or destroys their copy (= no provable handoff)

ika's re-encryption is cleaner:

- on-chain, there's exactly one encrypted share at any time (well, there's the old encrypted-to-sender and the new encrypted-to-recipient temporarily; the protocol manages the cutover)
- nobody ever sees the plaintext share
- the chain itself is the source of truth for "who owns this dWallet now"

## the encryption-key registration step

`registerEncryptionKey({ curve })` registers the user's encryption keypair on-chain. it's a one-time setup per curve per vault:

```
1. usk = sessionState.ikaShareKeys[curve]
2. encryption_pubkey = usk.encryptionPublicKey
3. PTB: ikaClient.registerEncryptionKey(encryption_pubkey, curve)
4. on-chain: a per-user encryption-key object is created at a deterministic address (the user's encryption-key address)
```

without registration, the user can't receive a transferred dWallet (the sender's `requestReEncryptUserShareFor` has nowhere to encrypt to).

`getSenderEncryptionKeyAddress({ curve })` queries the user's own registered encryption key address - useful to confirm registration succeeded.

## what about Solana base

Solana ika base re-encryption surface is **not generally usable today**. per the agent's exploration, `SolanaIkaAdapter`'s transfer-related reads (`getEncryptedUserSecretKeyShare`, etc.) **throw**. transferring a Solana-base dWallet is tracked future when the pre-alpha Solana SDK exposes the necessary primitives.

## what doesn't work

- transferring without recipient registration: `requestReEncryptUserShareFor` rejects (no target encryption key)
- transferring to your own address (self-transfer): protocol may reject or no-op; not a useful operation
- accept-side using a vault with a different USK than the encrypted-share's target: `decryptUserSecretKeyShare` throws (wrong key) - confirm the recipient is on the right vault
- transferring while a sign is in flight: race condition; the sign may complete before or after re-encryption, behavior depends on protocol ordering. avoid concurrent transfer + sign on the same dWallet

## the digest / hints flow

`parseTransferTxDigest({ digest })` is a chromatika utility that:

1. fetches the Sui transaction at `digest`
2. inspects events for the re-encryption event
3. extracts `encryptedShareId` (the on-chain id of the new encrypted share for the recipient) and `senderEncryptionKeyAddress`
4. returns these as hints

the recipient could in principle find these by walking on-chain state, but the digest+parse approach is faster and the user already has the digest from the sender's tx.

today only Sui digests are supported (Solana parse-from-digest is not implemented).

## library

- `@ika.xyz/sdk` `IkaTransaction.requestReEncryptUserShareFor`, `acceptEncryptedUserShare`, `registerEncryptionKey`
- internal: `wallet-extension/src/background/ika/dwallet-lifecycle.ts` for accept orchestration
- internal: `wallet-extension/src/background/ika/transfer.ts` (or similar) for transfer orchestration
- `UserShareEncryptionKeys.decryptUserSecretKeyShare` for recipient-side decrypt + validate
