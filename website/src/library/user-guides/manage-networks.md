# how to manage active networks

chromatika ships a network registry per chain (EVM, Solana, Sui, Aptos, Bitcoin) plus user-added custom networks. you switch the active network per chain to control where balances, RPC calls, and dapp injection point. some chains (Sui, Solana) have a **two-tier** active network: vault-tier (the dWallet Vault's owner-key environment) and dWallet-tier (which network the active dWallet operates on).

## prerequisites

- a Chromatika vault is unlocked
- the desired network already exists in the registry (built-in) or has been added (see [add-custom-network.md](/library/user/add-custom-network))

## options at a glance

- **EVM**: single active chain by chain id
- **Solana** and **Sui**: vault-tier + dWallet-tier (two separate active networks per chain)
- **Aptos**: single active network
- **Bitcoin**: single active network (mainnet, testnet, signet)
- **ika base mode**: global preference for which chain anchors ika dWallets (Sui or Solana). gated for Solana behind `VITE_SOLANA_IKA_BASE=true`

## how to list every network

1. call `getNetworks`
2. response merges built-in registry with custom networks per chain, plus the active selection per chain and per tier where applicable

## how to switch active EVM chain

1. call `setActiveEvm` with the target `chainId`
2. wallet refreshes the EVM provider (`getRpcProvider`), re-reads gas / balance
3. dapp bridge emits `chainChanged` to connected EVM origins

## how to switch active Sui network (vault tier or dWallet tier)

1. call `setActiveSuiNetwork` with `networkId` and `tier: 'vault' | 'dwallet'`
2. vault tier changes which Sui environment the dWallet Vault's HD fee-payer operates in (mainnet / testnet / devnet)
3. dWallet tier changes the network the active Sui-base dWallet works against - separate from vault tier so you can fund on one and operate on another briefly

## how to switch active Solana network (vault tier or dWallet tier)

1. call `setActiveSolanaNetwork` with `networkId` and `tier: 'vault' | 'dwallet'`
2. solana base ika dWallets need the vault tier and dWallet tier set consistently for ika gRPC + chain ops to align. the wallet warns when they diverge in dev surfaces

## how to switch active Aptos network

1. call `setActiveAptosNetwork` with `networkId`

## how to switch active Bitcoin network

1. call `setActiveBitcoinNetwork` with `networkId` (mainnet / testnet / signet for built-ins, or any custom Esplora network you've added)
2. address derivation rebuilds for the new network (testnet vs mainnet bech32 prefix differs)

## how to switch ika base mode

1. call `getIkaBaseMode` to see current preference (`'sui' | 'solana'`)
2. call `setIkaBaseMode` with the new mode
3. **gating**: solana base requires `VITE_SOLANA_IKA_BASE=true` in the build. base-mode switching is also constrained by whether you have a vault on the target base chain - the wallet falls back to the nearest available chain if not

## how to check EVM RPC health

1. call `getEvmRpcHealth`
2. response is latency + recent success / error counts for the active EVM RPC
3. helpful when sends or balance reads are slow / failing

## notes

- network registry uses a Trust-Wallet-style `registry.json` schema for custom networks (per architecture-final.html)
- chromatika prefers `SuiGraphQLClient` (`client.core.*`) for any Sui call Mysten exposes on GraphQL. JSON-RPC is for legacy gaps only (e.g. activity feed today)
- the global ika base mode (`chromatika_ika_base_mode_v1`) is **not** the same as per-dWallet `baseChain`, but should stay consistent as the product matures
- two-tier active networks let you e.g. fund a Sui vault on mainnet while pointing the dWallet at testnet to avoid paying real fees in dev. once you understand the model, this is genuinely useful; until then, keep both tiers on the same network
