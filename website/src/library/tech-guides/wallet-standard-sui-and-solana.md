# Wallet Standard (Sui + Solana)

Wallet Standard is the cross-chain spec for "how dapps discover and talk to wallets". originally Solana, now multi-chain with chain-specific feature extensions. chromatika registers a Wallet Standard entry per chain (Sui via `@mysten/wallet-standard`, Solana via `@solana/wallet-standard-features`) so dapps using `@wallet-standard/core` can discover chromatika and call its features.

## the registration

Wallet Standard discovery happens via global window events:

```ts
const wallet: Wallet = {
  version: '1.0.0',
  name: 'Chromatika',
  icon: 'data:image/svg+xml;base64,...',
  chains: ['sui:mainnet', 'sui:testnet', 'sui:devnet',
           'solana:mainnet', 'solana:devnet'],
  accounts: [/* current accounts */],
  features: {
    'standard:connect': { version: '1.0.0', connect: ... },
    'standard:events': { version: '1.0.0', on: ... },
    'standard:disconnect': { version: '1.0.0', disconnect: ... },
    'sui:signTransaction': { version: '2.0.0', signTransaction: ... },
    'sui:signAndExecuteTransaction': { version: '2.0.0', signAndExecuteTransaction: ... },
    'sui:signPersonalMessage': { version: '1.0.0', signPersonalMessage: ... },
    'solana:signTransaction': { version: '1.0.0', signTransaction: ... },
    'solana:signAndSendTransaction': { version: '1.0.0', signAndSendTransaction: ... },
    'solana:signMessage': { version: '1.0.0', signMessage: ... },
  },
};

// announce
window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', {
  detail: { register: (cb) => cb(wallet) },
}));
```

dapps using `getWallets()` from `@wallet-standard/core` see chromatika in their list immediately.

## sui features chromatika implements

| feature | spec | what chromatika does |
|---------|------|---------------------|
| `sui:signTransaction` | `@mysten/wallet-standard` | builds intent, computes BLAKE2b digest, ika ED25519 sign, returns `{ signature, transactionBytes }` |
| `sui:signAndExecuteTransaction` | `@mysten/wallet-standard` | sign + submit via active Sui RPC, returns digest + effects |
| `sui:signPersonalMessage` | `@mysten/wallet-standard` | ika ED25519 SHA-512 path (BLAKE2b divergence per [sui-personal-message-divergence.md](/library/tech/sui-personal-message-divergence)) |
| `standard:connect` | wallet-standard core | opens dapp connect approval popup |
| `standard:disconnect` | wallet-standard core | revokes the origin's permission |
| `standard:events` | wallet-standard core | emits `change` events for accounts / chains |

note: Sui signature format is `[scheme_flag(1) || sig(64) || pubkey(32)]` = 97 bytes base64. see [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika).

## solana features chromatika implements

| feature | spec | what chromatika does |
|---------|------|---------------------|
| `solana:signTransaction` | `@solana/wallet-standard-features` | sign serialized v0 message via ika ED25519, return signed tx |
| `solana:signAndSendTransaction` | `@solana/wallet-standard-features` | sign + broadcast via Solana RPC, return tx signature (base58) |
| `solana:signMessage` | `@solana/wallet-standard-features` | ika ED25519 sign of raw bytes, return 64-byte sig |
| `standard:connect` | wallet-standard core | opens dapp connect approval popup |
| `standard:disconnect` | wallet-standard core | revokes the origin's permission |

note: Solana signatures are bare 64-byte `R || S` ed25519, base58 or hex encoded depending on caller.

## bulk signing primitives

`solana:signAllTransactions` (older feature) lets a dapp sign multiple txs in one popup. chromatika supports this with the `dapp-consent-mode` setting (compat = one popup for all; strict = popup per tx). see [manage-dapp-permissions.md](/library/user/manage-dapp-permissions).

`sui:signAllTransactionBlocks` analog: not currently exposed by `@mysten/wallet-standard` 0.20.x; dapps batch via separate sign calls.

## per-origin account selection

connecting via `standard:connect` lets the user pick a dWallet for each curve they want to expose:

```
[connect approval popup]
  pick SECP256K1 dWallet (for EVM)?  or skip
  pick ED25519 dWallet (for Sui / Solana / Aptos)?  or skip
  approve | reject
```

dapp on Sui only needs ED25519 → user picks just that. dapp on EVM only needs SECP256K1 → user picks just that. multi-chain dapps need both.

internal: `chromatika_dapp_permissions_v1` stores `{ origin, selectedSecpDwalletId, selectedEd25519DwalletId }` per origin.

## the strict consent mode

`dapp-consent-mode: 'strict'` makes bulk-sign primitives prompt per tx. compat (default) bundles them.

`getDappConsentMode()` / `setDappConsentMode(mode)` is the toggle.

## the address change event

when the user switches the active dWallet for a curve via `setActiveDwallet`, chromatika re-emits the `change` event to all connected origins:

```ts
features['standard:events'].emit('change', { accounts: newAccounts });
```

dapps that subscribe via `wallet.features['standard:events'].on('change', cb)` get notified.

## library

- `@wallet-standard/core` for the discovery + Wallet shape
- `@wallet-standard/wallet`, `@wallet-standard/base`, `@wallet-standard/features` for shared types
- `@mysten/wallet-standard` for Sui-specific features
- `@solana/wallet-standard-features` for Solana-specific features
- internal: `wallet-extension/src/dapp-interface/wallet-standard-register.ts` for Sui + Solana registration
- internal: `wallet-extension/src/dapp-interface/aptos-wallet-standard-register.ts` for Aptos (separate registration)

## related

- [eip-1193-and-6963.md](/library/tech/eip-1193-and-6963) - the EVM equivalent
- [dapp-bridge-message-validation.md](/library/tech/dapp-bridge-message-validation) - the page ↔ background boundary
- [sui-tx-sign-via-ika.md](/library/tech/sui-tx-sign-via-ika), [solana-tx-sign.md](/library/tech/solana-tx-sign) - what the features call into
- [sui-personal-message-divergence.md](/library/tech/sui-personal-message-divergence) - the BLAKE2b parity gap on Sui personal-message
