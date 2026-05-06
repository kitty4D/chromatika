# on-chain policy vault (Sui Move + Solana Anchor)

chromatika's `PolicyVault` is the on-chain enforcement layer for "the wallet should not be allowed to sign whatever it wants." it ships as parallel implementations on **Sui base** (Move package `chromatika_policy`) and **Solana base** (Anchor program `chromatika-policy`). same struct shape, same error semantics, same TS dispatch shape. the user picks one based on their dWallet's `BaseChain`, opt-in is per dWallet.

deployment status as of this write-up: **neither package is deployed**. the Move package is built + tested at [`wallet-extension/move/chromatika-policy/`](../../wallet-extension/move/chromatika-policy/). the Anchor program is built locally at [`wallet-extension/solana/chromatika-policy/`](../../wallet-extension/solana/chromatika-policy/) but its `do_approve_message_cpi` is a `Ok(())` stub awaiting ika Solana **Alpha-1**. opt-in is gated on a configured package id / program id (see `Settings -> Security`). this guide describes the intended runtime behavior + the architecture as it stands locally.

## what the vault does

1. **wraps** the dWallet authority so chromatika cannot bypass policy:
   - Sui: ika `DWalletCap` is moved into a shared `PolicyVault` object. no module function returns `DWalletCap` by value -> the cap is private to this module forever after opt-in. direct `coordinator.approve_message(&dwallet_cap, ...)` from the user's address is no longer possible
   - Solana: dWallet authority transfer to a Program-Derived Address `[b"chromatika-policy-v1", sha256(dwallet_pubkey)]` so only the policy program can sign for it via PDA seed. (the actual transfer awaits Alpha-1 of ika Solana; pre-alpha vaults persist all state but the on-chain authority is unchanged)
2. **gates every sign** behind cap + cool-down + actuator + non-panicked checks
3. **panic** flag with delayed unfreeze - any actuator can freeze, no one can unfreeze inside the delay window
4. **rescue path** - while panicked, sign back to a pre-registered rescue address only
5. **multi-actuator** - up to 16 addresses authorized to panic / unfreeze / sign / tune. enables social recovery, alerts feeds, automated panic on safety alerts

## struct shape (parity Sui + Solana)

| field                                                             | type                                     | meaning                                                                     |
| ----------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `dwallet_cap` (Sui) / `dwallet_pubkey_hash` (Solana)              | `DWalletCap` / `[u8; 32]`                | wrapped cap (Sui) or PDA seed component (Solana)                            |
| `presigns` (Sui only)                                             | `vector<UnverifiedPresignCap>`           | per-vault presign pool                                                      |
| `dwallet_network_encryption_key_id` / `network_encryption_key_id` | `ID` / `Pubkey`                          | needed for global presign requests                                          |
| `curve` + `signature_algorithm`                                   | `u32` / `u16`                            | pinned at opt-in; one PolicyVault per `(curve, sig_algo)`                   |
| `daily_cap_micros`                                                | `u64`                                    | rolling 24h ceiling, micro-USD. `0` = no cap                                |
| `spent_today_micros`                                              | `u64`                                    | sum of declared / decoded values today                                      |
| `epoch_day`                                                       | `u64`                                    | day index (timestamp_ms / 86_400_000); rollover resets `spent_today_micros` |
| `cool_down_ms`                                                    | `u64`                                    | min ms between successive signs                                             |
| `last_sign_at_ms`                                                 | `u64`                                    | wall-clock anchor for cool-down                                             |
| `panicked`                                                        | `bool`                                   | freeze flag                                                                 |
| `panic_at_ms`                                                     | `u64`                                    | wall-clock of the panic. `unfreeze` is gated until `+ unfreeze_delay_ms`    |
| `unfreeze_delay_ms`                                               | `u64`                                    | UI default 7 days; floor `0` so the user has full control                   |
| `actuators`                                                       | `vector<address>` / `Vec<Pubkey>`        | authorized addresses (max 16 on Solana)                                     |
| `rescue_address_bytes`                                            | `Option<vector<u8>>` / `Option<Vec<u8>>` | optional pre-registered drain destination                                   |
| `stage_cap_raises`                                                | `bool`                                   | opt-in: cap raises wait `stage_delay_ms`                                    |
| `pending_cap_micros` + `pending_cap_at_ms`                        | staged cap raise + commit time           |
| `pending_stage_off` + `pending_stage_off_at_ms`                   | staged "turn staging off" toggle         |
| `stage_delay_ms`                                                  | `u64`                                    | configurable (default 24h via TS); the staging delay                        |
| `ika_balance` + `sui_balance` (Sui only)                          | `Balance<IKA>` / `Balance<SUI>`          | fee storage for sign + presign + rescue                                     |

