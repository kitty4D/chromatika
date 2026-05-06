# how to use the on-chain policy vault (spend caps + panic + rescue)

chromatika ships an on-chain **PolicyVault** that wraps a dWallet's signing authority so the wallet can no longer just sign whatever it wants. once you opt in, every sign for that dWallet is gated by your own configured caps + cool-down + actuator list before the chain produces a signature. flip a panic switch from any actuator and the whole vault freezes until a delay you set elapses. the same shape ships on **Sui base** (Move package) and **Solana base** (Anchor program), with one TS surface that branches by `baseChain` under the hood.

short version: even if the chromatika worker / your browser / your host gets fully owned, the attacker is bounded by the cap + cool-down you wrote on chain, can't unwind a panic faster than your delay, and (if you set a rescue address) can't steal residuals - they only sign back to your safe address.

## deployment status (read this first)

- **Sui base (Move package):** built + tested locally at `wallet-extension/move/chromatika-policy/`, **not yet published**. until a chromatika team / you publishes it and the package id is pasted into `Settings -> Security -> "On-chain spend caps + panic"`, opt-in is greyed out. when the package id is empty you can read this guide and the UI but you can't wrap anything.
- **Solana base (Anchor program):** built locally at `wallet-extension/solana/chromatika-policy/`, **not yet deployed**. additionally per the Solana ika pre-alpha disclaimer, even after deploy the on-chain `do_approve_message_cpi` is a `Ok(())` stub awaiting ika Solana **Alpha-1**. so on Solana base today the wallet can store + read all the policy state (cap, panic, actuators, rescue) but the actual sign step does not yet produce a real PDA-gated signature - the TS dispatcher throws `pre-alpha-cpi-stub` and the existing direct sign path (mock signer) takes over. no real custody on Solana base regardless. devnet only.

once those land, the rest of this guide is what you'll be doing in the UI.

## prerequisites

- chromatika is unlocked
- the active dWallet Vault has a SECP256K1 dWallet (Sui base) or an ED25519 dWallet (Solana base, pre-alpha)
- the active vault has IKA + SUI in its on-chain `PolicyVault` balance for sign + presign + DKG-style fees (Sui base). on Solana base, the actuator pays SOL rent for PDA writes
- the chromatika policy package id (Sui) and / or program id (Solana) is configured under `Settings -> Security -> "On-chain spend caps + panic"`. see the deployment-status section above

## options at a glance

- **wrap your dWallet cap into a PolicyVault** (one-time opt-in per dWallet)
- **daily cap** in micro-USD: rolling 24h ceiling on declared / decoded value. `0` = no cap (still gated on panic + cool-down + actuators)
- **cool-down**: minimum gap (ms) between successive signs. slows fast drain attempts
- **actuator list**: addresses authorized to sign / panic / unfreeze. up to 16 on Solana
- **rescue address**: optional pre-registered destination. while panicked, only signs whose recipient matches this go through (one-shot drain to a hardware wallet / cold storage)
- **unfreeze delay**: ms between a panic call and any unfreeze attempt. defaults to 7 days in the chromatika UI
- **staged cap raises** (opt-in): cap raises wait `stage_delay_ms` (default 24h) before applying. cap decreases stay immediate. turning the staging OFF is itself staged so an attacker who flipped it on can't disarm and drain
- **hard-policy decoders** (Sui base, EVM / BTC / DeSo): the policy module decodes the actual tx bytes on chain so the cap is enforced against the real value - not whatever the caller declared

## how to opt in (Sui base)

1. open `Settings -> Security -> "On-chain spend caps + panic"`
2. confirm the chromatika policy package id is set (see deployment status above). if blank, paste it now
3. choose your caps: `daily_cap_micros` (e.g. $500/day = `500_000_000`), `cool_down_ms`, `unfreeze_delay_ms` (default 7 days), and optionally a `rescue_address_bytes` (the address bytes you want to be able to drain to during a panic)
4. choose your `stage_delay_ms` (default 24h) - only matters once you also turn on staged cap raises
5. click `Opt in`. chromatika builds a Sui PTB that calls `chromatika_policy::sign_gate::wrap_dwallet_cap`, transfers the dWallet cap into a freshly created shared `PolicyVault`, funds it with your initial IKA + SUI, and stores the vault object id locally

after opt-in:

- the dWallet cap is **owned by the shared vault** and cannot be extracted. no module function returns `DWalletCap` by value
- direct calls to `coordinator.approve_message(&dwallet_cap, ...)` from your address fail (the cap is no longer owned by you)
- every subsequent sign goes through `sign_with_policy` (or one of the hard-policy variants described below)

## how to opt in (Solana base, pre-alpha)

1. open the same settings panel; paste the chromatika-policy Solana program id (base58, 32-44 chars)
2. fill the same fields as Sui base. `unfreeze_delay_ms` defaults to 7 days here too
3. click `Opt in`. chromatika sends an Anchor `wrap_authority` instruction. the program creates a `PolicyVault` PDA seeded by `[b"chromatika-policy-v1", sha256(dwallet_pubkey)]` with all your settings persisted

caveat (read each line):

- the on-chain "transfer authority to PDA" step requires CPI'ing into the ika Solana program, which today does not expose a stable `set_authority` instruction. so the policy state is fully recorded but the dWallet's authority on the ika side is still whatever ika's mock signer expected. chromatika emits a warning about this; the program prints `[chromatika-policy] PRE-ALPHA: ...` to the Solana logs for the same reason
- when ika Solana Alpha-1 lands, opt-in re-runs to actually move authority + flip the CPI stub. assume any vault you opt in today will need re-opt-in then
- for sign attempts today, the TS dispatcher throws `pre-alpha-cpi-stub` and the wallet falls back to the existing direct sign path. the cap + panic state on the PDA still influences the audit log + UI even though the signature itself is not policy-gated yet

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

## how to top up vault IKA + SUI (Sui base)

1. submit `topUpIka` or `topUpSui` with the amount
2. anyone can fund the vault - top-ups are always safe
3. low IKA / SUI on the vault means presign + sign aborts at the coordinator's pricing check. keep a buffer

## how to manually replenish a presign for the policy vault

1. submit `replenishPresign`. the wallet builds a PTB that calls `sign_gate::replenish_presign` to push fresh material into the vault's per-vault presign pool
2. forbidden while panicked (replenishing under a freeze wastes IKA + SUI fees)
3. usually you don't have to do this manually - chromatika's 5-min refill alarm covers it ([presign-pool.md](/library/user/presign-pool))

## notes

- the chain is the source of truth. chromatika persists a local "link" record (`chromatika_policy_vault_v1_<vaultId>`) holding only the pointer + a write-time snapshot for offline UI rendering. unlocked + online, every read is a fresh chain query
- panic events are also wired to chromatika's safety-alerts feed: a chromatika-team Sui address can be one of your actuators, and a signed alert with `panicTargets` triggers an on-chain `panic` call on your behalf
- the MCP no-popup tier respects the on-chain cap: an over-cap MCP request fails at `assert!(spent_today <= cap)` with no popup - your agent literally cannot exceed your cap regardless of approval mode
- pre-release: chromatika has not shipped to end users. these guides describe the intended behavior; the on-chain pieces are not deployed yet. when they ship, this file gets a "deployed at <package id>" header and the deployment-status section above moves to a smaller note
- if the deployment-status section says "not yet published" and you're seeing the opt-in panel, the package id has been set locally for testing and you're probably running against a devnet / testnet deploy. verify before signing anything that matters
