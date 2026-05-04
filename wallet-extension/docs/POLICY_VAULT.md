# Policy Vault (chromatika)

> status: 2026-04-30: v0 shipped: Move package source + TS storage + tx builders + actions + tRPC + Settings UI panel + tests. **Self-deploy required**: chromatika-team or the user publishes the `chromatika_policy::sign_gate` Move package, pastes the package id into Settings, then opts in. v0 ships the panic / unfreeze / rescue / multi-actuator primitives; the EVM/BTC/Sui send-path integration that routes signing through `sign_with_policy` ships in v1.

## TL;DR

Wraps an ika `DWalletCap` in a Sui Move shared object that owns it. After opt-in, no caller can call `coordinator.approve_message(&dwallet_cap, ...)` directly: the cap is private to the module. All signing must go through `sign_with_policy` (which checks daily cap, cool-down, panicked flag, actuator membership) or `rescue_sign` (only valid while panicked, only to a pre-registered rescue address).

The big wins:
- **Real on-chain panic.** Flip a flag on Sui; the MPC network refuses to issue any signature for this dWallet until unfreeze. Even a fully compromised chromatika cannot bypass.
- **Time-delayed unfreeze.** Default 7 days; an attacker who panics can't immediately un-panic.
- **Pre-registered rescue address.** While panicked, drains residuals to a known-safe destination only.
- **Multi-actuator.** User wires several panic triggers: chromatika UI button, friend-and-family social recovery, chromatika-team safety-alert auto-panic, SMS/email relayer.
- **Daily cap (soft policy v0).** Caller declares value; module enforces the rolling daily ceiling. Hard decoders for EVM RLP / Solana ix / BTC PSBT ship in v1.

## Architecture

```
move/chromatika-policy/
├── Move.toml                           ika_dwallet_2pc_mpc + Sui framework deps
└── sources/sign_gate.move              PolicyVault + wrap_dwallet_cap + sign_with_policy +
                                        panic + unfreeze + rescue_sign + setters + events

wallet-extension/src/background/policy-vault/
├── policy-vault-storage.ts             chromatika_policy_package_v1 (global) +
                                        chromatika_policy_vault_v1_<vaultId> (per-vault link)
├── policy-vault-tx.ts                  Sui PTB builders for every Move entry point +
                                        Move abort-code decoder
├── policy-vault-read.ts                On-chain object reader + parser
├── policy-vault-actions.ts             High-level orchestrator: build PTB + execute via
                                        executeSuiTransaction + persist link
├── policy-vault-storage.test.ts
├── policy-vault-tx.test.ts
└── policy-vault-read.test.ts

wallet-extension/src/server/routers/policy-vault.ts
                                        tRPC: getPolicyVaultState / setPolicyPackageId /
                                        optInToPolicyVault / panicVault / unfreezeVault /
                                        setPolicyDailyCap / setPolicyCoolDown /
                                        setPolicyRescueAddress / addPolicyActuator /
                                        removePolicyActuator / replenishPolicyPresign /
                                        topUpPolicyIka / topUpPolicySui / clearLocalPolicyVaultLink

wallet-extension/src/ui/components/PolicyVaultPanel.tsx
                                        Settings -> Security -> "On-chain spend caps + panic"
```

## Move package

`chromatika_policy::sign_gate` exposes one shared struct `PolicyVault` and the following entries:

### Creation
- `wrap_dwallet_cap(dwallet_cap, network_key_id, curve, sig_algo, daily_cap_micros, cool_down_ms, unfreeze_delay_ms, rescue_address_bytes, initial_ika, initial_sui, ctx)` -> `vault_id: ID`. Caller becomes primary actuator. `unfreeze_delay_ms` is floored at 60s in Move; chromatika UI defaults to 7 days.

### Sign
- `sign_with_policy(vault, coordinator, message, declared_value_micros, hash_scheme, msg_sig, clock, ctx)` -> `sign_id`. Aborts on cap breach / cool-down / panicked / no presigns / not actuator.
- `rescue_sign(vault, coordinator, message, decoded_recipient_bytes, hash_scheme, msg_sig, ctx)` -> `sign_id`. Only valid while panicked AND `decoded_recipient_bytes == rescue_address_bytes`.

