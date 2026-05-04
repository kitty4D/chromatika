# how to transfer a dWallet

dWallets can be transferred between users by re-encrypting the user share to a new owner's encryption key. this guide covers initiating an outbound transfer, accepting an incoming transfer, and parsing transfer-tx digest hints.

## prerequisites

- a Chromatika vault is unlocked
- for **outbound** transfer: you control an active dWallet and you know the recipient's Sui address
- for **inbound** transfer: you've already registered your encryption key (`registerEncryptionKey` per curve - see [manage-dwallets.md](/library/user/manage-dwallets)); the sender has sent you the transfer tx digest plus encrypted-share hints

## options at a glance

- **outbound**: `transferDWallet` - works on either curve
- **inbound**: `acceptTransferredDWallet` - finalizes the share so you can sign with it
- **digest parsing**: `parseTransferTxDigest` extracts the encrypted-share hints from a Sui transfer tx digest you were sent

## how to initiate an outbound transfer

1. make sure the dWallet you want to transfer is active for its curve
2. call `transferDWallet` with `curve` and `recipientSuiAddress`
3. background runs `requestReEncryptUserShareFor` against the recipient's registered encryption key - the recipient now has an encrypted share waiting on-chain
4. send the recipient the transfer-tx digest + curve so they can run the accept flow

## how to parse a transfer tx digest you received

1. call `parseTransferTxDigest` with the Sui transaction `digest`
2. wallet returns the encrypted-share id, sender encryption-key address, and other hints needed to accept
3. only Sui digests are supported today

## how to accept an incoming transfer

1. confirm you've registered your encryption key for the matching curve (`getSenderEncryptionKeyAddress` returns it)
2. call `acceptTransferredDWallet` with: `curve`, `dwalletId`, the sender's encryption-key address, and the encrypted-share hints from the parse step (or hints the sender provided manually)
3. the wallet runs `acceptEncryptedUserShare` on-chain; the dWallet flips to `Active` for you
4. the dWallet now appears in your owned caps - set it active via `setActiveDwallet` if you want it driving signing

## notes

- dWallet transfer is a **per-dWallet** action, not a vault-level action. the recipient gets exactly the one dWallet you send them, with its current state
- the recipient must have their encryption key registered **before** you initiate the transfer - if not, the `requestReEncryptUserShareFor` call has nowhere to encrypt to
- for Solana-base dWallets, the transfer surface depends on what the pre-alpha SDK exposes; today the Solana adapter's transfer-related reads still throw and the path is Sui-first. transferring solana-base dWallets is not generally usable
- after acceptance, the previous owner cannot sign with the dWallet anymore - the share is encrypted to your key
