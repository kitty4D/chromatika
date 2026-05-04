# how to approve a dapp transaction

when a connected dapp calls `eth_sendTransaction`, chromatika queues the request and opens an approval popup. this guide is the user side of that approval - reviewing the request, choosing gas, simulating, and approving or rejecting.

## prerequisites

- a Chromatika vault is unlocked
- the dapp origin has an existing connection permission with at least one EVM dWallet selected (see [connect-dapp.md](/library/user/connect-dapp))
- the active dWallet has SECP256K1 and SOL / native gas funds for the chain

## options at a glance

- **gas presets**: slow, normal, fast, custom (EIP-1559 or legacy depending on chain)
- **simulation**: eth_call at the latest block, no third-party simulator
- **outcome**: approve (sign + broadcast) or reject

## how to fetch the pending dapp tx

1. when a dapp calls `eth_sendTransaction`, the wallet enqueues the tx and opens `index.html?txapprove=<id>`
2. the popup calls `getTxApprovalRequest` with the id to read: `from`, `to`, `value`, `data`, `chainId`, the requesting origin

## how to view a simulated outcome

1. call `getTxSimulationPreview` with the id
2. response is the eth_call result at latest block - decoded if the wallet recognizes the function selector (no third-party API; honest about its limitations on opaque calldata)

## how to view gas presets

1. call `getTxGasOptions` with the id
2. response is { slow, normal, fast } per EIP-1559 (or the legacy equivalent), with USD estimates derived from the price waterfall (see [price-source-priority.md](/library/user/price-source-priority))
3. user picks one or supplies a custom override

## how to approve

1. submit `approveTxRequest` with the id and optional gas overrides (`maxFeePerGas`, `maxPriorityFeePerGas` for 1559 chains, or `gasPrice` for legacy)
2. background runs `signAndBroadcastEvm` against the dapp's selected dWallet, returns the tx hash to the dapp through the bridge
3. popup closes

## how to reject

1. submit `rejectTxRequest` with the id and a `reason` string
2. dapp receives a JSON-RPC error 4001 (user rejected request)

## notes

- the wallet-UI `sendEvmTx` flow is separate and **does not** open this popup. only dapp-originated tx do. **never wire wallet-ui sends through this popup** - the user is already in the wallet making an intentional action
- if the user disconnects the dapp permission while a tx is pending (see [manage-dapp-permissions.md](/library/user/manage-dapp-permissions)), the pending request rejects automatically
- gas estimation uses the active EVM provider (`getRpcProvider`); if the chain in the request differs from the wallet's active EVM chain, the wallet uses `getRpcProviderForChain`
- simulation is "best effort" - opaque contract calls may not decode cleanly. always verify recipient + value before approving
