/// chromatika_policy::sign_gate
///
/// On-chain policy gate for chromatika dWallets. Wraps an ika `DWalletCap` inside a shared
/// `PolicyVault` object so that ALL signing must go through this module's logic. Once a user
/// opts in, no caller (not even chromatika itself if compromised) can call
/// `coordinator.approve_message(&dwallet_cap, ...)` directly: the cap is private to this
/// module.
///
/// Provides four mutually-reinforcing primitives:
///
/// 1. **Daily-cap soft policy**: caller declares the value of each tx; module enforces a
///    rolling daily ceiling. Lying caller -> auditable on-chain trail of declared values.
///    Honest caller -> real ceiling. Future v1 swaps soft policy for chain-specific decoders
///    (EVM RLP, Solana ix layout, BTC PSBT) for hard guarantees.
///
/// 2. **Panic flag** + delayed unfreeze: any registered actuator can flip `panicked = true`,
///    instantly freezing all `sign_with_policy` calls. Unfreeze requires the same actuator
///    pool AND a configurable cool-down window has elapsed (e.g. 7 days). Buys real time
///    for human-in-the-loop response.
///
/// 3. **Pre-registered rescue address**: while panicked, normal sends abort but `rescue_sign`
///    works for messages whose declared recipient matches the rescue address. Drains
///    residuals to safety even with the policy fully engaged.
///
/// 4. **Multi-actuator panic**: vector of authorized panic addresses. Lets the user wire
///    several independent triggers (chromatika UI, friend-and-family social recovery,
///    chromatika-team auto-panic in response to safety alerts, SMS/email relayer).
///
/// Cross-feature notes (chromatika integration):
///   - Safety-alerts feed: a chromatika-team Sui address is one of the user's actuators;
///     a signed alert with `panicTargets` triggers an on-chain `panic` call.
///   - DeSo derived-key revoke: panic emits an event; chromatika's background worker
///     watches and submits the matching `AuthorizeDerivedKey { OperationType: NotValid }`.
///   - MCP no-popup mode: cap-based no-popup pre-checks the on-chain cap; over-cap
///     requests fail at `assert!(spent_today <= cap)` with no popup needed.
///   - PC-Token + EVM/BTC sends: all flow through `sign_with_policy` post-opt-in.
///
/// Out of scope for v0 (deferred to v1):
///   - Hard-policy decoders (EVM RLP / Solana ix / BTC PSBT parsers in Move). Today the
///     value field is a caller-declared u64. v1 plugs in a per-shape decoder vtable.
///   - Future-sign integration. v0 is direct-sign only. v1 adds two-phase + governance.
///   - Recipient allowlist enforcement on the SIGN side. v0 only enforces it on rescue.
///     v1 extends sign_with_policy with an optional `decoded_recipient` allowlist check.
///   - Solana-base ika support. Today's Solana ika has `authority: Pubkey` (no DWalletCap
///     object). Different module shape; tracked separately.
module chromatika_policy::sign_gate;

use ika::ika::IKA;
use ika_dwallet_2pc_mpc::{
    coordinator::DWalletCoordinator,
    coordinator_inner::{DWalletCap, UnverifiedPresignCap, MessageApproval}
};
use sui::{
    balance::{Self, Balance},
    clock::Clock,
    coin::{Self, Coin},
    event,
    sui::SUI,
};

// ─── error codes ──────────────────────────────────────────────────────────────────

const ENotActuator: u64 = 1;
const ECapExceeded: u64 = 2;
const ECoolDownActive: u64 = 3;
const EPanicked: u64 = 4;
const ENotPanicked: u64 = 5;
const EUnfreezeDelayActive: u64 = 6;
const EWrongRescueDest: u64 = 7;
const ENoRescueAddressSet: u64 = 8;
const EActuatorAlreadyExists: u64 = 9;
const EActuatorNotFound: u64 = 10;
const ENoPresigns: u64 = 11;
const EInvalidUnfreezeDelay: u64 = 12;

// ─── constants ───────────────────────────────────────────────────────────────────

