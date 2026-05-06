# BIP44 + SLIP10 derivation paths

after BIP39 produces a 64-byte seed (see [bip39-mnemonic.md](/library/tech/bip39-mnemonic)), chromatika walks a hierarchical derivation path to produce a per-chain keypair. the rules differ between curves: secp256k1 (BIP32) for EVM and BTC; ed25519 (SLIP10) for Sui, Solana, Aptos.

## paths chromatika uses

| chain                   | curve     | path                  | source                       |
| ----------------------- | --------- | --------------------- | ---------------------------- |
| EVM (Ethereum, L2s)     | secp256k1 | `m/44'/60'/0'/0/0`    | BIP44 (SLIP-44 coin 60)      |
| Bitcoin (P2WPKH segwit) | secp256k1 | `m/84'/0'/0'/0/0`     | BIP84 (segwit native)        |
| Bitcoin (P2TR taproot)  | secp256k1 | `m/86'/0'/0'/0/0`     | BIP86 (taproot)              |
| Sui                     | ed25519   | `m/44'/784'/0'/0'/0'` | SLIP-44 coin 784             |
| Solana                  | ed25519   | `m/44'/501'/0'/0'`    | SLIP-44 coin 501 (4-segment) |
| Aptos                   | ed25519   | `m/44'/637'/0'/0'/0'` | SLIP-44 coin 637             |

the trailing `'` denotes a hardened derivation step (per BIP32: hardened indices use the parent secret key, not the parent public key, in the HMAC input).

## BIP32 (secp256k1) for EVM and BTC

BIP32 master key derivation:

```
master_seed = BIP39_seed (64 bytes)
master_node = HMAC-SHA512(key="Bitcoin seed", data=master_seed)
master_secret_key = master_node[0..32]
master_chain_code = master_node[32..64]
```

then per derivation step:

```
hardened (i >= 0x80000000):
  data = 0x00 || parent_secret_key || ser32(i)
non-hardened:
  data = serP(parent_pubkey) || ser32(i)
hmac = HMAC-SHA512(key=parent_chain_code, data=data)
child_secret = (hmac[0..32] + parent_secret) mod n   // n = secp256k1 order
child_chain  = hmac[32..64]
```

walking `m/44'/60'/0'/0/0` produces a 32-byte secp256k1 secret. EVM address = `last 20 bytes of keccak256(uncompressed_public_key_64bytes)` (see [keccak256-uses.md](/library/tech/keccak256-uses)).

BIP84 (`m/84'/0'/0'/0/0`) and BIP86 (`m/86'/0'/0'/0/0`) walk the same BIP32 logic but with different "purpose" segments (84 vs 86 vs 44) so the derived keys are isolated per address kind. P2WPKH addresses use bech32 encoding with `bc1q…` (mainnet) or `tb1q…` (testnet); P2TR uses bech32m with `bc1p…` / `tb1p…`.

library: `@scure/bip32`.

## SLIP10 (ed25519) for Sui, Solana, Aptos

SLIP10 is the ed25519 equivalent of BIP32. critical difference: ed25519 child derivation **only supports hardened steps** (you cannot derive a child public key from a parent public key alone - the curve doesn't support the "add scalar to point, get new pubkey" trick BIP32 uses for non-hardened steps).

```
master_node = HMAC-SHA512(key="ed25519 seed", data=BIP39_seed)
master_secret_seed = master_node[0..32]
master_chain_code  = master_node[32..64]

per step (must be hardened):
  data = 0x00 || parent_secret_seed || ser32(i + 0x80000000)
  hmac = HMAC-SHA512(key=parent_chain_code, data=data)
  child_secret = hmac[0..32]
  child_chain  = hmac[32..64]
```

walking `m/44'/784'/0'/0'/0'` (Sui) or `m/44'/501'/0'/0'` (Solana) or `m/44'/637'/0'/0'/0'` (Aptos) produces a 32-byte ed25519 seed. then `ed25519_keypair_from_seed(seed)` produces the 32-byte public key.

note Solana's path is **4 segments** (`m/44'/501'/0'/0'`) where Sui and Aptos use **5** (`m/44'/coin'/0'/0'/0'`). this is intentional - Solana follows the original SLIP-44 convention with `account/change` slots; Sui and Aptos add a final `address_index'`. all four are hardened.

library: `slip10-ed25519` style helper (chromatika uses an internal `slip10Ed25519DerivePath` plus `@noble/ed25519` for keypair construction). Mysten's `Ed25519Keypair.deriveKeypair(mnemonic, path)` wraps the same logic for Sui.

## why path matters

- two wallets that use the **same mnemonic** but **different paths** produce different addresses and different keys. this is intentional - it lets the same seed generate keys for multiple chains without collision
- chromatika's chain registry pins paths globally - you don't pick a path per vault, the path is determined by the chain
- if you import a mnemonic from a wallet that used a non-standard path (e.g. an old hardware wallet that used `m/44'/60'/0'/0/0` vs Trezor's `m/44'/60'/0'/0` change layer), the addresses differ. that's a "your wallet uses different paths than chromatika" problem, not a chromatika bug

## fee-payer = account 0

all chromatika fee-payer derivations use **account index 0**. this is the keypair that funds ika DKG / presign / sign on-chain operations on Sui base, and the keypair whose canonical 64-byte secret feeds `ikaRootSeedFromSolanaKeypair` / `ikaRootSeedFromFeeKeypair` for the ika user-share encryption keys.

multi-account expansion (account 1, 2, etc. for sibling dWallet Vaults under one mnemonic) is not exposed today. each chromatika vault uses its own mnemonic + account 0 - if you want a second vault, generate a fresh mnemonic via `addVault` rather than walking deeper into the existing tree.

## hardware wallet derivation paths

Ledger and Trezor derive the same paths in firmware (their UI lets the user pick `m/44'/60'/0'/0/X` for X = 0, 1, 2, ...). chromatika exposes the standard `0` slot today. if you want to add a Ledger account with a non-zero index, the wallet stores `derivationPath` per `addHardwareAccount` call.
