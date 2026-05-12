# how to use the on-chain policy vault (spend caps + panic + rescue)

chromatika ships an on-chain **PolicyVault** that wraps a dWallet's signing authority so the wallet can no longer just sign whatever it wants. once you opt in, every sign for that dWallet is gated by your own configured caps + cool-down + actuator list before the chain produces a signature. flip a panic switch from any actuator and the whole vault freezes until a delay you set elapses. the same shape ships on **Sui base** (Move package) and **Solana base** (Anchor program), with one TS surface that branches by `baseChain` under the hood.

short version: even if the chromatika worker / your browser / your host gets fully owned, the attacker is bounded by the cap + cool-down you wrote on chain, can't unwind a panic faster than your delay, and (if you set a rescue address) can't steal residuals - they only sign back to your safe address.

## deployment status (read this first)

- **Sui base (Move package):** **shipped on mainnet** (2026-05-11) at `0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727`. End users on Sui mainnet get the team-deployed package automatically via chromatika's built-in registry — no copy-paste step. Iteration deploys on testnet / devnet are still possible via `pnpm run deploy:sui-policy:<env>` for team-internal testing.
- **Solana base (Anchor program):** **DISABLED in UI today.** The Anchor program at `wallet-extension/solana/chromatika-policy/` stays in tree as pre-alpha scaffolding awaiting ika Solana **Alpha-1**; the on-chain `do_approve_message_cpi` is a `Ok(())` stub. When you switch chromatika to a Solana-base vault, the Policy Vault tab shows a "Sui-only for now" notice rather than the opt-in form. No real custody on Solana base regardless. Devnet only when Alpha-1 ships.

## prerequisites

- chromatika is unlocked, active vault is **Sui-base**
- the active dWallet Vault has a `SECP256K1` and/or `ED25519` dWallet (both are now wrappable - the policy enforcement layer differs by chain; see the curve coverage section below)
- the active vault has IKA + SUI in its on-chain `PolicyVault` balance for sign + presign fees (the opt-in form lets you fund initial 0.01 IKA + 0.01 SUI; top up later via the panel)

## options at a glance

- **wrap your dWallet cap into a PolicyVault** (one-time opt-in per dWallet — each wrap is independent; one chromatika vault can hold multiple wrapped dWallets across both curves)
- **daily cap** in micro-USD: rolling 24h ceiling on declared / decoded value. `0` = no cap (still gated on panic + cool-down + actuators)
- **cool-down**: minimum gap (ms) between successive signs. slows fast drain attempts
- **actuator list**: addresses authorized to sign / panic / unfreeze
- **rescue address**: optional pre-registered destination. while panicked, only signs whose recipient matches this go through (one-shot drain to a hardware wallet / cold storage)
- **unfreeze delay**: ms between a panic call and any unfreeze attempt. defaults to 7 days in the chromatika UI
- **staged cap raises** (opt-in): cap raises wait `stage_delay_ms` (default 24h) before applying. cap decreases stay immediate. turning the staging OFF is itself staged so an attacker who flipped it on can't disarm and drain
- **hard-policy decoders** (SECP256K1 dWallets on EVM / BTC / DeSo): the policy module decodes the actual tx bytes on chain so the cap is enforced against the real value - not whatever the caller declared
- **soft policy** (ED25519 dWallets on Sui PTB / Solana ix / Aptos move calls): caller-declared cap enforcement only, until per-format decoders ship. Panic / cooldown / unfreeze gates apply uniformly to both curves

## how to opt in

The fastest path: every time you create a new dWallet on a Sui-base vault, chromatika auto-shows a **post-create prompt** (bottom-sheet modal) with documented defaults ($1000/day cap, 60s cooldown, 7-day unfreeze, 1-day staged-change / unwrap delay, 0.01 IKA + 0.01 SUI seed). One click wraps the dWallet. Two other paths:

- "Customize first" from the post-create prompt → deep-links to the **Policy Vault tab** with the opt-in form open
- Manually from the **Policy Vault tab** (bottom nav) → click `opt in: wrap dwallet cap into policyvault`