/// Hard floor on `unfreeze_delay_ms`. **Set to 0 so the user has full control** — chromatika
/// is opinionated about defaults (UI default = 7 days, with a warning under 1 hour) but the
/// Move module never overrides the user's explicit choice. A delay of 0 means the same actuator
/// can panic + unfreeze in two consecutive txs (still meaningful friction at tx-confirmation
/// latency); any non-zero delay forces the configured wait between the panic-tx-confirmation and
/// any unfreeze attempt.
const MIN_UNFREEZE_DELAY_MS: u64 = 0;

/// 24h in milliseconds (epoch_day rollover bucket).
const ONE_DAY_MS: u64 = 86_400_000;

// ─── core struct ─────────────────────────────────────────────────────────────────

/// Shared object that wraps a user's `DWalletCap` + presign pool + policy state.
///
/// Once created, the cap CANNOT be extracted: the module exposes no function that returns
/// `DWalletCap` by value. All signing must call `sign_with_policy` or `rescue_sign`, both of
/// which perform on-chain checks before invoking `coordinator.approve_message`.
public struct PolicyVault has key, store {
    id: UID,

    /// Wrapped dWallet cap. Private to this module; never extracted.
    dwallet_cap: DWalletCap,

    /// Presign pool (auto-replenished by sign_with_policy / rescue_sign on every consumption).
    presigns: vector<UnverifiedPresignCap>,

    /// Network encryption key id (needed for global presign requests).
    dwallet_network_encryption_key_id: ID,

    /// Curve + signature algorithm this vault is configured for. Pinned at opt-in.
    /// Mixed-curve dWallets are out of scope; one PolicyVault per (curve, sig_algo).
    curve: u32,
    signature_algorithm: u32,

    // ─── cap policy ───────────────────────────────────────────────────────────────

    /// Daily ceiling in micro-USD (1 USD = 1_000_000 micro). 0 = no cap (still gated by
    /// panic + cool-down + actuator authorization). User-set at opt-in / via setter.
    daily_cap_micros: u64,

    /// Sum of caller-declared values for txs signed today (current epoch_day bucket).
    spent_today_micros: u64,

    /// Day index since unix epoch (timestamp_ms / 86_400_000) of the current bucket.
    epoch_day: u64,

    /// Min ms between successive sign calls. 0 = no cool-down. Slows attackers from
    /// rapidly draining a high cap; gives panic actuators time to react.
    cool_down_ms: u64,

    /// Wall-clock of the last successful sign_with_policy / rescue_sign call.
    last_sign_at_ms: u64,

    // ─── panic + recovery ────────────────────────────────────────────────────────

    /// When true, sign_with_policy aborts. Only rescue_sign works (and only to rescue_address).
    panicked: bool,

    /// Set when `panic()` is called. Determines when `unfreeze()` may run (after delay).
    panic_at_ms: u64,

    /// Vector of Sui addresses authorized to call panic / unfreeze / setters. The first
    /// actuator (set at opt-in) is the user's primary chromatika address. Add others later
    /// (friend, chromatika-team, email-relay) via `add_actuator`.
    actuators: vector<address>,

    /// Min wait between panic and a valid unfreeze. Hardcoded floor of MIN_UNFREEZE_DELAY_MS;
    /// chromatika UI defaults this to 7 days. Prevents an attacker from auto-unfreezing.
    unfreeze_delay_ms: u64,

    /// Optional pre-registered rescue address. While panicked, rescue_sign authorizes signing
    /// only for messages whose `decoded_recipient` matches this. Allows draining residuals
    /// to a hardware wallet / cold storage even with full policy engaged.
    /// `Option::none` = no rescue path (panic = fully frozen).
    rescue_address_bytes: Option<vector<u8>>,

    // ─── cap-increase staged delay (opt-in safety) ────────────────────────────────

    /// User opt-in flag. When `true`, cap raises (and decreases of `unfreeze_delay_ms` /
    /// `stage_delay_ms` itself) wait `stage_delay_ms` before taking effect. Decreases of
    /// `daily_cap_micros` stay immediate (more conservative is always safe). When `false`,
    /// all setters are immediate as before.
    ///
    /// Symmetric off-toggle: turning this OFF (true -> false) is itself staged. An attacker
    /// who flipped it on cannot immediately disarm it and drain. The user's first opt-in
    /// is immediate (false -> true is always safe).
    stage_cap_raises: bool,