Solana side adds `bump: u8` for PDA address re-derivation, lacks `presigns` (each Solana sign requests presign per-call, see [`ika-presign-pool-impl.md`](/library/tech/ika-presign-pool-impl)) and lacks the `ika_balance / sui_balance` fields (the actuator pays SOL rent + ika fees per the Solana ika gRPC fee-payer mechanism).

## the soft sign flow (`sign_with_policy`)

both bases share the soft-policy v0 path. caller declares the message value in micro-USD; module enforces the daily cap on declared values. lying caller bypasses the numeric cap but leaves an immutable audit trail in the `PolicySigned` event.

```
1. assert sender in actuators
2. assert !panicked
3. lazy_commit_pending(now_ms)   // flushes any staged cap raise / stage-off whose delay has elapsed
4. assert now_ms >= last_sign_at_ms + cool_down_ms
5. roll daily bucket: today = now_ms / 86_400_000; if today != epoch_day, reset spent_today_micros
6. if daily_cap_micros > 0: assert spent_today_micros + declared_value_micros <= daily_cap_micros
7. coordinator.verify_presign_cap(presign_cap)   // Sui only; Solana CPI's per-call
8. coordinator.approve_message(&dwallet_cap, sig_algo, hash_scheme, message)
9. coordinator.request_sign_and_return_id(verified_presign, approval, msgSig, session, &mut ika, &mut sui)
10. spent_today_micros += declared_value_micros
11. last_sign_at_ms = now_ms
12. emit PolicySigned event
```

on Solana base today, step (9) is a `do_approve_message_cpi(...)` stub that prints `[chromatika-policy] PRE-ALPHA: ...` and returns `Ok(())`. when ika Solana Alpha-1 ships a CPI target for "approve message under caller-PDA-as-authority," that body flips to a real `invoke_signed`.

aborts: `ENotActuator` (1), `ECapExceeded` (2), `ECoolDownActive` (3), `EPanicked` (4) on Sui; same names + numbers on Solana via `PolicyError`.

## the hard-policy decoders (Sui only today)

soft policy trusts the caller's declared value. hard-policy variants decode the actual tx bytes on chain in Move, so the cap is enforced against the **chain-derived** value - a lying chromatika can't bypass the cap by claiming "$0":

### `sign_gate_evm::sign_evm_with_policy`

decodes Legacy + EIP-1559 + EIP-2930 RLP transactions:

```
0xff (legacy): RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0])
0x01 (EIP-2930): 0x01 || RLP([chainId, nonce, gasPrice, gasLimit, to, value, data, accessList])
0x02 (EIP-1559): 0x02 || RLP([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList])
```

walks the RLP outer list to the `to` and `value` fields, reads them, computes `value_micros = floor(value_wei * price_micros_per_eth / 1e18)` using a caller-supplied price (chromatika resolves ETH/USD via the price service before building the PTB). emits `EvmDecoded { tx_type, to, value_wei, value_micros, price_micros_per_eth }` then delegates to soft `sign_with_policy` with `value_micros` substituted for `declared_value_micros`. EIP-4844 (blob) and EIP-7702 abort `EUnsupportedTxType (101)`.

reference: ethereum yellow paper appendix B, EIP-2718, EIP-1559, EIP-2930.

### `sign_gate_btc::sign_btc_with_policy`

decodes the BIP143 witness-v0 sighash preimage. layout:

```
[ nVersion(4) | hashPrevouts(32) | hashSequence(32) | outpoint(36)
  | scriptCodeLen(varint) | scriptCode(scriptCodeLen)
  | amount(8 LE) | nSequence(4) | hashOutputs(32) | nLocktime(4) | nHashType(4) ]
```

