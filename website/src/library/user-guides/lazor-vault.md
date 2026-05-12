# how to use a Lazor-backed solana vault

create or unlock a chromatika vault using Lazor's smart-wallet portal - a Solana-anchored passkey flow with three distinct seed-source paths so the user picks the right tradeoff between convenience and authenticator-compatibility.

## prerequisites

- a Lazor smart wallet provisioned through the Lazor portal (`portal.lazor.sh`)
- the device + browser supports WebAuthn (passkey)
- decide network (mainnet or devnet) - must match the network where the Lazor smart wallet lives
- for vault creation: no existing vault (or you're adding as a sibling)

## three seed-source paths (LazorStep mode picker)

new: chromatika now offers a **3-way mode picker** for how the ika seed (which controls cross-chain Sui / EVM / BTC / Aptos addresses) is anchored to your Lazor identity. Lazor itself is always your Solana identity (the smart-wallet PDA), but you choose what seeds the cross-chain dwallet:

1. **lazor passkey** (recommended/experimental)
   - the lazor passkey signs `IKA_USK_DERIVATION_MESSAGE_LAZOR_V1` twice
   - chromatika compares the two signatures (the determinism probe). if they match (RFC 6979 deterministic ECDSA — apple platform / most hardware tokens), the signature seeds ika via `keccak256(signature || index_le)`
   - **no phrase to write down** — the lazor passkey IS your full identity, both Solana + cross-chain
   - restore: log into your existing lazor account at the portal → same passkey → same signature → same ika seed → same dwallet
   - **fails on non-deterministic authenticators** (some android implementations, older yubikeys). chromatika surfaces a clear error and points you at the recovery-words path
2. **generate a 24-word phrase**
   - chromatika picks a fresh phrase. you write it down
   - works on any authenticator including non-deterministic ones
   - restore: paste the phrase + re-pair the same lazor account
3. **restore from phrase**
   - paste your existing 24-word phrase. lazor passkey can be the same one OR a new one (smart-wallet PDA is keyed to the credential, independent of which side of the auth flow chromatika is on)
   - this is the path for restoring a v1 phrase-only vault on a new install

default mode is `lazor passkey`. phrase modes stay as the safety net.

## how to create a Lazor-backed vault (first vault)

1. open chromatika onboarding → click "create with Lazor"
2. enter password (chromatika still wraps the local vault blob under it; passkey-only unlock for Lazor is a future slice)
3. pick a seed-source mode (default `lazor passkey`)
4. click continue → Lazor portal opens
5. authorize with your passkey at the portal
6. chromatika resolves the canonical smart-wallet PDA via `getSmartWalletByCredentialHash` (replaces the v1 placeholder where chromatika stored the passkey pubkey instead of the PDA)
7. (lazor-signature path only) chromatika opens the portal twice for the determinism probe; if signatures match, that signature seeds ika
8. (recovery-words paths) chromatika persists the phrase encrypted under the vault key
9. the vault lands; chromatika unlocks immediately

## how to add a Lazor envelope to an existing vault

1. unlock the wallet (or include the password)
2. open settings → "find more accounts" → "add sibling vault →" (or open vault management)
3. pick the same Lazor identity → chromatika auto-picks the next `ikaEncryptionIndex` so you get a fresh dwallet at the same Solana smart-wallet address

## how to unlock with Lazor

today: chromatika's local vault blob is unlocked via the password (or recovery-words envelope when you set one up). lazor-passkey-as-unlock is tracked as future work — the lazor-signature seed is currently used for **ika** seeding only, not for chromatika's local blob.

## how to recover with the BIP39 words

1. only works if `recoveryWords` were set at create time (recovery-generate or recovery-restore mode), OR the v1 phrase-only path was used
2. submit `unlockVaultRecoveryWords` with the envelope id, words, `autoLockMinutes`

## notes

- Lazor is Solana-only — the smart wallet lives on Solana, the program id determines which deployment you're talking to. chromatika now reads the program id live from `LazorkitClient.programId` instead of the v1 hardcoded placeholder
- choosing devnet means the smart wallet, recovery, and any signed transactions all anchor to Solana devnet — good for testing, do not put real funds on devnet
- the **lazor-signature path** is gated on authenticator-side determinism. if your device can't produce identical ECDSA signatures for the same message twice, chromatika won't use it as a seed source — the dwallet wouldn't be portable across devices. you'd see a clear error directing you to the phrase path
- existing v1 lazor vaults (phrase-only, with the passkey-pubkey-as-PDA placeholder) keep working but you'd want to clear extension storage and re-onboard to pick up the canonical PDA + lazor-signature path
- `lazorPairingSignatureB64` is persisted (encrypted) on the vault record for `lazor-signature` vaults so sibling-add at higher ika encryption indices doesn't need to re-prompt the portal