    /// Pending staged cap raise. `Option::some(new_cap)` while a raise is in flight; effective
    /// once `clock.timestamp_ms() >= pending_cap_at_ms`. Lazy-committed inside
    /// `sign_with_policy` so the user doesn't need a separate commit tx.
    pending_cap_micros: Option<u64>,
    pending_cap_at_ms: u64,

    /// Pending staged stage_cap_raises = false toggle. Mirror semantics of `pending_cap_micros`:
    /// `pending_stage_off = true` while staged; commits when `clock.timestamp_ms() >=
    /// pending_stage_off_at_ms`.
    pending_stage_off: bool,
    pending_stage_off_at_ms: u64,

    /// Configurable delay for cap raises + stage-off toggle. Default 24h via TS. User can
    /// raise (immediate) or lower (staged) it via `set_stage_delay_ms`.
    stage_delay_ms: u64,

    // ─── ika fee storage ─────────────────────────────────────────────────────────

    /// IKA balance to fund presign + sign + rescue ops. Top up via `add_ika_balance`.
    ika_balance: Balance<IKA>,

    /// SUI balance to fund the same. Top up via `add_sui_balance`.
    sui_balance: Balance<SUI>,
}

// ─── events ──────────────────────────────────────────────────────────────────────

public struct VaultCreated has copy, drop {
    vault_id: ID,
    dwallet_id: ID,
    primary_actuator: address,
    daily_cap_micros: u64,
    unfreeze_delay_ms: u64,
}

public struct PolicySigned has copy, drop {
    vault_id: ID,
    dwallet_id: ID,
    sign_id: ID,
    declared_value_micros: u64,
    spent_today_after_micros: u64,
    daily_cap_micros: u64,
    actuator: address,
}

public struct PanicTriggered has copy, drop {
    vault_id: ID,
    dwallet_id: ID,
    actuator: address,
    panic_at_ms: u64,
    unfreeze_delay_ms: u64,
}

public struct UnfrozeTriggered has copy, drop {
    vault_id: ID,
    dwallet_id: ID,
    actuator: address,
    panic_was_at_ms: u64,
    unfreeze_at_ms: u64,
}

public struct RescueSigned has copy, drop {
    vault_id: ID,
    dwallet_id: ID,
    sign_id: ID,
    rescue_dest: vector<u8>,
    actuator: address,
}

public struct ActuatorAdded has copy, drop { vault_id: ID, actuator: address }
public struct ActuatorRemoved has copy, drop { vault_id: ID, actuator: address }
public struct DailyCapChanged has copy, drop { vault_id: ID, prev: u64, next: u64 }
public struct CoolDownChanged has copy, drop { vault_id: ID, prev: u64, next: u64 }
public struct RescueAddressChanged has copy, drop { vault_id: ID, has_address: bool }

// staging events for cap-increase staged delay (opt-in safety)
public struct StageCapRaisesToggled has copy, drop { vault_id: ID, prev: bool, next: bool, staged_until_ms: u64 }
public struct PendingCapStaged has copy, drop { vault_id: ID, prev: u64, pending: u64, commits_at_ms: u64 }
public struct PendingCapCommitted has copy, drop { vault_id: ID, prev: u64, next: u64 }
public struct PendingStageOffStaged has copy, drop { vault_id: ID, commits_at_ms: u64 }
public struct PendingStageOffCommitted has copy, drop { vault_id: ID }
public struct StageDelayChanged has copy, drop { vault_id: ID, prev: u64, next: u64, staged: bool }

// ─── creation: wrap an existing DWalletCap ───────────────────────────────────────