skips to the `amount` field via `PREFIX_LEN + OUTPOINT_LEN + read_compact_size(scriptCodeLen) + scriptCodeLen`, reads 8 bytes LE, computes `value_micros = floor(value_sats * price_micros_per_satoshi)` using a caller-supplied per-sat price, emits `BtcDecoded`, delegates to soft.

cap is enforced on **input** value (the UTXO being spent), not output value. input >= output (the diff is the fee), so the cap is at worst slightly conservative. matches how a BTC user thinks about "how much value am I authorizing chromatika to spend."

reference: [BIP143](https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki).

### `sign_gate_deso::sign_deso_with_policy`

decodes the v0 DeSo binary tx, sums `TxOutputs.AmountNanos`. layout:

```
Inputs(varint-count + N×(TxID[32] + uvarint(Index)))
Outputs(varint-count + N×(PublicKey[33] + uvarint(AmountNanos)))
Metadata: uvarint(type) + uvarint(size) + metaBytes
PublicKey: VarBuffer (uvarint-len + bytes)
ExtraData: VarBuffer (uvarint-len + bytes)
Signature: VarBuffer (uvarint-len + bytes; usually `00` placeholder pre-sign)
```

sums output `AmountNanos` (Go-style uvarint per output), computes `value_micros = floor(output_sum_nanos * price_micros_per_deso / 1e9)`, emits `DeSoDecoded { output_sum_nanos, largest_output_nanos, output_count, value_micros, price_micros_per_deso }`, delegates to soft.

cap is enforced on the **sum** of outputs (= input value - fee), which includes any change going back to the sender. trade-off "simple + safe" over "perfectly precise but parses pubkey identity." `largest_output_nanos` lets off-chain auditors recover the "real" send amount.

honesty model on all three: **HARD on value** (decoded from the bytes), **SOFT on price** (caller-supplied; emitted on chain so any lie is auditable). v2 pulls price on chain via Pyth.

Solana base does not yet have hard-policy variants because soft `sign_with_policy` itself is the pre-alpha CPI stub.

## panic + unfreeze with delay

```
panic(self, clock, ctx):
  assert sender in actuators
  if !panicked:
    panicked = true
    panic_at_ms = clock.timestamp_ms()
    emit PanicTriggered { vault_id, dwallet_id, actuator, panic_at_ms, unfreeze_delay_ms }
```

- any actuator can panic. idempotent if already panicked
- effects: every `sign_with_policy` (and every hard-policy variant) aborts with `EPanicked`. every setter that mutates security state (`add_actuator`, `remove_actuator`, `set_daily_cap`, `set_cool_down`, `set_rescue_address`, `set_stage_cap_raises`, `set_stage_delay_ms`) also aborts. the only paths still working are `rescue_sign` (Sui), `unfreeze` (after delay), and `add_ika_balance` / `add_sui_balance` (top-ups always safe)

```
unfreeze(self, clock, ctx):
  assert sender in actuators
  assert panicked
  assert clock.timestamp_ms() >= panic_at_ms + unfreeze_delay_ms
  panicked = false
  panic_at_ms = 0
  emit UnfrozeTriggered { ... }
```

unfreeze gating prevents an attacker who triggered the panic from immediately undoing it. UI default `unfreeze_delay_ms = 7 days`; the Move floor is `MIN_UNFREEZE_DELAY_MS = 0` so the user has full control (explicit choice never overridden by the module).

## rescue path (Sui base today)

while panicked:

```
rescue_sign(self, coordinator, presign_cap, message, decoded_recipient_bytes, hash_scheme, msgSig, ctx):
  assert sender in actuators
  assert panicked
  assert rescue_address_bytes.is_some()
  assert *rescue_address_bytes.borrow() == decoded_recipient_bytes   // soft v0; v1 decodes from message
  // (no cap check, no cool-down)
  withdraw payment coins
  verify presign cap
  approve_message + request_sign
  emit RescueSigned { ..., rescue_dest, actuator }
```

bypasses the daily cap and cool-down. `decoded_recipient_bytes` is caller-declared in v0; v1 will pull the recipient from the message via a per-chain decoder (parallel to the EVM / BTC / DeSo hard-policy modules above).

`pop_presign_for_rescue` is a separate function so rescue can take a presign while panicked (the regular `pop_presign` aborts on panic).

`set_rescue_address` is intentionally **forbidden while panicked** so an attacker who triggered the panic cannot replace the rescue address with their own and drain via `rescue_sign`.

