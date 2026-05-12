# recovery-words envelope

a BIP39 mnemonic phrase wrapped as an unlock envelope. used as a backup branch on passkey, WAAP, and Lazor envelopes - so if the primary credential is lost (passkey deleted, phone lost, WAAP account suspended), the user can still unlock by typing the words.

note: this is **not** the same as a mnemonic-vault `seedSource: 'mnemonic'`. that's the case where BIP39 is the **primary** source of all keys. recovery-words envelopes are an **additional unlock branch** on top of a non-mnemonic-rooted vault (passkey / WAAP / Lazor).

## envelope record

```jsonc
{
  "kind": "recovery-words",
  "wordCount": 12 | 24,
  "label": "primary recovery",
  "kdfSaltB64": "<32 random bytes>",
  "probesB64": [
    "<HMAC-SHA256(probe_key, word_0)>",
    "<HMAC-SHA256(probe_key, word_1)>",
    ...
  ],
  "wrappedMasterKeyB64": "<AES-GCM(envKey, masterKey, iv)>",
  "envIvB64": "<12 random bytes>"
}
```

`probes` is an optional pre-validation array - lets the unlock surface check the words look right (HMAC of each word matches the registered probe) before spending the full HKDF + AES-GCM unwrap. helps catch typos early.

## creation

```
1. user provides 12 or 24 BIP39 words at envelope-create time
2. validate words against the BIP39 English wordlist (checksum + dictionary)
3. bip39_seed = mnemonicToSeedSync(words, "")   // 64 bytes via PBKDF2-HMAC-SHA512 (2048 iters)
4. generate 32-byte kdfSalt
5. envKey = HKDF-SHA256(bip39_seed, info='chromatika recovery-words envelope v1', salt=kdfSalt)
6. wrappedMK = AES-GCM(envKey, masterKey, randomIv)
7. (optional) probes = HMAC-SHA256(probe_key, word) for each word, where probe_key is derived from the bip39_seed
8. envelope = { kind, wordCount, label, kdfSaltB64, probesB64, wrappedMasterKeyB64, envIvB64 }
```

words are **not stored** in the envelope. only the wrappedMK + (optional) probes survive. typing the words again at unlock time reproduces the bip39_seed → envKey → unwrap.

(in some cases - notably **Lazor** vaults - the recovery words **are** stored as plaintext inside the encrypted vault payload at `recoveryWordsEncryptedB64`, alongside the deterministic Solana fee-payer keypair derived from those same words. this is so the wallet can rebuild the in-extension fee-payer keypair on a new install without prompting the user. the envelope itself still doesn't store words - the Lazor vault payload does. see [ika-seed-solana-lazor.md](/library/tech/ika-seed-solana-lazor).)

## unlock

```
1. user types the BIP39 phrase
2. validate against BIP39 wordlist + checksum
3. (optional) verify probes match - if any word's HMAC doesn't match, surface "wrong phrase" without spending KDF
4. bip39_seed = mnemonicToSeedSync(words, "")
5. envKey = HKDF-SHA256(bip39_seed, info='chromatika recovery-words envelope v1', salt=kdfSalt)
6. masterKey = AES-GCM.decrypt(envKey, wrappedMK, envIv)
7. session unlocks
```

## why HKDF and not argon2id

BIP39's PBKDF2-HMAC-SHA512 with 2048 iterations is itself a slow KDF that resists brute force on the low-entropy mnemonic input. once we have the 64-byte BIP39 seed, that's already 256 bits of entropy - HKDF is the right tool to extract + expand without additional stretching.

## the rotation story

after unlocking via recovery, the user usually wants to register a fresh primary credential:

1. unlock via recovery words
2. add new passkey / WAAP / Lazor envelope (`addVaultPasskey` / `addVaultWaap` / etc.)
3. optionally remove the old envelope if the user knows which credential was lost

the recovery-words envelope itself can also be re-registered (e.g. user wants to switch from 12 → 24 word phrase). that's "remove old recovery-words envelope, add new one with new phrase".

## the same words on multiple vaults

different vaults can have **different** recovery phrases. if a user reuses one phrase across vaults, that's user choice - the security model doesn't require uniqueness. probes are per-envelope so cross-vault leakage of one phrase doesn't reveal anything about other vaults beyond "are these the same words".

## not the same as a mnemonic vault root

a vault with `seedSource: 'mnemonic'` uses BIP39 to **derive every key in the vault** (sui keypair, solana keypair, ika seed). a vault with a recovery-words envelope but `seedSource: 'passkey-prf'` uses BIP39 only for the unlock branch - the **dWallet identity** comes from the passkey PRF or whatever the primary source is. typing recovery words on the passkey vault unlocks the same masterKey, which decrypts the same vault payload, which contains the same passkey-derived ika keys.

so:
- mnemonic vault → recovery phrase **is** the vault. losing it = losing everything.
- passkey vault + recovery branch → recovery phrase is a **backup unlock**. losing it = losing one of multiple unlock paths, but the vault still works as long as the passkey works.

## library

- `@scure/bip39` for `validateWords`, `mnemonicToSeedSync`
- `crypto.subtle.deriveKey` for HKDF-SHA256
- `crypto.subtle.encrypt` / `.decrypt` for AES-GCM
- internal helpers: `buildRecoveryWordsEnvelopeRef(mk, bip39_seed, { wordCount, label })`, `unlockRecoveryWordsEnvelope`, `validateProbes`