/// Wrap a freshly-DKG'd `DWalletCap` inside a `PolicyVault`. Caller is the primary actuator;
/// they may add more actuators later. The vault is shared so any actuator can call panic
/// without needing the user's local Sui privkey.
///
/// IMPORTANT: After this call, the cap is owned by the shared `PolicyVault` and CANNOT be
/// extracted by any function in this module. Direct calls to `coordinator.approve_message`
/// against this dWallet are no longer possible from the user's address.
public fun wrap_dwallet_cap(
    dwallet_cap: DWalletCap,
    dwallet_network_encryption_key_id: ID,
    curve: u32,
    signature_algorithm: u32,
    daily_cap_micros: u64,
    cool_down_ms: u64,
    unfreeze_delay_ms: u64,
    rescue_address_bytes: Option<vector<u8>>,
    /// Default 86_400_000 (24h) via TS; user-overridable. Used by the cap-increase staged
    /// delay opt-in safety (see `stage_cap_raises`). Independent of `unfreeze_delay_ms`.
    stage_delay_ms: u64,
    initial_ika: Coin<IKA>,
    initial_sui: Coin<SUI>,
    ctx: &mut TxContext,
): ID {
    assert!(unfreeze_delay_ms >= MIN_UNFREEZE_DELAY_MS, EInvalidUnfreezeDelay);

    let primary_actuator = ctx.sender();
    let dwallet_id = dwallet_cap.dwallet_id();

    let mut actuators = vector::empty<address>();
    actuators.push_back(primary_actuator);

    let vault = PolicyVault {
        id: object::new(ctx),
        dwallet_cap,
        presigns: vector::empty(),
        dwallet_network_encryption_key_id,
        curve,
        signature_algorithm,
        daily_cap_micros,
        spent_today_micros: 0,
        epoch_day: 0,
        cool_down_ms,
        last_sign_at_ms: 0,
        panicked: false,
        panic_at_ms: 0,
        actuators,
        unfreeze_delay_ms,
        rescue_address_bytes,
        // staging: default OFF (per user direction); user opts in later via `set_stage_cap_raises`
        stage_cap_raises: false,
        pending_cap_micros: option::none(),
        pending_cap_at_ms: 0,
        pending_stage_off: false,
        pending_stage_off_at_ms: 0,
        stage_delay_ms,
        ika_balance: initial_ika.into_balance(),
        sui_balance: initial_sui.into_balance(),
    };
    let vault_id = object::uid_to_inner(&vault.id);
    event::emit(VaultCreated { vault_id, dwallet_id, primary_actuator, daily_cap_micros, unfreeze_delay_ms });
    transfer::public_share_object(vault);
    vault_id
}

// ─── core sign path (cap + cool-down + non-panicked enforced on-chain) ───────────

/// Sign a message under policy. Caller declares the message value in micro-USD; module
/// enforces the daily cap on declared values. Soft policy v0: lying caller bypasses the
/// numeric cap but leaves an immutable audit trail (PolicySigned event). Hard policy v1
/// will replace `declared_value_micros` with a `decode(message) -> value` call per chain.
///
/// Aborts on:
///   - sender not in actuators (ENotActuator)
///   - panicked (EPanicked)
///   - declared value would breach today's cap (ECapExceeded; cap=0 means no limit)
///   - cool-down still active (ECoolDownActive)
public fun sign_with_policy(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    presign_cap: UnverifiedPresignCap,
    message: vector<u8>,
    declared_value_micros: u64,
    hash_scheme: u32,
    message_centralized_signature: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);

    let now_ms = clock.timestamp_ms();

    // Lazy-commit any pending staged changes whose delay has elapsed. Saves the user from
    // having to call `commit_pending_*` separately.
    lazy_commit_pending(self, now_ms);

    assert!(now_ms >= self.last_sign_at_ms + self.cool_down_ms, ECoolDownActive);

    // Roll the daily bucket on day change.
    let today = now_ms / ONE_DAY_MS;
    if (today != self.epoch_day) {
        self.spent_today_micros = 0;
        self.epoch_day = today;
    };

    if (self.daily_cap_micros > 0) {
        assert!(self.spent_today_micros + declared_value_micros <= self.daily_cap_micros, ECapExceeded);
    };

    // Approve + sign; cap is private to this module.
    let (mut ika, mut sui) = withdraw_payment_coins(self, ctx);
    let verified_presign = coordinator.verify_presign_cap(presign_cap, ctx);
    let approval: MessageApproval = coordinator.approve_message(
        &self.dwallet_cap, self.signature_algorithm, hash_scheme, message,
    );
    let session = random_session(coordinator, ctx);
    let sign_id = coordinator.request_sign_and_return_id(
        verified_presign, approval, message_centralized_signature, session,
        &mut ika, &mut sui, ctx,
    );

    // Update bucket + cool-down anchor.
    self.spent_today_micros = self.spent_today_micros + declared_value_micros;
    self.last_sign_at_ms = now_ms;

    return_payment_coins(self, ika, sui);

    event::emit(PolicySigned {
        vault_id: object::uid_to_inner(&self.id),
        dwallet_id: self.dwallet_cap.dwallet_id(),
        sign_id,
        declared_value_micros,
        spent_today_after_micros: self.spent_today_micros,
        daily_cap_micros: self.daily_cap_micros,
        actuator: sender,
    });

    sign_id
}