Solana base has the same `set_rescue_address` shape but the matching `rescue_sign` instruction lands once Alpha-1 ships the CPI target.

## actuators

`actuators: vector<address>` (Sui) / `Vec<Pubkey>` (Solana, capped at `MAX_ACTUATORS = 16`).

- the first actuator is set at opt-in to the user's primary chromatika address (Sui address on Sui base, Solana pubkey on Solana base)
- `add_actuator` requires sender already in actuators, forbidden while panicked, rejects duplicates with `EActuatorAlreadyExists`
- `remove_actuator` requires sender in actuators, forbidden while panicked, refuses to remove the last actuator (would orphan the vault: nobody could sign or panic)

design intent: the user can wire several independent panic triggers - chromatika UI, friend-and-family social recovery, chromatika-team auto-panic in response to safety alerts, SMS / email relayers. losing access to any one address still leaves panic + recovery available.

cross-feature notes:

- the **safety-alerts feed** uses the actuator slot: a chromatika-team Sui address is one of the user's actuators; a signed alert with `panicTargets` triggers an on-chain `panic` call
- on Sui, panic emits an event that chromatika's background worker watches to submit the matching DeSo `AuthorizeDerivedKey { OperationType: NotValid }` (revoking the derived key on the DeSo node)

## staging mechanism (lazy commit)

opt-in safety: cap **raises** stage behind `stage_delay_ms` (default 24h). cap **decreases** stay immediate (more conservative is always safe). turning staging OFF is itself staged (mirror semantics) so an attacker who flipped it on cannot disarm and drain. turning staging ON is immediate (turning protection on is always safe).

```
set_daily_cap(self, new_cap_micros, clock, ctx):
  assert sender in actuators; assert !panicked
  lazy_commit_pending(self, clock.timestamp_ms())
  prev = self.daily_cap_micros
  if !self.stage_cap_raises || new_cap_micros <= prev:
    // immediate path
    self.daily_cap_micros = new_cap_micros
    if self.pending_cap_micros.is_some(): drop pending  // decrease supersedes pending raise
    emit DailyCapChanged { prev, next }
  else:
    // staged raise
    if self.pending_cap_micros.is_some(): drop existing pending
    self.pending_cap_micros = some(new_cap_micros)
    self.pending_cap_at_ms = clock.timestamp_ms() + self.stage_delay_ms
    emit PendingCapStaged { prev, pending, commits_at_ms }
```

`lazy_commit_pending` runs at the top of `sign_with_policy` and at the top of every staging-related setter, so the user does not need a separate `commit_pending_cap` tx. `commit_pending_cap` and `commit_pending_stage_off` are exposed for UIs that want a "ready to commit" countdown + flush button.

`set_stage_delay_ms` v0: increases (more conservative) immediate; decreases when staging is on are emit-only - the user must explicitly toggle staging off to lower the delay (avoids an unbounded "queue several smaller delays then race them" attack). v1 may add a dedicated `pending_delay_ms` slot.

events for staging:

- `StageCapRaisesToggled { prev, next, staged_until_ms }` - on-toggle (`staged_until_ms = 0`) or off-toggle (= 0, off-toggle staging uses `PendingStageOffStaged` instead)
- `PendingCapStaged { prev, pending, commits_at_ms }`, `PendingCapCommitted { prev, next }`
- `PendingStageOffStaged { commits_at_ms }`, `PendingStageOffCommitted`
- `StageDelayChanged { prev, next, staged }`

## the pre-alpha CPI gap (Solana)

per the Solana ika pre-alpha disclaimer:

- Solana ika today uses a **single mock signer** (not distributed MPC); signatures are not real custody
- the Solana ika program + on-chain data **WILL BE WIPED** on Alpha-1
- the chromatika-policy program's `do_approve_message_cpi` is a `Ok(())` stub:

```rust
fn do_approve_message_cpi(_ctx, _args) -> Result<()> {
    msg!("[chromatika-policy] PRE-ALPHA: do_approve_message_cpi is a no-op stub. ika Solana Alpha-1 must expose a CPI target for caller-PDA-as-authority approve_message before this can produce real signatures.");
    Ok(())
}
```

what's still useful pre-Alpha-1:

- the full `PolicyVault` PDA shape mirroring the Sui Move struct
- all instructions (`wrap_authority`, `panic`, `unfreeze`, setters, staging entries) work + emit events + persist state
- pre-CPI policy enforcement (cap, cool-down, panic, actuator) runs identically
- storage-shape parity with the Sui side, so the chromatika TS dispatch can branch on `getDwalletMeta(activeVault).baseChain` and call the same logical setters with the same micro-USD / ms semantics

what changes when Alpha-1 lands:

- ika Solana exposes a CPI target (instruction discriminator + account list) for "approve message under caller-PDA-as-authority"
- replace the stub body with `invoke_signed(...)` against that target, passing the policy vault PDA's bump as the seed
- chromatika TS dispatcher in `wallet-extension/src/background/policy-vault/policy-vault-sign-solana.ts` flips from `throw PolicyVaultSolanaSignError('pre-alpha-cpi-stub')` to "build + send + parse signature"

re-opt-in is required at Alpha-1 because (a) ika data is wiped, (b) the dWallet authority transfer step that was deferred today actually runs.

## TS storage layer

```
chrome.storage.local["chromatika_policy_package_v1"]: {
  packageId: "0x..." (Sui Move package id),
  setAtMs: number,
  label?: string,
  solanaProgramId?: "..." (base58 Solana program id, optional)
}

chrome.storage.local["chromatika_policy_vault_v1_<vaultId>"]: {
  vaultObjectId: string,           // 0x... on Sui base, base58 PDA on Solana base
  dwalletId: string,               // same shape gating
  primaryActuator: string,         // Sui address or Solana pubkey
  optInAtMs: number,
  curve: number,
  signatureAlgorithm: number,
  baseChain?: 'sui' | 'solana',    // defaults to 'sui' for legacy installs
  cachedSnapshot?: PolicyVaultSnapshot,
  lastSyncMs?: number
}
```

the chain is the source of truth. the local link record holds **only the pointer** (vault object id / PDA address) plus a write-time snapshot for offline UI rendering. unlocked + online, every read is a fresh chain query via `readPolicyVaultSnapshot` (Sui: `SuiGraphQLClient.core.getObject`; Solana: would be `connection.getAccountInfo` + Anchor account decoder once the program is deployed).

`setPolicyVaultLink` validates the `vaultObjectId` + `dwalletId` shape per `baseChain`:

- Sui: `^0x[0-9a-fA-F]{64}$`
- Solana: `^[1-9A-HJ-NP-Za-km-z]{32,44}$` (loose base58)

`PolicyVaultSnapshot` mirrors the on-chain struct as plaintext (with bigints serialized as decimal strings to survive `chrome.storage.local`). UI reads from the snapshot first for instant render, then refreshes from chain when the GraphQL / RPC roundtrip resolves.

## the dispatch shape

`shouldDispatchThroughPolicy()` (Sui) / `shouldDispatchThroughPolicySolana()` (Solana) check whether the active vault has a `PolicyVaultLink` (and on Solana, that `baseChain === 'solana'`). signing call sites query both, pick the matching dispatcher, and fall through to the legacy direct-sign path if neither returns true.

soft signing entry point on Sui: `signBytesSecpThroughPolicy` in [`policy-vault-sign.ts`](../../wallet-extension/src/background/policy-vault/policy-vault-sign.ts) - mirrors `signBytesEvmCore` enough to be a drop-in dispatch target. consumers pass `PolicySecpSignInput { message, hashScheme, declaredValueMicros, evmHardPolicy?, btcHardPolicy?, desoHardPolicy? }` and pick the hard mode by setting the matching field (chromatika resolves the `priceMicrosPerEth / Satoshi / Deso` via the price service before building the PTB).

soft signing entry point on Solana: `signBytesThroughPolicySolana` in [`policy-vault-sign-solana.ts`](../../wallet-extension/src/background/policy-vault/policy-vault-sign-solana.ts) - throws `pre-alpha-cpi-stub` after performing the same pre-flight checks the Sui side does (panicked, cap-remaining, cool-down). callers wrap with `trySignBytesThroughPolicySolana` which catches the pre-alpha error and returns `null` so they can drop into the legacy direct-sign path without inspecting the error type.

## audit log

`appendPolicyAuditEntry` writes to a per-vault audit log on every:

