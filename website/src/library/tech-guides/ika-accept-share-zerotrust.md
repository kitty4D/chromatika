# ika accept-share zero-trust flow

after DKG completes, the user's share lives on-chain encrypted to their encryption key. the dWallet is in `awaiting_key_holder_signature` state - meaning the network has done its part, but the user hasn't yet asserted ownership. `acceptEncryptedUserShare` is the call that closes the loop.

this is called "zero-trust" because chromatika doesn't have to trust that the network gave it a correct share; the user can decrypt and verify locally before signing the acceptance.

## prerequisites

- DKG has completed and the dWallet sits in `awaiting_key_holder_signature` state
- chromatika has the matching `UserShareEncryptionKeys` (decryption side)
- vault is unlocked
- the user's encryption-key address matches the address the share was encrypted to during DKG (this is automatic if the same vault drove DKG)

## the lifecycle state

dWallet states (Sui base):
- `requesting_dkg_user_input` - DKG starting
- `awaiting_key_holder_signature` - DKG done, share encrypted, waiting for accept
- `active` - accept ran, dWallet ready for sign
- some others for error / transitional states

`dWalletState({ curve })` returns the current state. `refreshDWalletState({ curve })` forces a chain re-fetch.

`completeDWalletZeroTrust({ curve, dwalletId? })` is the chromatika tRPC procedure that finishes the accept. if multiple dWallets are in `awaiting_key_holder_signature` (rare), pass `dwalletId` to disambiguate.

## the flow (Sui base)

```
1. fetch the encrypted user share from chain
   - read DKG completion event for encrypted_share_id
   - or call ikaClient.getEncryptedUserSecretKeyShare(dwalletId) which queries the on-chain object

2. decrypt locally
   - usk = sessionState.ikaShareKeys[curve]   // UserShareEncryptionKeys for this curve
   - decryptedShare = usk.decryptUserSecretKeyShare(encryptedShareBytes)
   - validate the decrypted share matches the dWallet's published public key
     (this is the "zero-trust" check - if validation fails, the network gave us
      a bad share; abort)

3. build the accept PTB
   tx = new IkaTransaction()
   tx.acceptEncryptedUserShare({
     dwalletId,
     encryptedShareId,
     userSignatureOverShare,   // signed proof the user has accepted
   })

4. submit, wait for tx digest, wait for dWallet state to flip to 'active'

5. setActiveDwallet(dwalletId) to wire it up as the active signer for its curve
```

## the flow (Solana base, pre-alpha)

```
1. read the encrypted user share from the Solana ika program account
2. decrypt locally with the matching USK
3. validate
4. submit the accept call via gRPC
   - includes approve_message signed by in-extension fee-payer
5. wait for chain state, set active
```

`SolanaIkaAdapter.getEncryptedUserSecretKeyShare` **throws** today (Sui-only read). Solana-base DKG + sign bypass the adapter and go through `SolanaIkaGrpcClient` directly, including the accept-share step.

## why "zero-trust"

the network could in principle hand chromatika a bogus encrypted share that doesn't match the dWallet's public key. zero-trust = chromatika decrypts the share and verifies before accepting. if validation fails, abort and don't accept.

what verification looks like:
- decrypt the share bytes with the user's encryption key (private side)
- derive the public component from the decrypted share
- compare to the on-chain dWallet's public key
- if they match: the share is correct, sign the acceptance
- if they don't: discard, alert the user, the dWallet is unusable

## what doesn't work

- **accept without DKG**: there's no encrypted share to accept; the call rejects
- **accept on a different vault than the one that drove DKG**: the user's encryption key won't match what the share was encrypted to. you'd have to transfer the dWallet (see [ika-re-encrypt-transfer.md](/library/tech/ika-re-encrypt-transfer)) first
- **accept with the wrong curve**: dWallets are bound to their curve at DKG; you can't promote a SECP256K1 dWallet to ED25519 or vice versa
- **timing**: there's no on-chain expiration on `awaiting_key_holder_signature` today, but if the user takes weeks to accept they should re-fetch state in case of indexer drift

## the multi-vault interaction

if a user has multiple dWallet Vaults under one chromatika install, each vault has its own `UserShareEncryptionKeys`. running DKG from vault A and trying to `completeDWalletZeroTrust` from vault B fails the validation - vault B can't decrypt a share that was encrypted to vault A's USK. always run accept-share from the vault that ran DKG.

if you want to move a dWallet to a different vault, that's the **transfer** path, not accept-share.

## library

- `@ika.xyz/sdk` `IkaTransaction.acceptEncryptedUserShare`
- internal: `wallet-extension/src/background/ika/dwallet-lifecycle.ts` for the orchestration logic
- internal: `wallet-extension/src/background/ika/ika-adapter.ts` for adapter dispatch
- internal: `UserShareEncryptionKeys.decryptUserSecretKeyShare` (or equivalent SDK method) for local decryption + validation