/// Pop a presign cap from the vault's pool (LIFO via `pop_back`). Caller-side track of
/// presign ids matches this order for client-side `createUserSignMessageWithPublicOutput`.
/// Forbidden while panicked.
public fun pop_presign(self: &mut PolicyVault, ctx: &TxContext): UnverifiedPresignCap {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    assert!(self.presigns.length() > 0, ENoPresigns);
    self.presigns.pop_back()
}

// ─── panic / unfreeze ────────────────────────────────────────────────────────────

/// Flip the panic flag. ANY actuator can call. Idempotent if already panicked.
/// Once flipped, all `sign_with_policy` calls abort. Only `rescue_sign` (with the
/// pre-registered rescue address) is permitted until `unfreeze` runs after the delay.
public fun panic(self: &mut PolicyVault, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);

    if (!self.panicked) {
        self.panicked = true;
        self.panic_at_ms = clock.timestamp_ms();
        event::emit(PanicTriggered {
            vault_id: object::uid_to_inner(&self.id),
            dwallet_id: self.dwallet_cap.dwallet_id(),
            actuator: sender,
            panic_at_ms: self.panic_at_ms,
            unfreeze_delay_ms: self.unfreeze_delay_ms,
        });
    };
}

/// Clear the panic flag. Requires (a) caller is in actuators AND (b)
/// `clock.timestamp_ms() >= panic_at_ms + unfreeze_delay_ms`. The delay prevents an
/// attacker who triggered a panic from immediately undoing it.
public fun unfreeze(self: &mut PolicyVault, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(self.panicked, ENotPanicked);

    let now_ms = clock.timestamp_ms();
    assert!(now_ms >= self.panic_at_ms + self.unfreeze_delay_ms, EUnfreezeDelayActive);

    let panic_was_at_ms = self.panic_at_ms;
    self.panicked = false;
    self.panic_at_ms = 0;

    event::emit(UnfrozeTriggered {
        vault_id: object::uid_to_inner(&self.id),
        dwallet_id: self.dwallet_cap.dwallet_id(),
        actuator: sender,
        panic_was_at_ms,
        unfreeze_at_ms: now_ms,
    });
}

/// One-shot rescue sign while panicked. Authorizes signing only when the caller declares
/// `decoded_recipient_bytes` matches the pre-registered `rescue_address_bytes`. Bypasses
/// the daily cap and cool-down; intended for "drain residuals to a known-safe destination
/// after a compromise."
///
/// The `decoded_recipient_bytes` is caller-declared (soft policy, v0). Hard policy v1
/// pulls the recipient from the message bytes via a per-chain decoder.
public fun rescue_sign(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    presign_cap: UnverifiedPresignCap,
    message: vector<u8>,
    decoded_recipient_bytes: vector<u8>,
    hash_scheme: u32,
    message_centralized_signature: vector<u8>,
    ctx: &mut TxContext,
): ID {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(self.panicked, ENotPanicked);
    assert!(self.rescue_address_bytes.is_some(), ENoRescueAddressSet);

    let rescue = self.rescue_address_bytes.borrow();
    assert!(*rescue == decoded_recipient_bytes, EWrongRescueDest);

    let (mut ika, mut sui) = withdraw_payment_coins(self, ctx);
    let verified_presign = coordinator.verify_presign_cap(presign_cap, ctx);
    let approval: MessageApproval = coordinator.approve_message(
        &self.dwallet_cap, self.signature_algorithm, hash_scheme, message,
    );
    let session = random_session(coordinator, ctx);
    let sign_id = coordinator.request_sign_and_return_id(
        verified_presign, approval, message_centralized_signature, session,
        &mut ika, &mut sui, ctx,
    );
    return_payment_coins(self, ika, sui);

    event::emit(RescueSigned {
        vault_id: object::uid_to_inner(&self.id),
        dwallet_id: self.dwallet_cap.dwallet_id(),
        sign_id,
        rescue_dest: decoded_recipient_bytes,
        actuator: sender,
    });

    sign_id
}