- `sign-cap-applied` (sign attempted; chain-decoded value substituted in for declared)
- `sign-aborted-panicked` (sign refused due to panic, pre-flight or chain-side)
- `sign-aborted-over-cap` (sign refused due to cap, pre-flight or chain-side)
- `sign-aborted-cool-down` (sign refused due to cool-down)

read via `listPolicyAuditEntries`; clear via `clearPolicyAuditEntries`. designed so a chromatika user / chromatika-team auditor can reconstruct "what did the policy reject and when," even when the chain-side abort message is not enough on its own.

## deployment runbook

### Sui base

1. `cd wallet-extension/move/chromatika-policy && sui move build && sui move test` (passes locally)
2. publish via `sui client publish` against the target network (devnet / testnet / mainnet). save the package id from the output
3. open chromatika `Settings -> Security -> "On-chain spend caps + panic"` and paste the package id
4. opt in a SECP256K1 dWallet via the panel. wallet builds + sends `wrap_dwallet_cap` PTB, persists the link

### Solana base (pre-alpha)

1. `node wallet-extension/scripts/deploy-solana-policy.mjs --cluster devnet --sync-program-id` builds + syncs `declare_id!` in `lib.rs` + `[programs.devnet]` in `Anchor.toml` + deploys
2. paste the program id into `Settings -> Security -> "On-chain spend caps + panic"` (Solana program id field)
3. opt in a Solana-base dWallet. Anchor `wrap_authority` instruction creates the PDA. **note**: on-chain authority transfer is deferred to Alpha-1; today the policy state is recorded but the dWallet's ika-side authority is unchanged
4. attempts to sign through the Solana policy throw `pre-alpha-cpi-stub` until ika Solana Alpha-1. devnet only; do NOT submit real-value transactions

## library + file pointers

- Sui Move: [`wallet-extension/move/chromatika-policy/sources/sign_gate.move`](../../wallet-extension/move/chromatika-policy/sources/sign_gate.move) (core), [`sign_gate_evm.move`](../../wallet-extension/move/chromatika-policy/sources/sign_gate_evm.move), [`sign_gate_btc.move`](../../wallet-extension/move/chromatika-policy/sources/sign_gate_btc.move), [`sign_gate_deso.move`](../../wallet-extension/move/chromatika-policy/sources/sign_gate_deso.move)
- Solana Anchor: [`wallet-extension/solana/chromatika-policy/programs/chromatika-policy/src/lib.rs`](../../wallet-extension/solana/chromatika-policy/programs/chromatika-policy/src/lib.rs)
- TS dispatch: [`wallet-extension/src/background/policy-vault/`](../../wallet-extension/src/background/policy-vault/) - `policy-vault-actions.ts` (high-level flows), `policy-vault-sign.ts` (Sui sign dispatch), `policy-vault-sign-solana.ts` (Solana sign dispatch + pre-alpha throw), `policy-vault-tx.ts` (PTB builders), `policy-vault-storage.ts` (link + package config), `policy-vault-read.ts` (chain snapshot reader), `policy-vault-audit.ts` (log)
- tRPC router: [`wallet-extension/src/server/routers/policy-vault.ts`](../../wallet-extension/src/server/routers/policy-vault.ts)
- UI: [`wallet-extension/src/ui/components/PolicyVaultPanel.tsx`](../../wallet-extension/src/ui/components/PolicyVaultPanel.tsx) (Settings -> Security), [`PolicyVaultBanner.tsx`](../../wallet-extension/src/ui/components/PolicyVaultBanner.tsx) (panicked banner)
- deploy script (Solana): [`wallet-extension/scripts/deploy-solana-policy.mjs`](../../wallet-extension/scripts/deploy-solana-policy.mjs)

## related guides

- [`presign-pool.md`](/library/user/presign-pool) - the per-vault presign pool the Sui policy `pop_presign` consumes
- [`ika-presign-pool-impl.md`](/library/tech/ika-presign-pool-impl) - presign pool details + per-curve caveats (ED25519 deterministic, no Solana pool)
- [`ika-sign-flow.md`](/library/tech/ika-sign-flow) - the underlying ika sign flow `coordinator.approve_message + request_sign` wraps
- [`evm-send-flow.md`](/library/tech/evm-send-flow) - where EVM sends call into `sign_evm_with_policy` once opt-in is active
