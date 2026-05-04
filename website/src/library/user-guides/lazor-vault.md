# how to use a Lazor-backed solana vault

create or unlock a chromatika vault using Lazor's smart-wallet portal - a Solana-anchored passkey flow with optional BIP39 recovery words.

## prerequisites

- a Lazor smart wallet provisioned through the Lazor portal
- the device + browser supports WebAuthn (passkey)
- decide network (mainnet or devnet) - must match the network where the Lazor smart wallet lives
- for vault creation: no existing vault (or you're adding as a sibling)

## options at a glance

- **network**: mainnet or devnet
- **recovery words**: optional BIP39 backup branch registered at create time
- **label**: human-readable vault name

## how to create a Lazor-backed vault (first vault)

1. complete Lazor portal flow to get: smart wallet pubkey, credential id, passkey params, Lazor program id, network choice
2. submit `createVaultLazor` with: password, `lazorSmartWalletPubkey`, `credentialId`, the passkey params, `lazorProgramId`, network, optional `recoveryWords`, optional label
3. background registers the envelope, encrypts the vault, writes `chromatika_vault_v3`
4. session unlocks immediately

## how to add a Lazor envelope to an existing vault

1. unlock the wallet (or include the password)
2. submit `addVaultLazor` with the same fields
3. envelope joins the vault list

## how to unlock with Lazor

1. read `listVaultEnvelopes` to find the Lazor envelope
2. run the Lazor passkey assertion ceremony (the portal handles it)
3. submit `unlockVaultWalletSignature` with envelope id, signature (b64), `autoLockMinutes`

## how to recover with the BIP39 words

1. only works if `recoveryWords` were set at create time
2. submit `unlockVaultRecoveryWords` with the envelope id, words, `autoLockMinutes`

## notes

- Lazor is Solana-only - the smart wallet lives on Solana, the program id determines which deployment you're talking to
- choosing devnet means the smart wallet, recovery, and any signed transactions all anchor to Solana devnet - good for testing, do not put real funds on devnet
- if you skip `recoveryWords` at create time, losing the passkey means losing access to that envelope. you can have other unlock paths on the vault as backup