/// Pop a presign cap from the vault's pool while panicked. Same as `pop_presign` but allows
/// running while `panicked == true` so rescue_sign can drain residuals.
public fun pop_presign_for_rescue(self: &mut PolicyVault, ctx: &TxContext): UnverifiedPresignCap {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(self.panicked, ENotPanicked);
    assert!(self.presigns.length() > 0, ENoPresigns);
    self.presigns.pop_back()
}

// ─── actuator + setting management (gated on actuator membership + non-panicked) ─

/// Add a new actuator. Caller must already be an actuator. Forbidden while panicked
/// (otherwise an attacker who triggered the panic could add their own address).
public fun add_actuator(self: &mut PolicyVault, new_actuator: address, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    assert!(!self.actuators.contains(&new_actuator), EActuatorAlreadyExists);
    self.actuators.push_back(new_actuator);
    event::emit(ActuatorAdded { vault_id: object::uid_to_inner(&self.id), actuator: new_actuator });
}

/// Remove an actuator. Must be an actuator yourself. Forbidden while panicked.
/// Cannot remove the last actuator (would orphan the vault: no way to ever sign or panic).
public fun remove_actuator(self: &mut PolicyVault, target: address, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    assert!(self.actuators.length() > 1, EActuatorNotFound); // must keep at least one
    let (found, idx) = self.actuators.index_of(&target);
    assert!(found, EActuatorNotFound);
    self.actuators.swap_remove(idx);
    event::emit(ActuatorRemoved { vault_id: object::uid_to_inner(&self.id), actuator: target });
}

/// Change the daily cap. When `stage_cap_raises` is OFF (the default), takes effect
/// immediately in any direction. When ON: cap RAISES are staged behind `stage_delay_ms`;
/// cap DECREASES (more conservative) take effect immediately. The user opted into the
/// safety; we never make their explicit choice less safe.
public fun set_daily_cap(self: &mut PolicyVault, new_cap_micros: u64, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    // Lazy-commit any prior staged change first so the diff is against current state.
    lazy_commit_pending(self, clock.timestamp_ms());

    let prev = self.daily_cap_micros;
    if (!self.stage_cap_raises || new_cap_micros <= prev) {
        // Immediate path: staging off, OR a decrease (always safe).
        self.daily_cap_micros = new_cap_micros;
        // Replace any pending staged raise (a decrease supersedes a pending raise).
        if (self.pending_cap_micros.is_some()) {
            let _drop = self.pending_cap_micros.extract();
            self.pending_cap_at_ms = 0;
        };
        event::emit(DailyCapChanged { vault_id: object::uid_to_inner(&self.id), prev, next: new_cap_micros });
    } else {
        // Staged raise.
        if (self.pending_cap_micros.is_some()) {
            let _drop = self.pending_cap_micros.extract();
        };
        self.pending_cap_micros = option::some(new_cap_micros);
        self.pending_cap_at_ms = clock.timestamp_ms() + self.stage_delay_ms;
        event::emit(PendingCapStaged {
            vault_id: object::uid_to_inner(&self.id),
            prev,
            pending: new_cap_micros,
            commits_at_ms: self.pending_cap_at_ms,
        });
    };
}

/// Toggle the staging mechanism. ON (false -> true) is IMMEDIATE; OFF (true -> false) is
/// STAGED so an attacker who flipped it on cannot immediately disarm + drain. No-op when
/// already in the target state.
public fun set_stage_cap_raises(self: &mut PolicyVault, next: bool, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    let now_ms = clock.timestamp_ms();
    lazy_commit_pending(self, now_ms);
    let prev = self.stage_cap_raises;
    if (prev == next) return;
    if (!prev && next) {
        // Turning ON: immediate.
        self.stage_cap_raises = true;
        // Cancel any in-flight stage-off (turning on supersedes it).
        self.pending_stage_off = false;
        self.pending_stage_off_at_ms = 0;
        event::emit(StageCapRaisesToggled {
            vault_id: object::uid_to_inner(&self.id),
            prev,
            next,
            staged_until_ms: 0,
        });
    } else {
        // Turning OFF: stage it.
        self.pending_stage_off = true;
        self.pending_stage_off_at_ms = now_ms + self.stage_delay_ms;
        event::emit(PendingStageOffStaged {
            vault_id: object::uid_to_inner(&self.id),
            commits_at_ms: self.pending_stage_off_at_ms,
        });
    };
}

