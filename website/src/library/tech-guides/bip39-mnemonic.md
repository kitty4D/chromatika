# BIP39 mnemonics in chromatika

BIP39 is the spec for "twelve or twenty-four word seed phrases" - the human-readable encoding of cryptographic entropy that every modern HD wallet uses. chromatika supports it for HD vault creation, vault import, and as a recovery branch on passkey / WAAP / Lazor envelopes.

## what BIP39 actually does

1. **entropy**: 128 bits (12-word) or 256 bits (24-word). chromatika supports both; default is 12. the spec also allows 15 / 18 / 21 word lengths but the wallet's UI / API expose only 12 + 24 to keep the surface clean
2. **checksum**: append `entropy_bits / 32` checksum bits to the entropy; the checksum is the first `entropy_bits/32` bits of `SHA-256(entropy)`. for 128 bits → 4 checksum bits → 132 total → 11-bit groups → 12 words. for 256 → 8 checksum bits → 264 total → 24 words
3. **wordlist**: BIP39 English wordlist (2048 words = 11 bits / word). chromatika does **not** support other languages today
4. **seed derivation**: PBKDF2-HMAC-SHA512 with **2048 iterations**, password = mnemonic UTF-8 NFKD normalized, salt = `"mnemonic" + passphrase` (UTF-8 NFKD). chromatika uses **empty passphrase** today. output is the 64-byte BIP39 seed that feeds BIP44 / SLIP10

## where chromatika runs BIP39

**all generation runs in the extension background** (the service worker), not in React, not on a server. this is the same trust boundary as encrypt / decrypt - if you can compromise the SW, you can read the vault, but importantly there's no network round-trip during creation.

generators / validators come from `@scure/bip39` and the English wordlist from `@scure/bip39/wordlists/english`. the generator pulls 16 / 32 bytes from `crypto.getRandomValues` (browser CSPRNG seeded from OS entropy) for entropy; checksum is computed locally; the words are returned as a single space-joined string.

`validateWords(words)` does:

1. split + length check (must be 12 / 15 / 18 / 21 / 24)
2. each word must be in the English wordlist
3. checksum bits must match `SHA-256(entropy)` first bits

invalid mnemonics are rejected at the API boundary (`createVault`, `importVault`, `addVault` etc.) before any state mutation.

## the seed → keypair pipeline (Sui base)

```
mnemonic (12 or 24 words)
  → PBKDF2-HMAC-SHA512(mnemonic, "mnemonic" + "")  → 64-byte seed
  → Mysten Ed25519Keypair.deriveKeypair(mnemonic, "m/44'/784'/0'/0'/0'")
    → uses SLIP10 ed25519 derivation under the hood
    → 32-byte ed25519 secret + 32-byte ed25519 public key
```

the derivation path `m/44'/784'/0'/0'/0'` is the standard Sui derivation per SLIP-44 (`784` is Sui's coin type). `accountIndex = 0` = the fee-payer account.

## the seed → keypair pipeline (Solana base)

```
mnemonic (12 or 24 words)
  → mnemonicToSeedSync(mnemonic, "")  → 64-byte BIP39 seed (hex)
  → slip10Ed25519DerivePath("m/44'/501'/0'/0'", seedHex)
    → 32-byte ed25519 seed
  → solana.Keypair.fromSeed(seed32)
    → canonical 64-byte secretKey (32-byte seed || 32-byte pubkey)
```

`501` is Solana's SLIP-44 coin type. Solana `Keypair.secretKey` is 64 bytes by convention - the first 32 bytes are the ed25519 seed, the last 32 are the public key. this is the same shape Phantom and `solana-keygen` JSON-export.

## storage

mnemonic is **stored in the encrypted vault blob** in plaintext (within the vault's own AES-GCM seal). this means anyone with the unlocked vault can read the mnemonic - that's by design, since the user explicitly asked to "remember" the mnemonic by setting up a vault. on lock the vault re-seals; the only thing left is the encrypted blob in `chrome.storage.local`.

private-key vaults (see [import-vault-private-key.md](/library/user/import-vault-private-key)) skip BIP39 entirely - they store `suiPrivateKeyBech32` or `solanaSecretKeyB64` in the vault blob instead of a mnemonic.

## passphrase support

not implemented today. BIP39 allows an optional 25th-word passphrase (effectively a salt that produces a different seed for the same mnemonic). chromatika treats the passphrase as empty. adding it would be a forward-compatible vault-record field plus UI work. tracked as future hardening if anyone asks.

## libraries

- `@scure/bip39` for mnemonic generation, validation, `mnemonicToSeedSync`
- `@scure/bip39/wordlists/english` for the English wordlist
- `@mysten/sui` `Ed25519Keypair.deriveKeypair` for Sui derivation (wraps SLIP10 internally)
- a SLIP10 ed25519 derivation helper for Solana

## what chromatika **doesn't** support

- non-English wordlists (Spanish, Japanese, etc.)
- 15 / 18 / 21 word phrases on the create / import surfaces (validation accepts them, but the generator only emits 12 / 24)
- BIP39 passphrase
- electrum / monero seed formats (different specs entirely)
