# vault blob v3 format (`chromatika_vault_v3`)

the encrypted blob that holds **every chromatika vault** on this install. lives in `chrome.storage.local` under the key `chromatika_vault_v3`. one blob holds many vault records (mnemonic vaults, imported-key vaults, passkey vaults, hardware vaults), each with their own credential material - all sealed under one AES-256-GCM encryption.

## storage location

- `chrome.storage.local` (persists across browser restarts; cleared on uninstall)
- key: `chromatika_vault_v3`
- the `v3` suffix denotes schema version. v2 (PBKDF2) is rejected on parse - chromatika is pre-release, no migrations from v2

## outer shape

```jsonc
// stored at chrome.storage.local["chromatika_vault_v3"]
{
  "kdfMeta": {
    "kind": "argon2id",
    "tCost": 3,
    "mCostKiB": 65536, // 64 MiB
    "parallelism": 4,
    "saltB64": "<16 random bytes b64>",
    "outputLength": 32, // 32-byte AES-256 key
  },
  "ivB64": "<12 random bytes b64>", // AES-GCM IV
  "ciphertextB64": "<sealed bytes>",
}
```

the `ciphertextB64` is `AES-256-GCM(plaintext, key, iv)` where `key = argon2id(password, kdfMeta.saltB64, ...)`. the AES-GCM tag (16 bytes) is appended to the ciphertext per webcrypto's default behavior.

## inner plaintext (after decrypt)

```jsonc
{
  "v": 3,
  "vaults": [
    {
      /* VaultRecord */
    },
    {
      /* VaultRecord */
    },
  ],
  "activeVaultId": "<vault-id-string>",
}
```

## VaultRecord shape

each vault record is a discriminated bag of credential material. fields present depend on `seedSource` and credential type:

```jsonc
{
  "id": "<uuid>",
  "label": "main",
  "baseChain": "sui" | "solana",
  "createdAtMs": 1700000000000,

  // ika user-share encryption keys (per curve)
  "ikaShareKeysB64": {
    "SECP256K1": "<b64>",   // serialized UserShareEncryptionKeys for secp256k1
    "ED25519":   "<b64>"
  },

  // dWallet metadata cache (cap ids, addresses, attestation bytes for solana)
  "dwalletMeta": [
    {
      "dwalletId": "0x...",
      "curve": "SECP256K1",
      "baseChain": "sui",
      // solana base only:
      "dwalletAttestationBytesB64": "...",
      "dwalletPublicKeyB64": "..."
    }
  ],

  // credential-specific fields - exactly one branch is populated:
  "seedSource": "mnemonic" | "private-key" | "passkey-prf" | "waap-signature" |
                "recovery-words" | "mwa-signature" | "walletconnect-signature" |
                "lazor-recovery-words",

  // mnemonic vaults
  "mnemonic": "12 or 24 space-separated words",

  // imported private-key vaults
  "suiPrivateKeyBech32": "suiprivkey1...",   // sui base
  "solanaSecretKeyB64": "<64-byte b64>",     // solana base

  // passkey vaults
  "passkeyCredentialId": "<b64url credentialId>",
  "passkeyPublicKeyB64": "<33-byte compressed secp256r1 pubkey b64>",
  "passkeyRpId": "<extension origin>",
  "passkeyPrfSaltB64": "<32-byte salt b64>",

  // WAAP vaults (deterministic-signature path)
  "waapSuiAddress": "0x...",
  "waapSuiPublicKeyB64": "<b64>",
  "waapAuthMethod": "email" | "phone" | "social",
  "waapSocialProvider": "google" | "discord" | "twitter" | "github" | "bluesky" | null,
  "waapPairingSignatureB64": "<encrypted-in-envelope signature>",

  // Lazor vaults (Solana + recovery-words required)
  "lazorSmartWalletPubkeyB58": "<base58 PDA>",
  "lazorCredentialIdB64": "<b64>",
  "lazorPasskeyPubkeyB64": "<b64>",
  "lazorProgramId": "<base58 program id>",
  "lazorNetwork": "mainnet" | "devnet",
  "lazorPortalUrl": "https://portal.lazor.sh",
  "lazorWalletDevicePubkeyB58": "<base58>" | null,
  "lazorIkaFeePayerSolSecretKeyB64": "<64-byte solana secret key b64>",
  "recoveryWordsEncryptedB64": "<24 BIP39 words>",   // stored as plaintext inside the AES-GCM blob

  // hardware vaults (MWA / Seeker / WalletConnect / Ledger)
  "hardwareAccountId": "<id from getHardwareAccounts>",
  "hardwareVendor": "mwa" | "walletconnect" | "ledger" | "trezor",
  "hardwareChain": "solana" | "sui",
  "mwaTransport": "local" | "remote" | null,
  "ikaUskSignatureB64": "<encrypted-in-envelope signature>",
  "ikaGrpcFeePayerSolSecretKeyB64": "<64-byte b64, in_extension fee mode only>",
  "ledgerFeePayerSolPubkeyB58": "<base58, ledger-first solana>",
  "ledgerFeePayerEd25519PublicKeyB64": "<b64, ledger-first sui>",

  // multi-envelope unlock metadata
  "envelopes": [
    { /* PasswordEnvelope or PasskeyPRFEnvelope or WalletSignatureEnvelope or RecoveryWordsEnvelope */ }
  ],

  // ika fee-payer settings (solana base)
  "ikaFeeSettings": {
    "mode": "in_extension" | "seeker_direct",
    "autoRefill": true,
    "refillLamports": 50000000,
    "thresholdLamports": 5000000
  }
}
```

