# how to send a transaction on EVM

send native ETH or any other EVM-native asset (and run any contract call you supply calldata for) from chromatika as the originating user. this is the **wallet UI flow** - direct broadcast, no dapp approval popup, since the user is already inside the wallet making an intentional action.

## prerequisites

- a Chromatika vault is unlocked
- the active dWallet has SECP256K1 (otherwise create one - see [create-dwallet.md](/library/user/create-dwallet))
- the active EVM network is the chain you intend to send on (see [manage-networks.md](/library/user/manage-networks))
- the EVM RPC for that network is reachable (`getEvmRpcHealth` returns success)
- the active dWallet has enough native balance to cover `value + gas`
- on the dapp side: this guide is for `sendEvmTx` - if the request originates from a dapp's `eth_sendTransaction`, see [approve-dapp-tx.md](/library/user/approve-dapp-tx) instead

## options at a glance

- **chain**: any EVM network the wallet knows (built-in or custom). `chainId` argument is optional - defaults to the active EVM chain
- **value**: hex-encoded wei
- **data**: hex-encoded calldata for contract calls (omit for plain transfers)
- **gas overrides**: managed at sign time via the standard EVM gas semantics; for dapp-initiated tx, use the approval flow's slow / normal / fast / custom presets

## how to send a plain native transfer

1. read your active EVM address with `getEvmAddress` and confirm the source
2. submit `sendEvmTx` with: `to` (recipient), `value` (hex wei), optionally `chainId`
3. background runs `signAndBroadcastEvm` directly - no popup, signs via ika MPC against the SECP256K1 dWallet, broadcasts on the active EVM RPC
4. tx hash returns synchronously (subject to RPC latency)

## how to send ERC20 tokens

transfer any ERC20 token (USDC, USDT, WETH, ARB, etc.) from the active dWallet's EVM address.

### prerequisites (in addition to the general prerequisites above)

- the active dWallet's EVM address holds a balance of the ERC20 token
- the address has enough native ETH (or chain-native gas token) to cover gas for the contract call

### from the wallet UI

1. from the send page, select the ERC20 token from the token dropdown (the wallet fetches token balances via `getEvmTokenBalances` - includes Alchemy shortcut, curated lists, and watched tokens)
2. enter the recipient address and amount in human-readable units (decimal handling uses the token's `decimals` value, e.g. 6 for USDC, 18 for WETH)
3. the wallet constructs the ERC20 `transfer(address,uint256)` calldata internally and submits via `sendEvmTx` with `to` set to the contract address and `value` set to `0x0`

### manually (agent / programmatic)

1. encode the ERC20 `transfer(address,uint256)` calldata: selector `0xa9059cbb` + ABI-encoded `(recipient, amountInBaseUnits)`
2. submit `sendEvmTx` with: `to` (the **token contract** address, not the recipient), `value` (`0x0`), `data` (the calldata hex), optional `chainId`
3. same direct sign + broadcast path as native sends

### notes on ERC20 sends

- token balances are cached per address + chainId with a 60-second TTL
- Arbitrum has a curated token list (WETH, USDC, USDT, ARB) that shows balances even without Alchemy
- Alchemy `DEFAULT_TOKENS` integration provides broader token discovery when `VITE_ALCHEMY_KEY` is set
- `approve` / `transferFrom` patterns (e.g. for dapp allowances) go through the dapp bridge, not the wallet UI send flow

## how to send an arbitrary contract call

1. craft calldata for the function you want
2. submit `sendEvmTx` with: `to` (the contract address), `value` (`0x0` for non-payable calls, or hex wei for payable), `data` (the calldata hex), optional `chainId`
3. same direct sign + broadcast path

## how to use a different EVM chain than the active one

1. pass `chainId` explicitly to `sendEvmTx`
2. background looks up the matching RPC + provider via `getRpcProviderForChain` (separate from `getRpcProvider` which always uses the active chain)
3. ensures the tx broadcasts on the chain you intend, even if the active EVM chain is something else

## how to query gas options for a tx

for a pending dapp `eth_sendTransaction`, the approval flow exposes preset slow / normal / fast / custom gas options via `getTxGasOptions` plus a simulated output via `getTxSimulationPreview` (eth_call at latest block, no third-party API). the wallet UI flow does not stop on a popup - if you want to inspect gas first, use the approval-flow utilities yourself before submitting

## notes

- `sendEvmTx` from the wallet UI is **not** gated by an approval popup. **never add an approval popup to this flow** - the user is already inside the wallet UI making an intentional action
- the dapp `eth_sendTransaction` path does open a popup - that's [approve-dapp-tx.md](/library/user/approve-dapp-tx)
- ika ECDSA signing uses preimage passthrough: chromatika hands ika `tx.unsignedSerialized` and lets ika hash with KECCAK256 once. if you write your own EVM signing on top of ika, use `parseSignatureFromSignOutput` (`Curve.SECP256K1`, `SignatureAlgorithm.ECDSASecp256k1`) and pick `v` via `recoverAddress(keccak256(unsignedSerialized), …)` trying 27 vs 28
- on Solana base, EVM SECP signing is gated by `assertNotSolanaBaseForSecpSigning` today (sui-base only). re-validate when Solana-base SECP parity ships
- there's no separate "plain HD" EVM path for sends - the dWallet is the canonical EVM identity