Manual opt-in steps:

1. open the **Policy Vault tab** from the bottom nav
2. (mainnet end users: skip; the team-deployed package id is auto-loaded. team iteration deploys: paste the packageId via the "chromatika team only" override)
3. choose your caps: `daily_cap_micros` (e.g. $500/day = `500_000_000`), `cool_down_ms`, `unfreeze_delay_ms` (default 7 days), and optionally a `rescue_address_bytes` (the address bytes you want to be able to drain to during a panic)
4. choose your `stage_delay_ms` (default 24h) - only matters once you also turn on staged cap raises
5. click `Opt in`. chromatika builds a Sui PTB that calls `chromatika_policy::sign_gate::wrap_dwallet_cap`, transfers the dWallet cap into a freshly created shared `PolicyVault`, funds it with your initial IKA + SUI, and stores the vault object id locally at `chromatika_policy_vault_v1_<vaultId>_<dwalletId>` (per-(vault, dwallet) so you can wrap multiple dWallets independently)

after opt-in:
- the dWallet cap is **owned by the shared vault** and cannot be extracted. no module function returns `DWalletCap` by value
- direct calls to `coordinator.approve_message(&dwallet_cap, ...)` from your address fail (the cap is no longer owned by you)
- every subsequent sign goes through `sign_with_policy` (or one of the hard-policy variants described below)

## Solana base (pre-alpha) — DISABLED in UI today

The Anchor program at `wallet-extension/solana/chromatika-policy/` is in-tree as Alpha-1 scaffolding but chromatika **does not let you opt in** on Solana-base vaults today. When the active vault is Solana-base the Policy Vault tab renders a "Sui-only for now" notice rather than the opt-in form. Both the on-chain `do_approve_message_cpi` (Anchor program) and the TS dispatch path are stubs awaiting ika Solana Alpha-1; wrapping would not gate anything until the real signer ships. When Alpha-1 ships, the on-chain CPI bodies and the chromatika UI gates flip in one coordinated change.

## how to change the daily cap

1. submit `setDailyCap` with `newCapMicros`
2. **decreases** apply immediately on both bases (more conservative is always safe, even mid-attack)
3. **increases** apply immediately when staged cap raises is OFF; when ON, the raise is queued behind `stage_delay_ms` and lazy-committed by the next `sign_with_policy` call (or by `commitPendingPolicyCap` if you want to flush early)
4. submit `0` to remove the cap (signing is still gated on panic + cool-down + actuators + rescue, just no $/day ceiling)

## how to change the cool-down

1. submit `setCoolDown` with `newCoolDownMs`
2. takes effect immediately. controls minimum ms between successive `sign_with_policy` (or `rescue_sign`) calls
3. cool-down is anchored at "the wall-clock of the last successful sign" - if you set 60_000ms, the next sign must wait at least a minute

## how to add an actuator

1. submit `addActuator` with the new address (Sui address on Sui base, base58 pubkey on Solana base, max 16 on Solana)
2. you must already be an actuator yourself
3. forbidden while panicked - otherwise an attacker who triggered the panic could add their own address as an actuator
4. typical use: add a friend's address for social recovery, add a chromatika-team alerts address that auto-panics on safety alerts (see below), add an SMS / email relayer

## how to remove an actuator

1. submit `removeActuator` with the target address
2. cannot remove the last actuator (would orphan the vault: no way to ever sign or panic)
3. forbidden while panicked

## how to set or clear the rescue address

1. submit `setRescueAddress` with the destination bytes (or `null` to clear)
2. on Sui: 0-100 byte vector matching whatever recipient encoding the chain you're rescuing to uses (an EVM 20-byte address, a BTC scriptPubKey, etc.)
3. on Solana: same shape, max 100 bytes
4. **forbidden while panicked**: an attacker who triggered the panic must not be allowed to swap the rescue address to their own and drain via `rescue_sign`

## how to panic the vault

