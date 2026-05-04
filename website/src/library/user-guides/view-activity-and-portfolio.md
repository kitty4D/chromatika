# how to view activity and portfolio

see your transaction history across chains, balance overview, EVM token balances, and per-chain receive addresses. these are read-only queries.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet has dWallets / addresses on the chains you want to read
- relevant API keys for fully populated lists (EVM tokens via the active provider; NFTs via Alchemy / Helius; ordinals via Hiro)

## options at a glance

- **activity feed**: aggregated multi-chain tx history (`getActivity`)
- **portfolio rail balances**: native balances per chain rail (`portfolioRailBalances`)
- **dWallet home gas**: native gas balance for each dWallet (`getDwalletHomeGas` single, `getDwalletHomeGasMany` batch)
- **EVM token balances**: ERC20 balances for an address on a chain (`getEvmTokenBalances`)
- **balance summary**: aggregated balances + price data (`balances`)
- **per-chain addresses**: getEvmAddress, getSolanaAddress, getAptosAddress, getBtcAddresses
- **dWallet address book**: active addresses for both curves on the active vault (`dwalletAddressBook`); per-dWallet chain addresses (`getDwalletChainAddresses`)

## how to view activity

1. call `getActivity` with optional `limit` (1-50, default 20)
2. response is the recent multi-chain tx list - aggregated Sui, Solana, EVM activity sorted by time
3. Sui activity still reads via `SuiJsonRpcClient.queryTransactionBlocks` because GraphQL doesn't yet expose a filtered / address-scoped list equivalent (tracked future on a Mysten SDK bump)

## how to view portfolio rail balances

1. call `portfolioRailBalances` with `rail` (one of `sui`, `solana`, `aptos`, `btcP2wpkh`, `btcP2tr`) and `address`
2. response is a single-rail snapshot with native balance for the address on the active network

## how to view dWallet gas balance

- single: `getDwalletHomeGas` with `dwalletId` - returns home row + BTC / EVM / SOL balances for the dWallet
- batch (up to 48 dWallets): `getDwalletHomeGasMany` with `dwalletIds` (array of length 1-48). **long-running** mutation (20s keepalive) since it sequences per dWallet

## how to view EVM token balances

1. call `getEvmTokenBalances` with `address` and `chainId`
2. response is the list of ERC20 balances for that address on that chain

## how to view aggregated balance summary

1. call `balances` for the active vault
2. response includes balances + price data (uses the price waterfall - see [price-source-priority.md](/library/user/price-source-priority))
3. funding readiness flag (`funding.ready`) is consumed by surfaces that need to know "is the vault topped up enough for ika ops"

## how to view receive addresses

- EVM: `getEvmAddress` (returns EIP-55 checksummed)
- Solana: `getSolanaAddress` (base58)
- Aptos: `getAptosAddress` (hex)
- Bitcoin: `getBtcAddresses` with `network` (`'mainnet' | 'testnet'`) - returns both P2WPKH and P2TR
- both curves on active vault: `dwalletAddressBook` - returns SECP256K1 (EVM + BTC) and ED25519 (Sui + Solana + Aptos) addresses
- specific dWallet: `getDwalletChainAddresses` with `dwalletId` - returns BTC, EVM, Solana, Sui, Aptos addresses for that dWallet

## notes

- activity is "best-effort multichain" - some chains may return empty if the underlying indexer is rate-limited or down. each chain reports independently
- batch dWallet gas reads are slow on purpose (sequenced) to avoid hammering RPCs from a worker
- per the project rule, addresses + tx digests in read-only UI link to chain explorers via `ExplorerValueRow` with copy-to-clipboard - the same data exposed by these tRPC reads drives those links
