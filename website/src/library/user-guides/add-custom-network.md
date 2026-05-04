# how to add a custom network

extend chromatika's built-in registry with a custom EVM chain (or in principle, a custom Sui / Solana / Aptos / Bitcoin Esplora network when those custom-add paths surface in the API). the EVM custom-add flow includes Chainlist search-and-import as a shortcut.

## prerequisites

- a Chromatika vault is unlocked
- you know the network parameters for the chain you want to add
- the RPC URL is reachable and conforms to JSON-RPC (EVM) or the chain's native RPC

## options at a glance

- **manual EVM add**: full parameters supplied yourself
- **EVM Chainlist search**: type a chain name or chainId; the wallet searches Chainlist and fills params for you
- **non-EVM custom networks**: the architecture supports custom Sui / Solana / Aptos / Bitcoin Esplora networks via the same registry; today the surfaced custom-add procedure is EVM-specific

## how to add a custom EVM chain manually

1. submit `addCustomNetwork` with: `name`, `chainId` (decimal), `rpcUrl`, `symbol`, `decimals`, optional `explorerUrl`
2. the wallet validates the RPC by sending a `eth_chainId` probe; if the RPC returns a different chainId than declared, the call rejects
3. on success the network joins `chromatika_custom_networks_v1`; it's available everywhere the registry is read

## how to find a chain on Chainlist

1. submit `importFromChainlist` with `query` (a chain name string, partial match OK, or a chainId number)
2. response is the matching candidate set (read-only - no state changes)
3. once you've found the right chain, feed those parameters to `addCustomNetwork` to commit

## how to remove a custom EVM chain

1. submit `removeCustomNetwork` with `chainId`
2. the entry is dropped. if the removed chain was the active EVM chain, the wallet falls back to a default

## non-EVM custom networks

the registry supports per-chain types (Sui / Solana with `name + rpc`; Aptos `name + rpc`; Bitcoin `name + esplora url`) and architecture-final.html documents the schema. exposing add / remove for those via tRPC is in progress; check the latest router for `setActiveSuiNetwork` / `setActiveSolanaNetwork` / `setActiveBitcoinNetwork` / `setActiveAptosNetwork` networkIds the wallet currently knows about

## notes

- custom networks merge with built-ins under one logical registry per chain - the active selection works the same regardless of source
- bad RPCs that don't validate are rejected before persistence to keep the registry clean
- `getEvmRpcHealth` (see [manage-networks.md](/library/user/manage-networks)) checks the active EVM RPC, which can include any custom-added chain you're using
- the architecture's "EVM shortcut: chainlist" is the read-only search path; you still commit via `addCustomNetwork` once you've picked