### Panic
- `panic(vault, clock, ctx)` -> flips `panicked = true`. Idempotent. Any actuator.
- `unfreeze(vault, clock, ctx)` -> clears `panicked`. Aborts if `now < panic_at + unfreeze_delay`.

### Setters (forbidden while panicked)
- `set_daily_cap(vault, new_cap_micros, clock, ctx)`
- `set_cool_down(vault, new_cool_down_ms, ctx)`
- `set_rescue_address(vault, rescue_address_bytes, ctx)`
- `add_actuator(vault, new_actuator, ctx)`
- `remove_actuator(vault, target, ctx)` (must keep at least one)
- `set_stage_cap_raises(vault, next, clock, ctx)` (toggle the cap-increase staged delay safety; ON immediate, OFF staged)
- `set_stage_delay_ms(vault, new_delay_ms, clock, ctx)` (changes the delay duration)
- `commit_pending_cap(vault, clock, ctx)` (force-commit a staged cap raise once delay elapsed; lazy-commit also runs inside `sign_with_policy`)
- `commit_pending_stage_off(vault, clock, ctx)` (force-commit a staged off-toggle once delay elapsed)

### Operations
- `replenish_presign(vault, coordinator, ctx)` (any actuator; not panicked)
- `add_ika_balance(vault, coin)` (no gate; topping up is always safe)
- `add_sui_balance(vault, coin)` (no gate)

### Events
- `VaultCreated`, `PolicySigned`, `PanicTriggered`, `UnfrozeTriggered`, `RescueSigned`, `ActuatorAdded`, `ActuatorRemoved`, `DailyCapChanged`, `CoolDownChanged`, `RescueAddressChanged`
- staging events: `StageCapRaisesToggled`, `PendingCapStaged`, `PendingCapCommitted`, `PendingStageOffStaged`, `PendingStageOffCommitted`, `StageDelayChanged`

### Abort codes
| code | meaning |
|---|---|
| 1 | not in actuator list |
| 2 | declared value would breach daily cap |
| 3 | cool-down still active |
| 4 | panicked |
| 5 | not panicked (cannot unfreeze / rescue_sign) |
| 6 | unfreeze delay still active |
| 7 | wrong rescue destination |
| 8 | no rescue address set |
| 9 | actuator already exists |
| 10 | actuator not found / cannot remove last |
| 11 | presign pool empty |
| 12 | unfreeze delay below protocol floor (60s) |

## Deploy runbook

### 1. Build the Move package

```bash
cd wallet-extension/move/chromatika-policy
sui move build
```

Resolves the `ika_dwallet_2pc_mpc` + `ika` testnet/mainnet deps and produces bytecode. For mainnet, edit `Move.toml` and change `testnet` to `mainnet` in both git-subdir paths.

### 2. Publish to Sui

```bash
sui client publish --gas-budget 200000000
```

Capture the published package id from the output (`packageId: 0x...`). It's a 0x-prefixed 32-byte hex.

### 3. Configure chromatika

Open chromatika -> Settings -> "on-chain spend caps + panic button". Paste the package id into the input. Hit save.

### 4. Opt in

In the same panel: click "opt in: wrap dWallet cap into PolicyVault". Configure:
- **Daily cap (USD)**: micro-USD enforced on-chain. 0 = no cap (still gated by panic + cool-down).
- **Cool-down (sec)**: min seconds between sends. 0 = none.
- **Unfreeze delay (days)**: hardcoded floor of 60s in Move; UI default = 7 days.
- **Rescue address**: optional; UTF-8 bytes of the destination string (the same form the EVM/Solana/BTC tx decoders will compare against). Recommended: your hardware wallet address.
- **Initial IKA + SUI fund**: the vault needs IKA + SUI to pay ika protocol fees on every sign / replenish. Top up later via `topUpPolicyIka` / `topUpPolicySui`.

The PTB:
1. Splits the requested IKA + SUI off your owned coins.
2. Calls `wrap_dwallet_cap`, transferring the cap into a new shared object.
3. Returns the new vault's object id; chromatika persists it locally.