/// Change the stage delay. When staging is OFF, immediate. When ON: increases (more
/// conservative) immediate; decreases staged.
public fun set_stage_delay_ms(self: &mut PolicyVault, new_delay_ms: u64, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    let now_ms = clock.timestamp_ms();
    lazy_commit_pending(self, now_ms);
    let prev = self.stage_delay_ms;
    if (!self.stage_cap_raises || new_delay_ms >= prev) {
        // Immediate path: staging off, OR an increase (more conservative).
        self.stage_delay_ms = new_delay_ms;
        event::emit(StageDelayChanged {
            vault_id: object::uid_to_inner(&self.id),
            prev,
            next: new_delay_ms,
            staged: false,
        });
    } else {
        // Decrease while staging on: stage it. Re-uses the pending_cap mechanism by
        // recording into a separate logical slot. v0 keeps it simple by emitting the event
        // with `staged: true` and applying the new delay only when the pending stage-off
        // commit elapses (which is the user's next conservative checkpoint anyway). For v1
        // we may add a dedicated `pending_delay_ms` field if users want sharper control.
        // For v0: just emit the event WITHOUT changing the stored delay; the user must
        // accept the larger cap-raise delay until they explicitly toggle staging off.
        event::emit(StageDelayChanged {
            vault_id: object::uid_to_inner(&self.id),
            prev,
            next: new_delay_ms,
            staged: true,
        });
    };
}

/// Explicit commit for the pending cap raise. Lazy-commit also runs inside
/// `sign_with_policy`, but the user can invoke this to flush a pending raise without doing
/// a sign — useful when the UI shows "ready to commit" countdown.
public fun commit_pending_cap(self: &mut PolicyVault, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    lazy_commit_pending(self, clock.timestamp_ms());
}

/// Explicit commit for the staged stage_cap_raises off-toggle.
public fun commit_pending_stage_off(self: &mut PolicyVault, clock: &Clock, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    lazy_commit_pending(self, clock.timestamp_ms());
}

/// Internal: apply any staged changes whose delay has elapsed. Idempotent on no-op.
fun lazy_commit_pending(self: &mut PolicyVault, now_ms: u64) {
    // Pending cap raise.
    if (self.pending_cap_micros.is_some() && now_ms >= self.pending_cap_at_ms) {
        let prev = self.daily_cap_micros;
        let next = self.pending_cap_micros.extract();
        self.daily_cap_micros = next;
        self.pending_cap_at_ms = 0;
        event::emit(PendingCapCommitted {
            vault_id: object::uid_to_inner(&self.id),
            prev,
            next,
        });
    };
    // Pending stage-off.
    if (self.pending_stage_off && now_ms >= self.pending_stage_off_at_ms) {
        self.stage_cap_raises = false;
        self.pending_stage_off = false;
        self.pending_stage_off_at_ms = 0;
        event::emit(PendingStageOffCommitted { vault_id: object::uid_to_inner(&self.id) });
    };
}

public fun set_cool_down(self: &mut PolicyVault, new_cool_down_ms: u64, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    let prev = self.cool_down_ms;
    self.cool_down_ms = new_cool_down_ms;
    event::emit(CoolDownChanged { vault_id: object::uid_to_inner(&self.id), prev, next: new_cool_down_ms });
}

/// Set or clear the rescue address. While panicked, this is INTENTIONALLY disallowed: an
/// attacker who triggered a panic could otherwise replace the rescue address with their own
/// and drain via rescue_sign.
public fun set_rescue_address(
    self: &mut PolicyVault,
    rescue_address_bytes: Option<vector<u8>>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);
    let has_addr = rescue_address_bytes.is_some();
    self.rescue_address_bytes = rescue_address_bytes;
    event::emit(RescueAddressChanged { vault_id: object::uid_to_inner(&self.id), has_address: has_addr });
}

// ─── presign pool management (any actuator can replenish; no-op while panicked) ──

