# Policy Vault v1.5: send-path integration plan

> status: 2026-05-01: **EVM + BTC + DeSo dispatch shipped, EVM hard-policy (Move RLP decoder) shipped, audit log shipped**; PC-Token / Solana ika base deferred to v2. The full SECP signing surface (`signBytesEvm`, `signBitcoinTxSighashPreimage`, and via that DeSo's `signAndSubmitDeSoTransactionHex`) routes through `chromatika_policy::sign_gate::sign_with_policy` (soft) or `sign_gate_evm::sign_evm_with_policy` (hard, EVM only) when the active vault is policy-gated. Wallet-UI signing for EVM, BTC, and DeSo all work post-opt-in. EVM tx signs use HARD policy (chain-decoded value); BTC + DeSo + EVM message-sign use SOFT policy. Per-vault audit log mirrors every policy decision client-side. PC-Token is on Solana ika base which uses `authority: Pubkey` instead of `DWalletCap`; tracked in POLICY_VAULT.md "Solana ika base" caveat as v2 work.

## What v1.5 EVM dispatch ships (2026-05-01)

- **`policy-vault-presigns.ts`**: per-vault local cache of presign cap object ids (`chromatika_policy_presigns_v1_<vaultId>`). Move uses `pop_back` (LIFO); chromatika appends on replenish, pops from the end on sign. Stays in sync via `resyncPolicyPresignsFromChain`.
- **`policy-vault-sign.ts`**: `signBytesSecpThroughPolicy({message, hashScheme, declaredValueMicros})` mirrors `signBytesEvm`'s return shape. Pops presign cap id from the local cache (auto-replenish + resync if empty), reads the cap object's inner `presign_id`, fetches presign bytes via `getPresignInParticularState`, decrypts the user share via `keys.decryptUserShare`, computes `messageCentralizedSignature`, builds the chained PTB `pop_presign(vault) -> sign_with_policy(vault, coord, popped, message, declaredValue, hash, msgSig, clock)`, executes via `executeSuiTransaction`, polls for the Sign session Completed, parses + returns 64-byte signature hex.
- **`policy-vault-evm-value.ts`**: `resolveEvmDeclaredValueMicros(unsignedTxBytes)` parses the RLP-encoded unsigned EVM tx via ethers, pulls `tx.value` (wei), looks up ETH/USD via `getPrice('eth')`, returns micro-USD with u64 saturation. Returns 0n on parse failure or non-native sends (ERC-20 calldata reports value=0; tracked in v1 hard-decoder for ABI-aware extraction).
- **`signBytesEvm` dispatch**: at the top of the function, calls `shouldDispatchThroughPolicy()` → `signBytesSecpThroughPolicy(...)` when the active vault has a PolicyVault link. New optional `declaredValueMicros` param lets callers pass the resolved USD value; defaults to 0 for message-sign flows (personal_sign, EIP-712 typed-data, dapp signing).
- **`signAndBroadcastEvm` dispatch**: both ledger-fee-payer and ika-fee-payer branches resolve `declaredValueMicros` via `resolveEvmDeclaredValueMicros(unsignedBytes)` and pass it through.
- **UI banner**: `PolicyVaultBanner` mounted at the top of the SendPage. Shows "policy-gated · daily cap remaining: $X · spent: $Y / $Z". When panicked, shows red "PANICKED" banner with countdown to unfreeze. Polls every 8s for live state.
- **Tests**: `policy-vault-evm-value.test.ts` covers wei→micro-USD math (zero, low-value, fractional price, u64 saturation, truncation).

## What's next (BTC + DeSo follow-ups)

**BTC dispatch** (~1 day): mirror EVM. `signBitcoinTxSighashPreimage` checks `shouldDispatchThroughPolicy` and dispatches with `hashScheme: Hash.DoubleSHA256`. Declared value resolver: parse PSBT outputs, sum the satoshi amounts being sent (excluding change), `* btc_price`. The `btc-send-native.ts` caller computes from the form's `amountSats` field directly — no need to re-parse PSBT.

**DeSo dispatch** (~1 day): mirror EVM. `signAndSubmitDeSoTransactionHex` checks `shouldDispatchThroughPolicy` and dispatches with `hashScheme: Hash.DoubleSHA256`. Declared value resolver: read `amountNanos` from the construct request, `* deso_price / 1e9`. DeSo derived-key flow piggybacks naturally — when chromatika is signing as the owner via delegation, the cap still applies to chromatika's spending, not the owner's.

**PC-Token** (deferred to Solana ika v2): PC-Token wrap/transfer/unwrap signs via Solana ika SECP path which uses `authority: Pubkey` (not `DWalletCap` object). Requires a separate Solana program that PDA-owns the authority and mirrors the policy module's logic. Tracked in POLICY_VAULT.md "Solana ika base" caveat.

## Original plan (preserved for reference)

## What v1.5 unblocks

After opt-in today, the wrapped dWallet cap lives inside the shared `PolicyVault` object. chromatika's existing `signAndBroadcastEvm` / `signBytesBitcoinNative` / `signAndSubmitDeSoTransactionHex` / PC-Token wrap-transfer-unwrap call `coordinator.approve_message(&dwallet_cap, ...)` directly with a cap reference they no longer have access to. Signing fails. POLICY_VAULT.md tells users to opt in only on a vault they can rebuild from a backup.

v1.5 adds a dispatch layer: when `getPolicyVaultLink(activeVaultId)` is set, route through `chromatika_policy::sign_gate::sign_with_policy` (which the v1 Move refactor now accepts a presign cap as an arg, so PTB chains `pop_presign(vault) -> sign_with_policy(vault, coord, presign_cap, ...)` in one tx).

## Plan

### Phase 1: presign-id local tracker

New module: `wallet-extension/src/background/policy-vault/policy-vault-presigns.ts`

```ts
const STORAGE_KEY_PREFIX = 'chromatika_policy_presigns_v1_';
// Keyed by chromatikaVaultId; stores an ordered list of UnverifiedPresignCap object ids
// matching the on-chain vault.presigns vector. Move uses pop_back (LIFO); chromatika
// pushes on replenish, pops from the end on sign. Cache stays in sync because both
// directions are observed at tx-success time.

export async function appendPolicyPresignId(vaultId, capObjectId): Promise<void>
export async function popPolicyPresignId(vaultId): Promise<string | null>
export async function listPolicyPresignIds(vaultId): Promise<string[]>
export async function syncPolicyPresignIdsFromChain(vaultId): Promise<void>  // recovery path
```

`replenishPolicyPresign` in `policy-vault-actions.ts` is updated to:
1. Execute the replenish PTB
2. Parse `objectChanges` for the new `UnverifiedPresignCap` object id (by `objectType` ending in `coordinator_inner::UnverifiedPresignCap`)
3. Append to local cache

`syncPolicyPresignIdsFromChain` reads the vault object's `presigns: vector<UnverifiedPresignCap>` field, extracts each cap's object id, and replaces the local cache. Used as recovery if local state drifts (e.g. chromatika reinstall).

### Phase 2: signSecpThroughPolicy helper

New module: `wallet-extension/src/background/policy-vault/policy-vault-sign.ts`

```ts
export async function signBytesSecpThroughPolicy(input: {
  message: Uint8Array;
  hashScheme: Hash;        // KECCAK256, SHA256, DoubleSHA256
  declaredValueMicros: bigint;  // best-effort; v1 will be replaced by hard-decoder Move modules
}): Promise<{ signature: string; signId: string }> {
  // 1. Resolve session + policy vault link + assert not panicked
  // 2. Pop a presign id from the local cache (auto-replenish if empty)
  // 3. Fetch the presign object via ikaClient.getPresignInParticularState(presignId, 'Completed')
  // 4. Compute messageCentralizedSignature via createUserSignMessageWithPublicOutput
  // 5. Build PTB: pop_presign(vault) -> sign_with_policy(vault, coord, popped, message, declaredValue, hash, msgSig, clock)
  // 6. Execute via executeSuiTransaction
  // 7. Resolve sign session id from effects + poll for Completed
  // 8. Parse signature bytes; return as 64-byte hex
}
```

The shape mirrors `signBytesEvm`'s return so callers can swap in transparently.

### Phase 3: send-path dispatch

A thin shim helper added to each chain's signing path. Pattern:

```ts
// In chains/signing/evm.ts
export async function signBytesEvm(msgBytes, chainId, opts) {
  const session = getSession();
  if (!session) throw new Error('Wallet locked');
  const { getPolicyVaultLink } = await import('@/background/policy-vault/policy-vault-storage');
  const link = await getPolicyVaultLink(session.activeVaultId);
  if (link) {
    // Dispatch through policy module
    const { signBytesSecpThroughPolicy } = await import('@/background/policy-vault/policy-vault-sign');
    return signBytesSecpThroughPolicy({
      message: msgBytes,
      hashScheme: Hash.KECCAK256,
      declaredValueMicros: await resolveEvmDeclaredValueMicros(msgBytes, chainId),
    });
  }
  // ... existing direct-sign path
}
```

Same dispatch added to:
- `chains/signing/btc.ts` `signBitcoinTxSighashPreimage` (hashScheme: DoubleSHA256)
- `chains/deso/deso-send.ts` `signAndSubmitDeSoTransactionHex` (hashScheme: DoubleSHA256)
- `chains/pc-token/...` (uses signBytesEvm-equivalent SECP path)

### Phase 4: declared-value resolvers

Each chain has a helper that converts message bytes -> USD value for the soft-policy cap:

- **EVM**: parse RLP client-side (or via a Move hard-decoder on-chain; see Tier 3 in STATUS.md). For native sends: `value_wei * eth_price_usd`. For ERC-20 transfers (calldata starts with `0xa9059cbb`): decode `(to, amount)` + lookup token's price by mint. For arbitrary contract calls: declare 0 and rely on cap = "I'm OK with N USD/day going to UNKNOWN destinations."
- **BTC**: parse PSBT outputs; sum amounts; `* btc_price_usd`.
- **DeSo**: `amountNanos * deso_price_usd / 1e9`.
- **PC-Token wrap**: 0 (no value movement, just SPL -> pcSPL).
- **PC-Token transfer**: `amount * underlying_price`.
- **PC-Token unwrap step 1 (decrypt)**: 0 (request only); step 2 (drain): `amount * underlying_price`.

Price resolution uses chromatika's existing `priceService` waterfall (CoinGecko -> DefiLlama -> CMC -> Pyth -> Chainlink -> DEX TWAP).

### Phase 5: UI banner + cap-aware UX

Send pages (SendPage.tsx, DeSoPanel send form, PrivateBalancesPage) detect `getPolicyVaultLink(activeVaultId)` and show:

```
> 🔒 policy-gated · daily cap: $50 · spent: $5 · remaining: $45
```

Above-cap pre-check: form disables submit if the planned tx would breach the cap, with friendly copy: "this would exceed your $50/day on-chain cap. Increase the cap in Settings -> Security or wait until tomorrow."

### Phase 6: rescue-sign UX

When the vault is panicked, the same send pages show a "rescue mode" banner. Recipient field locks to the pre-registered rescue address. Submit calls `rescue_sign` (which uses `pop_presign_for_rescue` internally; the v1 Move refactor exposes this). Drains residuals to safety with one click.

### Phase 7: tests

- Unit: PTB shape tests for the dispatched calls (similar to `policy-vault-tx.test.ts`).
- Integration: chromatika dev install + deployed Move package + a small EVM testnet send through the policy. Document deploy + opt-in steps in POLICY_VAULT.md (already done).
- Regression: ensure direct-sign still works for vaults that haven't opted in.

## Estimate

3-5 days for Phase 1-3. Another 1-2 days for Phase 4 declared-value resolvers across all chains. 1 day for Phase 5/6 UX. 1-2 days for Phase 7 tests + deploy verification. **~1 week total** for a polished, tested v1.5 ship.

## Why this is deferred from the v0/v1 slice

The send-path integration touches every signing surface (EVM dapp, BTC, DeSo, PC-Token, Bitcoin Ledger, EVM Ledger, etc.) and needs deploy-time validation against a real Move package. Shipping it without on-chain integration testing would leave users with broken signing on opted-in vaults. Better to ship the v0/v1 panel + Move package + cross-feature wiring (Tier 2A/2B/2C) and clearly mark opt-in as "v1.5 will wire signing" until the integration is tested.

## Related

- [`POLICY_VAULT.md`](POLICY_VAULT.md): v0 architecture + Move package + deploy runbook
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index