1. submit `panicVault`
2. **any actuator** can panic; it's idempotent if already panicked
3. on success: `panicked = true`, `panic_at_ms` timestamps it, `unfreeze` is gated until `panic_at_ms + unfreeze_delay_ms`
4. effects: every `sign_with_policy` (and every hard-policy variant) aborts. presign-pool replenishment aborts. cap / cool-down / rescue setters abort. only `rescue_sign` (matching the rescue address) and `unfreeze` (after delay) work
5. an event (`PanicTriggered` on Sui, `PanicTriggered` on Solana) is emitted on chain. on Sui this also drives the chromatika DeSo derived-key revoke worker

## how to unfreeze after a panic

1. wait `unfreeze_delay_ms` from the panic timestamp
2. submit `unfreezeVault` from any actuator
3. on success: `panicked = false`, `panic_at_ms = 0`, vault is back to normal
4. trying to unfreeze before the delay aborts with `EUnfreezeDelayActive` (Sui) / `UnfreezeDelayActive` (Solana)

## how to use rescue mode while panicked (Sui base today)

1. while panicked, regular sign aborts. but if you set a rescue address ahead of time, you can call `rescue_sign` to drain residuals to that address
2. caller passes `decoded_recipient_bytes` (today caller-declared; v1 will decode from the message itself); the chain enforces those bytes match the rescue address bytes you pre-registered
3. bypasses cap + cool-down. burns no daily-bucket; intended for "compromise: get residuals to safety asap"
4. on Solana base today: rescue is stored on the PDA but the same pre-alpha CPI gap means rescue signing also waits on Alpha-1

## how to enable staged cap raises (opt-in safety)

the staging mechanism is OFF by default to keep onboarding simple. when you turn it on:

1. submit `setPolicyStageCapRaises` with `next: true`. **turning ON is immediate** (turning protection on is always safe)
2. afterwards, **cap raises** wait `stage_delay_ms` before applying. **cap decreases** stay immediate
3. **turning OFF is staged**: an attacker who flipped staging ON should not be able to immediately disarm + drain. the OFF toggle waits `stage_delay_ms` then commits

related setters:
- `setPolicyStageDelayMs` to change `stage_delay_ms`. increases are immediate (more conservative); decreases stage when staging is on (v0 surfaces the change in events but does not store the smaller delay until staging is toggled off)
- `commitPendingPolicyCap` / `commitPendingPolicyStageOff` to flush a pending change without doing a sign (lazy commit also runs inside `sign_with_policy`)

## hard-policy modes (Sui base, today)

soft-policy v0 trusts you to declare the value. the **hard-policy** variants decode the actual tx bytes on chain in Move, so the cap is enforced against the real value - not whatever the caller wrote. these are picked automatically by chromatika when sending on the matching chain:

- **EVM** (`sign_gate_evm::sign_evm_with_policy`): decodes Legacy + EIP-1559 + EIP-2930 RLP txs, pulls `to` + `value (wei)`, converts to micro-USD using a chromatika-supplied ETH/USD price. EIP-4844 (blob) and EIP-7702 abort with `EUnsupportedTxType`. emits `EvmDecoded` event with `to`, `value_wei`, `value_micros`, and the price the caller used (so any price lie is auditable on chain)
- **BTC** (`sign_gate_btc::sign_btc_with_policy`): decodes the BIP143 witness-v0 sighash preimage, pulls the input UTXO `amount` field, converts to micro-USD using a chromatika-supplied BTC/sat price. caps on **input** value (UTXO being spent), which is conservative since input >= output (the diff is the fee). Taproot + legacy preimages are out of scope today and abort with `EBadPreimage`
- **DeSo** (`sign_gate_deso::sign_deso_with_policy`): decodes the v0 binary tx, sums `TxOutputs.AmountNanos`, converts to micro-USD using a chromatika-supplied DESO/USD price. caps on the **sum of outputs** (= input - fee), which counts your own change against the cap (trade-off: simple + safe vs perfectly precise). emits `DeSoDecoded` with the largest single output so off-chain auditors can recover the "real" send amount