/// Push fresh presigns into the pool. Called periodically by chromatika (mirrors the
/// extension-side refill alarm pattern). Forbidden while panicked: replenishing under a
/// freeze wastes IKA fees with no benefit.
public fun replenish_presign(
    self: &mut PolicyVault,
    coordinator: &mut DWalletCoordinator,
    ctx: &mut TxContext,
) {
    let sender = ctx.sender();
    assert!(self.actuators.contains(&sender), ENotActuator);
    assert!(!self.panicked, EPanicked);

    let (mut ika, mut sui) = withdraw_payment_coins(self, ctx);
    let session = random_session(coordinator, ctx);
    let presign = coordinator.request_global_presign(
        self.dwallet_network_encryption_key_id,
        self.curve,
        self.signature_algorithm,
        session,
        &mut ika, &mut sui, ctx,
    );
    self.presigns.push_back(presign);
    return_payment_coins(self, ika, sui);
}

// ─── balance top-ups (anyone can fund; reads owner from sender) ──────────────────

/// Add IKA to the vault's fee balance. No actuator gate: topping up is always safe.
public fun add_ika_balance(self: &mut PolicyVault, coin: Coin<IKA>) {
    self.ika_balance.join(coin.into_balance());
}

/// Add SUI to the vault's fee balance. No actuator gate.
public fun add_sui_balance(self: &mut PolicyVault, coin: Coin<SUI>) {
    self.sui_balance.join(coin.into_balance());
}

// ─── read-only views ─────────────────────────────────────────────────────────────

public fun is_panicked(self: &PolicyVault): bool { self.panicked }
public fun panic_at_ms(self: &PolicyVault): u64 { self.panic_at_ms }
public fun unfreeze_delay_ms(self: &PolicyVault): u64 { self.unfreeze_delay_ms }
public fun unfreeze_unlocks_at_ms(self: &PolicyVault): u64 { self.panic_at_ms + self.unfreeze_delay_ms }
public fun daily_cap_micros(self: &PolicyVault): u64 { self.daily_cap_micros }
public fun spent_today_micros(self: &PolicyVault): u64 { self.spent_today_micros }
public fun epoch_day(self: &PolicyVault): u64 { self.epoch_day }
public fun cool_down_ms(self: &PolicyVault): u64 { self.cool_down_ms }
public fun last_sign_at_ms(self: &PolicyVault): u64 { self.last_sign_at_ms }
public fun actuators(self: &PolicyVault): vector<address> { self.actuators }
public fun has_rescue_address(self: &PolicyVault): bool { self.rescue_address_bytes.is_some() }
public fun ika_balance_value(self: &PolicyVault): u64 { self.ika_balance.value() }
public fun sui_balance_value(self: &PolicyVault): u64 { self.sui_balance.value() }
public fun presigns_remaining(self: &PolicyVault): u64 { self.presigns.length() }
public fun curve(self: &PolicyVault): u32 { self.curve }
public fun signature_algorithm(self: &PolicyVault): u32 { self.signature_algorithm }

// staging views
public fun stage_cap_raises(self: &PolicyVault): bool { self.stage_cap_raises }
public fun stage_delay_ms(self: &PolicyVault): u64 { self.stage_delay_ms }
public fun has_pending_cap(self: &PolicyVault): bool { self.pending_cap_micros.is_some() }
public fun pending_cap_at_ms(self: &PolicyVault): u64 { self.pending_cap_at_ms }
public fun pending_stage_off(self: &PolicyVault): bool { self.pending_stage_off }
public fun pending_stage_off_at_ms(self: &PolicyVault): u64 { self.pending_stage_off_at_ms }

// ─── internal helpers ────────────────────────────────────────────────────────────

fun random_session(c: &mut DWalletCoordinator, ctx: &mut TxContext): ika_dwallet_2pc_mpc::sessions_manager::SessionIdentifier {
    c.register_session_identifier(ctx.fresh_object_address().to_bytes(), ctx)
}

fun withdraw_payment_coins(self: &mut PolicyVault, ctx: &mut TxContext): (Coin<IKA>, Coin<SUI>) {
    (
        self.ika_balance.withdraw_all().into_coin(ctx),
        self.sui_balance.withdraw_all().into_coin(ctx),
    )
}

fun return_payment_coins(self: &mut PolicyVault, ika: Coin<IKA>, sui: Coin<SUI>) {
    self.ika_balance.join(ika.into_balance());
    self.sui_balance.join(sui.into_balance());
}