not every field is present on every record. `seedSource` selects which branch is canonical. e.g. a Sui-mnemonic vault has `mnemonic` set, no `solanaSecretKeyB64`, no passkey fields, no hardware fields.

## the per-vault dWallet meta overlay

separately from the vault blob, each vault writes a `chromatika_dwallet_meta_v2_<vaultId>` overlay to `chrome.storage.local`. this overlay is a fresher snapshot of the vault's `dwalletMeta` field for some flows that read meta without unlocking the full blob (e.g. dapp-bridge reading the active dWallet address before unlock, status surfaces).

the in-blob `dwalletMeta` is the **authoritative copy**; the overlay is a cache. on unlock the session merges, preferring overlay timestamps where they're newer.

`loadDwalletMeta(vaultId)` and `saveDwalletMeta(vaultId, meta)` are the access helpers. `syncVaultMeta` flushes session state into the overlay on demand.

## per-vault presign pools

`chromatika_presign_pools_v3_<vaultId>` stores ika presign material per dWallet Vault. three pools per vault: `SECP256K1_ECDSA`, `SECP256K1_TAPROOT`, `ED25519_EDDSA`. switching active vault loads a different pool set.

## key naming convention

`chromatika_<domain>_v<N>` (or `chromatika_<domain>_v<N>_<suffix>` for per-instance scoping). the integer suffix bumps on schema change. complete list of storage keys:

- `chromatika_vault_v3` - the encrypted blob (this doc)
- `chromatika_dwallet_meta_v2_<vaultId>` - per-vault dWallet overlay
- `chromatika_presign_pools_v3_<vaultId>` - per-vault presign pools
- `chromatika_active_networks_v1` - active network selection per chain
- `chromatika_custom_networks_v1` - user-added custom networks
- `chromatika_media_safety_v1` - MediaSafetyMode value
- `chromatika_dapp_permissions_v1` - dapp connection permissions
- `chromatika_hw_accounts_v1` - hardware account list
- `chromatika_advanced_mode_v1` - advanced mode toggle
- `chromatika_ika_base_mode_v1` - global ika base preference
- `chromatika_mcp_v1` - MCP agent surface state (token, listen port, etc.)
- `chromatika_x402_caps_v1` - x402 spending caps
- `chromatika_x402_receipts_v1` - x402 payment receipts (capped 200)
- `chromatika_unlock_cache_v1` - **session storage only** (cold-SW rehydrate cache)

## what to do when the schema breaks

pre-release means **don't migrate**. when chromatika changes the v3 record shape (e.g. adding new credential fields, changing dWallet meta layout):

1. bump the version suffix → `chromatika_vault_v4`
2. on parse, if version != current, reject with a clear "clear extension storage and re-onboard" message
3. document the breaking change in commit message + STATUS.md
4. ship

users / devs clear `chrome.storage.local` (or uninstall + reinstall the extension) and re-onboard. this is fine because there are no end users to migrate.
