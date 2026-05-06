# EVM transaction send flow

`sendEvmTx` (wallet-UI direct, no popup) and `approveTxRequest` (dapp `eth_sendTransaction` after popup approval) both end up at `signAndBroadcastEvm`. this doc traces the exact path: build with ethers v6, sign via ika MPC SECP256K1_ECDSA, broadcast via the active EVM provider.

## the call entrypoints

```ts
// wallet UI direct - no popup
sendEvmTx({ to, value, data, chainId? })
  → signAndBroadcastEvm

// dapp originated, after approveTxRequest
approveTxRequest({ id, gasOverrides? })
  → signAndBroadcastEvm
```

both produce the same broadcast result. **never** add an approval popup to the wallet-UI flow - the user is already inside the wallet making an intentional action.

## step-by-step

```ts
async function signAndBroadcastEvm({ to, value, data, chainId, gas, ... }) {
  // 1. resolve provider for the target chain (may differ from active chain)
  const { provider, chainId: providerChainId, rpcUrl } = chainId
    ? await getRpcProviderForChain(chainId)
    : await getRpcProvider();

  // 2. resolve sender address (active SECP256K1 dWallet's EVM address)
  const from = await getEvmAddress();

  // 3. fetch nonce + gas
  const nonce = await provider.getTransactionCount(from, 'pending');
  const feeData = gas ?? await provider.getFeeData();   // EIP-1559 maxFeePerGas + maxPriorityFeePerGas

  // 4. estimate gas if not provided
  const gasLimit = gas?.gasLimit ?? await provider.estimateGas({
    from, to, value, data,
  });

  // 5. construct unsigned transaction
  const tx = {
    type: 2,                                              // EIP-1559
    chainId: providerChainId,
    to,
    value: value ?? 0n,
    data: data ?? '0x',
    nonce,
    gasLimit,
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  };
  const txObj = Transaction.from(tx);                    // ethers v6
  const preimage = txObj.unsignedSerialized;             // RLP-encoded unsigned bytes

  // 6. sign via ika MPC SECP256K1_ECDSA
  const presignId = takePresign('SECP256K1_ECDSA');
  const sigBytes = await ikaSign({
    dwalletId: activeSecpDwalletId,
    curve: Curve.SECP256K1,
    algorithm: SignatureAlgorithm.ECDSASecp256k1,
    message: ethers.getBytes(preimage),                  // PREIMAGE, not digest
    presignId,
  });

  // 7. parse + recover v
  const { r, s } = parseSignatureFromSignOutput(sigBytes, Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1);
  const digest = keccak256(preimage);
  let v: 27 | 28 = 27;
  if (recoverAddress(digest, { r, s, v: 27 }).toLowerCase() !== from.toLowerCase()) {
    v = 28;
    if (recoverAddress(digest, { r, s, v: 28 }).toLowerCase() !== from.toLowerCase()) {
      throw new Error('signature does not recover to expected address');
    }
  }

  // 8. assemble final EIP-155 v: v + 35 + chainId * 2 (for typed-tx, this is encoded as parity bit)
  // ethers Transaction.from handles this when you set the signature
  txObj.signature = { r, s, v };
  const signedRaw = txObj.serialized;

  // 9. broadcast
  const txResp = await provider.broadcastTransaction(signedRaw);
  return { hash: txResp.hash, signedRaw };
}
```

## the preimage passthrough rule (again)

step 6 hands ika `txObj.unsignedSerialized` - the RLP-encoded unsigned tx bytes. ika keccak256s this internally and signs the digest. **never** pre-keccak the preimage; double-hashing breaks v-recovery.

## v-recovery dance

step 7 tries `v=27` and `v=28`. EVM's recovery byte distinguishes between the two y-candidates that satisfy `r`. ECDSA produces an ambiguous signature without v; we resolve by checking which candidate recovers to our known address.

if neither matches, something is wrong:

- preimage was double-hashed somewhere (bug)
- dWallet pubkey doesn't match the signature (network issue)
- ika returned malformed sig (rare)

we throw rather than guess.

## type 2 (EIP-1559) by default

post-London (Aug 2021), all major EVM chains support EIP-1559. chromatika defaults to type 2 transactions:

- `maxFeePerGas` (cap on total per-gas cost)
- `maxPriorityFeePerGas` (tip to validator)
- `chainId` baked into the tx (no EIP-155 v offset; the parity bit in v handles it instead)

legacy type 0 transactions (pre-EIP-1559) are supported for chains that don't have 1559 active. ethers v6's `Transaction.from` handles both.

## the wallet-UI vs dapp split

```
wallet UI (e.g. SendPage in side panel)
  → sendEvmTx tRPC procedure
  → signAndBroadcastEvm
  → broadcast, return hash

dapp page → eth_sendTransaction RPC
  → bridge enqueues TX_APPROVE pending request
  → opens popup at index.html?txapprove=<id>
  → popup calls getTxApprovalRequest, getTxSimulationPreview, getTxGasOptions
  → user clicks approve
  → tRPC calls approveTxRequest({ id, gasOverrides })
  → signAndBroadcastEvm
  → broadcast, return hash to dapp via bridge
```

both paths converge at `signAndBroadcastEvm`. the dapp path adds the popup gate; the wallet-UI path skips it because the user is already in the wallet.

## the gas-options helper

`getTxGasOptions({ id })` returns `{ slow, normal, fast }` presets:

```ts
async function getTxGasOptions({ id }) {
  const pending = await getPendingTx(id);
  const provider = await getRpcProviderForChain(pending.chainId);
  const feeData = await provider.getFeeData(); // current network fees

  return {
    slow: {
      maxFeePerGas: (feeData.maxFeePerGas * 80n) / 100n, // 80% of network estimate
      maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 80n) / 100n,
      estimatedSeconds: 60,
    },
    normal: {
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      estimatedSeconds: 30,
    },
    fast: {
      maxFeePerGas: (feeData.maxFeePerGas * 130n) / 100n,
      maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 130n) / 100n,
      estimatedSeconds: 12,
    },
    custom: null, // user supplies
  };
}
```

USD estimates derive from the price waterfall (see [price-waterfall-and-sources.md](/library/tech/price-waterfall-and-sources)).

## the simulation helper

`getTxSimulationPreview({ id })` runs an `eth_call` at the latest block:

```ts
async function getTxSimulationPreview({ id }) {
  const pending = await getPendingTx(id);
  const provider = await getRpcProviderForChain(pending.chainId);
  try {
    const result = await provider.call({
      from: pending.from,
      to: pending.to,
      value: pending.value,
      data: pending.data,
    });
    return { ok: true, returnData: result, decoded: tryDecodeReturnData(result, pending.data) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
```

best-effort decoding: if the function selector matches a known ABI, we decode the return data. otherwise raw hex. no third-party simulator.

## library

- `ethers` v6 `Transaction`, `keccak256`, `recoverAddress`, `getBytes`, `JsonRpcProvider`
- internal: `wallet-extension/src/background/chains/evm-send.ts` `signAndBroadcastEvm`, `getRpcProvider`, `getRpcProviderForChain`
- internal: `wallet-extension/src/background/ika/signing.ts` for ika sign dispatch

## related

- [evm-personal-sign-and-typeddata.md](/library/tech/evm-personal-sign-and-typeddata) - the message signing path
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput details
- [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1) - the underlying curve / sig math