### 5. (v1, not yet shipped) Wire send paths through `sign_with_policy`

The EVM / BTC / Sui send paths today call `coordinator.approve_message` directly. Post-opt-in this fails because the cap is no longer owned by the user. The v1 slice modifies `signAndBroadcastEvm` / `signBytesBitcoinNative` / `signBytesSolana` to dispatch to `sign_with_policy` when `getPolicyVaultLink(activeVaultId)` returns a link. Until v1 ships, opt-in is a one-way gate that DISABLES wallet-UI signing for the wrapped dWallet.

This is intentional in v0 to land the panic primitive cleanly without rushing the send-path integration. **Only opt in on a vault you can rebuild from a backup if needed.**

## Cap-increase staged delay (opt-in safety)

**Why**: Without this, a compromised chromatika that has somehow obtained the user's actuator key can simply call `set_daily_cap(huge)` in one tx and then `sign_with_policy` to drain. The user can panic, but only after they notice. Cap-staged-delay closes that race by making cap RAISES wait a configurable delay.

**Default OFF**: shipped opt-in by user direction. The user enables it from Settings -> Security -> "tune" -> "stage cap raises". The mechanism is symmetric: turning it OFF is itself staged, so an attacker who flipped it on cannot immediately disarm it before the user notices.

**Asymmetric semantics** (anything that REDUCES protection is staged):

| change | staging OFF | staging ON |
|---|---|---|
| cap raise (`new > current`) | immediate | STAGED (`stage_delay_ms`) |
| cap decrease (`new <= current`) | immediate | immediate (more conservative) |
| toggle staging ON (false -> true) | immediate | n/a |
| toggle staging OFF (true -> false) | immediate | STAGED (symmetric) |
| stage_delay_ms increase | immediate | immediate (more conservative) |
| stage_delay_ms decrease | immediate | STAGED |

**Lazy commit**: pending changes whose delay has elapsed are auto-committed at the top of `sign_with_policy`, so the user doesn't need a separate commit tx. Explicit `commit_pending_cap` / `commit_pending_stage_off` entries exist for the UI's "ready to commit" checkpoint button.

**Storage fields** added to `PolicyVault`:
- `stage_cap_raises: bool` (user opt-in flag)
- `pending_cap_micros: Option<u64>` + `pending_cap_at_ms: u64`
- `pending_stage_off: bool` + `pending_stage_off_at_ms: u64`
- `stage_delay_ms: u64` (default 24h via TS; user can change at any time)

**Audit events** mirror the on-chain logic:
- `StageCapRaisesToggled` (immediate ON or OFF that was already staged + committed)
- `PendingCapStaged` (cap raise scheduled)
- `PendingCapCommitted` (delay elapsed; lazy or explicit commit)
- `PendingStageOffStaged` (off-toggle scheduled)
- `PendingStageOffCommitted` (delay elapsed)
- `StageDelayChanged` (delay change; `staged: bool` indicates whether it took effect immediately or was deferred)

**Threat model fit**: Closes "compromised chromatika raises cap before user notices" when the user has opted into staging. Combined with the existing panic primitive: friend-actuator can panic during the staging window, locking out the attacker entirely. Cap decreases stay immediate so the user can always tighten their own posture without delay.

## Cross-feature synergies

### Safety alerts auto-panic

The signed-alerts feed (`chromatika_alerts_v1`) already supports `severity: 'critical'` + `affectedDomains`. Adding a `panicTargets: string[]` field to the alert envelope lets a chromatika-team-signed alert auto-trigger panic on affected vaults. The chromatika-team's Sui address is pre-registered as one of the user's actuators at opt-in. Workflow:

1. chromatika-team detects active drain pattern targeting specific addresses.
2. Publishes a signed alert: `{ severity: 'critical', affectedAddresses: ['BC1...'], panicTargets: ['vault-object-id'], ... }`.
3. chromatika polls feed (every 5min), verifies signature, sees the panic_target matches the active vault.
4. chromatika auto-builds + signs a `panic` PTB from the user's local Sui keypair (which is one of the actuators).
5. On-chain panic flag flips. ALL signing freezes immediately.