honesty model on all three: **HARD on value** (decoded from the bytes), **SOFT on price** (caller-supplied; logged on-chain). v2 closes the price gap by pulling Pyth on-chain.

Solana base does not yet have hard-policy variants (the soft sign isn't even live). they're tracked for once Alpha-1 lands.

## how to unwrap (exit) the policy vault

if you want to remove policy enforcement from a dWallet entirely, the unwrap flow lets you reclaim the `DWalletCap` from the on-chain `PolicyVault`. this is a **staged two-step process** with a mandatory delay to prevent an attacker from instantly unwrapping and draining.

### step 1: request unwrap

1. submit `requestPolicyUnwrap` with the `dwalletId`
2. the chain records the request and starts the delay timer (`stage_delay_ms`, default 24h)
3. returns `{ digest, claimableAtMs }` - `claimableAtMs` is the earliest timestamp the claim will succeed

during the delay:
- the dWallet is still policy-gated (signs still go through `sign_with_policy`)
- any actuator can **panic** the vault to block the claim
- the requester can **cancel** the unwrap at any time

### step 2: claim unwrap (after delay)

1. wait for `claimableAtMs` to pass
2. submit `claimPolicyUnwrap` with the `dwalletId`
3. on success: the on-chain `PolicyVault` object is consumed, `DWalletCap` is returned to your fee-payer address
4. the local link record (`chromatika_policy_vault_v1_<vaultId>_<dwalletId>`) is cleared
5. the dWallet is now policy-free - you can opt in again or continue without policy enforcement

### cancel unwrap

1. submit `cancelPolicyUnwrap` with the `dwalletId` at any time before claiming
2. the pending unwrap is cancelled, the vault continues as normal
3. safe to call even while panicked

### abort conditions for claim

the claim aborts if:
- the caller is not in the actuator list
- no unwrap was requested
- the delay has not elapsed yet
- the vault is currently panicked

### security model

- **cap decreases are immediate, unwrap is staged** - an attacker who gets wallet access can't instantly remove all protection
- **panic blocks claim** - a friend / alert-system actuator can freeze the vault during the unwrap delay
- **cancel is always safe** - the legitimate owner can cancel a malicious unwrap request at any time

## how to top up vault IKA + SUI (Sui base)

1. submit `topUpIka` or `topUpSui` with the amount
2. anyone can fund the vault - top-ups are always safe
3. low IKA / SUI on the vault means presign + sign aborts at the coordinator's pricing check. keep a buffer

## how to manually replenish a presign for the policy vault

1. submit `replenishPresign`. the wallet builds a PTB that calls `sign_gate::replenish_presign` to push fresh material into the vault's per-vault presign pool
2. forbidden while panicked (replenishing under a freeze wastes IKA + SUI fees)
3. usually you don't have to do this manually - chromatika's 5-min refill alarm covers it ([presign-pool.md](/library/user/presign-pool))

## notes

- the chain is the source of truth. chromatika persists a local "link" record per (chromatika vault, dWallet) at `chromatika_policy_vault_v1_<vaultId>_<dwalletId>` holding only the pointer + a write-time snapshot for offline UI rendering. unlocked + online, every read is a fresh chain query. one chromatika vault can wrap multiple dWallets (one wrap per dWallet, independent state per wrap)
- panic events are also wired to chromatika's safety-alerts feed: a chromatika-team Sui address can be one of your actuators, and a signed alert with `panicTargets` triggers an on-chain `panic` call on your behalf
- the MCP no-popup tier respects the on-chain cap: an over-cap MCP request fails at `assert!(spent_today <= cap)` with no popup - your agent literally cannot exceed your cap regardless of approval mode
- pre-release: chromatika has not shipped to end users. these guides describe the intended behavior; the on-chain pieces are not deployed yet. when they ship, this file gets a "deployed at <package id>" header and the deployment-status section above moves to a smaller note
- if the deployment-status section says "not yet published" and you're seeing the opt-in panel, the package id has been set locally for testing and you're probably running against a devnet / testnet deploy. verify before signing anything that matters
