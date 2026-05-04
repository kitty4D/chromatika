# how to use encrypted activity notes

attach a private note (up to 2048 utf-8 bytes) to any transaction your wallet signed. the note is encrypted to your active dWallet's ed25519 key via the encrypt.xyz pre-alpha backend. only the same vault on the same install (or any device that recovers the same dWallet identity) can decrypt. switching to a different vault locks you out of that vault's notes.

**pre-alpha disclaimer**: encrypt.xyz is pre-alpha. ciphertexts may be plaintext on-chain in this phase. **don't put real secrets in notes** - treat as dev preview / functional placeholder until production.

## prerequisites

- chromatika vault is unlocked
- the active dWallet Vault is on **Solana ika base** (the encryption backend asserts Solana-base; throws on Sui-base)
- you signed the tx in question with **this** chromatika install (notes only attach to records the local tx-record service has)
- some IKA / SOL for the gRPC `approve_message` fees the encrypt path needs (~0.001 SOL per encrypt or decrypt)

## options at a glance

- **add a note**: encrypt a fresh plaintext to your dWallet's ed25519 key
- **view a note**: decrypt to read (1-3s latency due to MPC sign + gRPC round-trip)
- **edit a note**: re-encrypt with new plaintext, replacing the old ciphertext id
- **remove a note**: drop the local pointer (on-chain ciphertext stays but is unreferenceable from your local store)

## how to add a note to a transaction

1. find the transaction in your activity feed (only txs your local wallet signed are eligible - other people's txs you've received don't qualify)
2. open the note edit affordance for that tx
3. type plaintext (up to 2048 utf-8 bytes; the editor shows a byte counter)
4. save. background:
   - generates a fresh 32-byte AES-256 key + 12-byte AES-GCM IV
   - encrypts your plaintext under that AES key (AES-GCM)
   - splits the AES key into two 16-byte chunks
   - wraps each chunk via encrypt.xyz `CreateInput` as EUint128 ciphertext (one batched gRPC call)
   - persists the resulting `EncryptedRef` (two ciphertext-identifier hexes + body ciphertext + IV) on the local tx record at `chromatika_signed_txs_v1`
5. the activity row gets a lock badge indicating "this tx has an encrypted note"

## how to view a note

1. tap the lock badge on an activity row (or the "view note" button)
2. background:
   - reads the stored `EncryptedRef`
   - validates that your active dWallet's ed25519 pubkey still matches the recipient pubkey on the ref (different vault = decrypt rejected with `wrong-vault` error)
   - signs two `ReadCiphertext` requests via ika MPC (one per AES key chunk) - this is the 1-3s latency
   - reassembles the 32-byte AES key
   - imports as a non-extractable `CryptoKey`
   - AES-GCM decrypts the body
   - returns plaintext
3. plaintext shows in the modal (read-only)
4. close to dismiss; the plaintext is dropped from memory

## how to edit a note

1. open the modal as if to view
2. switch to edit mode
3. type the new plaintext
4. save: the same encrypt path runs fresh, producing a new `EncryptedRef` that replaces the old one on the record
5. the old on-chain ciphertext-identifier becomes unreferenced. on devnet it'll get wiped; on production its lifecycle is determined by encrypt.xyz's storage rules

## how to remove a note

1. open the modal
2. click remove
3. background: drops `encryptedNote` from the local tx record. idempotent
4. on-chain ciphertext is **not** deleted - just unreferenced from your local pointer
5. lock badge disappears from the activity row

## how to know if a tx has a note (without decrypting)

1. lock badge on the activity row indicates a note is attached
2. lightweight `getActivityNoteStatus` query under the hood - no decrypt, just a presence check
3. doesn't trigger MPC signing, no fee cost

## notes

- notes are **vault-keyed**: each vault encrypts to its own dWallet's ed25519 pubkey. switching active vault = can't decrypt the previous vault's notes (by design). you can switch back at any time to read them again
- notes are **per tx hash**: one note per tx hash per vault. re-saving replaces the previous note
- notes are **local-first**: the local `chromatika_signed_txs_v1` store holds the pointer; the encrypted ciphertext lives in encrypt.xyz on-chain accounts. lose the local store (uninstall, browser data wipe) and the pointer is gone - the on-chain ciphertext is unreferenceable
- decrypt latency is dominated by the **two sequential MPC signs** for `ReadCiphertext` calls. there's no batched-decrypt path today; the encrypt.xyz pre-alpha protocol requires per-chunk signed reads. tracked future
- the `EncryptionBackend` abstraction supports backends beyond encrypt.xyz (direct ed25519 X25519-ECDH, Seal Move policy). today only encrypt.xyz is wired; the others are stubs that throw `not-implemented`. when more backends ship, existing notes auto-route by backend tag on the ref
- a future "cross-recipient note" path could let you encrypt a note to **someone else's** dWallet ed25519 pubkey (e.g. share a tx description with a colleague). not implemented; tracked
- only **EVM send paths** record locally today - sui / solana / btc / aptos sends and message signing don't write a tx record, so notes can't attach to them yet. tracked future hardening