This is dramatically more powerful than the v0 alert banner: keys are functionally frozen at the protocol level until the user explicitly unfreezes after the delay.

### DeSo derived-key auto-revoke

When the panic event fires, chromatika can ALSO submit a follow-up `AuthorizeDerivedKey { OperationType: NotValid }` for any DeSo derived key the chromatika dWallet holds. One panic, two chains, full revoke. Implementation: hook the panic broadcast handler to enumerate active DeSo links (`chromatika_deso_owner_link_v1_<vaultId>`) and queue revoke txs.

### MCP no-popup mode (covered by cap)

When the policy vault is opted in:
- MCP `sendEvmTx` / `sendSolanaTx` skip the popup if the sign goes through `sign_with_policy`.
- Below cap = approve_message succeeds = ika MPC signs. No popup.
- Above cap = `sign_with_policy` aborts with code 2. Popup falls back to manual approval.
- Panicked = abort with code 4. Popup shows "vault is panicked; unfreeze first."
- Wrong recipient (when v1 hard policy enforces) = abort with code 7.

### Friend-and-family social recovery

Add a friend's Sui address as an actuator. They can panic the vault if the user is incapacitated / loses access. They CANNOT add/remove other actuators (would let them lock the user out), and they cannot redirect the rescue address (`set_rescue_address` is disabled while panicked). They CAN trigger the freeze, after which the user uses their pre-registered rescue address to drain to safety.

### PC-Token + EVM/BTC sends

All chromatika send paths that use the SECP256K1 dWallet (EVM, Bitcoin, DeSo, PC-Token wrap/transfer/unwrap) are gated by the same `sign_with_policy` post-v1. Single panic flag covers all of them.

## Trust model + threat scenarios

### What this protects against

| threat | protection |
|---|---|
| Compromised chromatika extension | Cannot bypass on-chain caps / panic. MPC network refuses signatures. |
| Stolen MCP bearer token | Same: on-chain enforcement, not extension-side. |
| Prompt-injected agent submitting adversarial txs | Soft cap rejects over-cap; cool-down rate-limits; panic flag is one-click freeze. |
| Lost / stolen device | Friend-actuator panics. Time-delayed unfreeze. Rescue address drains residuals. |
| Phishing the user into a single bad sign | Cool-down + cap limit damage to one tx; panic afterward freezes everything. |

### What this does NOT protect against (v0)

- **Lying caller on `declared_value_micros`** (soft policy). Hard decoders ship in v1.
- **Lying caller on `decoded_recipient_bytes`** for rescue (soft). Hard decoder for the rescue path lands when EVM/Solana/BTC decoders ship in v1.
- **Attacker who controls a majority of actuators**. The user must curate the actuator list carefully. Default v0: just the user's primary Sui address.
- **Solana ika base** (today's Solana base uses `authority: Pubkey`, not `DWalletCap`). Tracked separately. The Sui base path is the cheap win and covers EVM + BTC + DeSo + PC-Token (Solana SPL).

### Threat scenarios in detail

**Scenario 1: chromatika compromised, attacker controls extension state.**
- Pre-opt-in: attacker drains. v0 popup is the only check; an attacker who controls the extension can fake the popup data.
- Post-opt-in: attacker can submit any sign request, but it must go through `sign_with_policy`. Daily cap limits damage to N USD/day. Cool-down rate-limits. Attacker also can't change cap (setter requires actuator + non-panicked; if attacker stole user's Sui keypair they ARE the actuator, so they could increase cap: but the friend-actuator can panic, freezing for 7 days while the user investigates).

**Scenario 2: agent prompt-injected via webpage.**
- Pre-opt-in: agent submits, user sees popup, user might click through if they trust the agent.
- Post-opt-in: above cap = abort. Below cap = signs (this is the desired no-popup behavior). The cap is the budget for "agent acts unsupervised today."

**Scenario 3: lost device.**
- User has friend-actuator pre-registered. Friend triggers panic. 7-day delay starts. User contacts the friend, walks them through unfreezing once the user has set up a fresh chromatika install. Or, user uses pre-registered rescue address to drain residuals to a hardware wallet via `rescue_sign`.

## Verification

```bash
cd wallet-extension
pnpm test --run src/background/policy-vault
pnpm run build
```

Manual e2e (requires deployed Move package):

1. `cd move/chromatika-policy && sui move build && sui client publish` -> capture package id
2. Open chromatika, paste package id in Settings -> Security -> spend caps + panic
3. Opt in with a small daily cap ($5) + 60s cool-down + 60s unfreeze delay (for testing)
4. Verify panel shows "active" + cap progress bar
5. Click PANIC -> confirm -> verify panel shows "PANICKED" + countdown
6. Wait 60s -> verify "unfreeze unlocks" -> click UNFREEZE -> verify "active"
7. Add a second actuator (test friend address) -> verify it appears in the list
8. Inspect on Suiscan: vault object id -> verify `panicked: false`, `actuators: [primary, friend]`

## Roadmap

### v1 (shipped 2026-05-01 / 2026-05-02)
- **Send-path integration** (shipped): EVM / BTC / DeSo / Sui send paths dispatch through `sign_with_policy` when the active vault has a PolicyVault link.
- **Safety-alerts auto-panic** (shipped): publisher CLI emits `panicTargets`; SW handler `autoPanicPolicyTargetsForAlert` signs the panic PTB.
- **Hard policy decoders**:
  - EVM RLP (legacy / EIP-1559 / EIP-2930) — shipped 2026-05-01 in `sign_gate_evm.move`. Replaces caller-declared value with chain-decoded value; caller-supplied price for USD conversion (logged on-chain via `EvmDecoded` event).
  - **BTC BIP143 witness-v0 (P2WPKH + P2WSH) — shipped 2026-05-02** in `sign_gate_btc.move`. Decoder extracts the UTXO `amount` field at offset (PREFIX + outpoint + scriptCodeLen + scriptCode); caller-supplied per-sat price; emitted on-chain via `BtcDecoded` event. Cap enforced on input (UTXO being spent), conservative because input >= output. TS dispatch via `signBitcoinTxSighashPreimage({ isBtcTx, priceMicrosPerSatoshi })` → `signBytesSecpThroughPolicy({ btcHardPolicy })`. Multi-input handling: only the FIRST input runs in hard mode; subsequent inputs go through soft `sign_with_policy` with `declaredValueMicros = 0n` (preserves "count once per tx" semantics under both modes).
  - **DeSo v0 binary — shipped 2026-05-02** in `sign_gate_deso.move`. Decoder skips TxInputs, iterates TxOutputs, sums `AmountNanos`, returns `(sum, largest, count)`. Cap enforced on output sum (= input - fee, includes change). Caller-supplied `priceMicrosPerDeso`; emitted on-chain via `DeSoDecoded` event. TS dispatch via `signBytesSecpThroughPolicy({ desoHardPolicy: { priceMicrosPerDeso } })`. BTC + DeSo both DoubleSHA256 but mutually exclusive at the dispatch (caller picks one based on chain).
  - Solana SPL — pending (Block 9, requires Solana ika base policy module).
- **Per-action allowlist**: extend `sign_with_policy` with optional `allowed_action_kinds: vector<u8>` (per-curve enum) and abort if the decoded action isn't in the list.

### v1.5
- **DeSo derived-key auto-revoke** on panic
- **Future-sign integration** for governance + multisig flows
- **MCP cap-aware no-popup mode** (composed with the v0 in-extension caps; on-chain enforcement is the strict layer)

### v2
- **Solana ika base support**: deploy a custom Solana program that PDA-owns the dWallet's `authority`, mirrors this module's logic.
- **DAO / treasury wrappers**: extend with vote-gated `request_future_sign` for shared wallets.

## Related

- [`POLICY_DEPLOY_QUICKSTART.md`](POLICY_DEPLOY_QUICKSTART.md): one-page CLI setup + deploy commands for the Sui Move + Solana Anchor packages
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index
- [`DESO_DERIVED_KEY.md`](DESO_DERIVED_KEY.md): the DeSo delegation slice that composes with on-chain panic for cross-chain revoke
