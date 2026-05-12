//! chromatika-policy (Solana base)
//!
//! Solana-native parallel of `chromatika_policy::sign_gate` (the Sui Move package). Wraps
//! the dWallet authority Pubkey under a Program-Derived Address that ONLY this program can
//! sign for, then exposes `sign_with_policy` as the only path that approves messages — gated
//! on cap + cool-down + panic + actuator checks identical to the Sui-side semantics.
//!
//! ## Status (2026-05-02)
//!
//! **Pre-alpha; awaits ika Solana Alpha-1.** Per `wallet-extension/CLAUDE.md`:
//!   - Solana ika today uses a **single mock signer** (not distributed MPC); signatures are
//!     not real custody.
//!   - The Solana ika program + its on-chain data **WILL BE WIPED** when ika transitions to
//!     Alpha-1.
//!   - This module **does NOT** ship a working `approve_message` CPI today. The CPI target
//!     in `sign_with_policy::do_approve_message_cpi` is a `todo!()` until the ika Solana
//!     Alpha-1 contract surface is published.
//!
//! What's here today:
//!   - The full `PolicyVault` PDA shape mirroring the Sui Move struct (panicked, cap,
//!     cool-down, actuators, rescue, staging fields, unwrap two-step).
//!   - All instructions (`wrap_authority`, `panic`, `unfreeze`, setters, staging entries,
//!     `request_unwrap` / `cancel_unwrap` / `claim_unwrap`).
//!   - Pre-CPI policy enforcement so when Alpha-1 lands we just plug the CPI targets into
//!     `do_approve_message_cpi` (for signing) and `do_release_authority_cpi` (for unwrap).
//!   - Storage-shape parity with the Sui side so the chromatika TS dispatch can branch on
//!     `getDwalletMeta(activeVault).baseChain` and call the same logical setters with the
//!     same micro-USD / ms semantics.
//!
//! Honesty: this is **scaffolded code, not production custody**. Chromatika never presents
//! Solana pre-alpha ika as production MPC or custody (CLAUDE.md "ika solana pre-alpha"
//! disclaimer). Deployers should treat the program id as devnet-only and rebuild on Alpha-1.

use anchor_lang::prelude::*;

declare_id!("F6fnHYySvjJjvFGzqLb8h2L9qZrq2M8krNviXdNJaPsP");

/// PDA seeds for `PolicyVault`. Derived per-dWallet so each user can have many policy-gated
/// dWallets in one chromatika install. Seed shape:
///
///     [b"chromatika-policy-v1", dwallet_pubkey_bytes]
///
/// `dwallet_pubkey_bytes` is the canonical 32-byte ed25519 (or 33-byte compressed secp256k1
/// padded to 32) dWallet identity used by ika gRPC. We pass it as a fixed-32 to keep the
/// PDA seed length constant; Sui SECP keys are 33-byte compressed but we hash to 32 with
/// SHA-256 before seeding (consistent across curves).
pub const POLICY_VAULT_SEED: &[u8] = b"chromatika-policy-v1";

/// Hard floor on `unfreeze_delay_ms`. Set to 0 to mirror the Sui side's "user has full
/// control" philosophy (UI defaults to 7 days).
pub const MIN_UNFREEZE_DELAY_MS: u64 = 0;

/// 24h in milliseconds (epoch_day rollover).
pub const ONE_DAY_MS: u64 = 86_400_000;

/// Hard cap on the number of actuators per vault. Mirrors typical Solana account-size
/// budgeting; chromatika UI surfaces a warning at 8 to encourage tighter actuator hygiene.
pub const MAX_ACTUATORS: usize = 16;

/// Hard cap on the rescue address bytes (Solana base58 + UTF-8 framing fits well under 100).
pub const MAX_RESCUE_ADDRESS_BYTES: usize = 100;

#[program]
pub mod chromatika_policy {
    use super::*;

    /// Wrap the dWallet authority into a `PolicyVault` PDA. After this, the dWallet's
    /// authority on the ika side is `policy_vault_pda`; only this program's
    /// `sign_with_policy` instruction can sign for it.
    ///
    /// ## Pre-alpha gap
    /// The "transfer authority to PDA" step requires CPI'ing into the ika Solana program
    /// (which today doesn't expose a stable `set_authority` instruction at the
    /// chromatika-team's gRPC layer). Until Alpha-1, this instruction stores the policy
    /// vault PDA but the on-chain dWallet authority remains whatever ika's mock signer
    /// expected — chromatika emits a warning when running in this mode.
    pub fn wrap_authority(
        ctx: Context<WrapAuthority>,
        args: WrapAuthorityArgs,
    ) -> Result<()> {
        require!(
            args.unfreeze_delay_ms >= MIN_UNFREEZE_DELAY_MS,
            PolicyError::InvalidUnfreezeDelay
        );

        let vault = &mut ctx.accounts.policy_vault;
        vault.dwallet_pubkey_hash = args.dwallet_pubkey_hash;
        vault.network_encryption_key_id = args.network_encryption_key_id;
        vault.curve = args.curve;
        vault.signature_algorithm = args.signature_algorithm;

        // cap policy
        vault.daily_cap_micros = args.daily_cap_micros;
        vault.spent_today_micros = 0;
        vault.epoch_day = 0;
        vault.cool_down_ms = args.cool_down_ms;
        vault.last_sign_at_ms = 0;

        // panic + recovery
        vault.panicked = false;
        vault.panic_at_ms = 0;
        vault.actuators = vec![ctx.accounts.primary_actuator.key()];
        vault.unfreeze_delay_ms = args.unfreeze_delay_ms;
        vault.rescue_address_bytes = args.rescue_address_bytes;

        // staging (default OFF; user opts in later)
        vault.stage_cap_raises = false;
        vault.pending_cap_micros = None;
        vault.pending_cap_at_ms = 0;
        vault.pending_stage_off = false;
        vault.pending_stage_off_at_ms = 0;
        vault.stage_delay_ms = args.stage_delay_ms;

        // unwrap two-step: dormant at wrap; user calls request_unwrap to start the countdown
        vault.unwrap_requested = false;
        vault.unwrap_at_ms = 0;

        vault.bump = ctx.bumps.policy_vault;

        emit!(VaultCreated {
            vault: vault.key(),
            dwallet_pubkey_hash: args.dwallet_pubkey_hash,
            primary_actuator: ctx.accounts.primary_actuator.key(),
            daily_cap_micros: args.daily_cap_micros,
            unfreeze_delay_ms: args.unfreeze_delay_ms,
        });

        msg!(
            "[chromatika-policy] PRE-ALPHA: wrap_authority stored policy state but ika authority transfer awaits Alpha-1. Do NOT treat this as real custody."
        );

        Ok(())
    }

    /// Sign a message under policy. Caller declares value in micro-USD; module enforces the
    /// daily cap on declared values. Identical semantics to the Sui-side soft-policy v0;
    /// hard-policy variants (`sign_evm_with_policy`, `sign_btc_with_policy`,
    /// `sign_deso_with_policy`) decode the message bytes on-chain — those land separately
    /// once Alpha-1 ika exposes the message-bytes interface.
    ///
    /// ## Pre-alpha gap
    /// `do_approve_message_cpi` is a `todo!()` panic. The Solana ika program needs to expose
    /// a CPI target (instruction discriminator + account list) for "approve message under
    /// caller-PDA-as-authority" before this instruction can produce a real signature.
    pub fn sign_with_policy(
        ctx: Context<SignWithPolicy>,
        args: SignWithPolicyArgs,
    ) -> Result<()> {
        let actuator = ctx.accounts.actuator.key();
        let now_ms = Clock::get()?.unix_timestamp.max(0) as u64 * 1000;
        let today = now_ms / ONE_DAY_MS;

        // Phase 1: validate + lazy-commit + day rollover + cap check while holding the
        // mutable vault borrow. Scoped in a block so the borrow drops before the CPI.
        {
            let vault = &mut ctx.accounts.policy_vault;
            require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
            require!(!vault.panicked, PolicyError::Panicked);

            lazy_commit_pending(vault, now_ms);

            require!(
                now_ms >= vault.last_sign_at_ms + vault.cool_down_ms,
                PolicyError::CoolDownActive
            );

            if today != vault.epoch_day {
                vault.spent_today_micros = 0;
                vault.epoch_day = today;
            }

            if vault.daily_cap_micros > 0 {
                require!(
                    vault
                        .spent_today_micros
                        .saturating_add(args.declared_value_micros)
                        <= vault.daily_cap_micros,
                    PolicyError::CapExceeded
                );
            }
        }

        // Phase 2: approve + sign via CPI into ika Solana program. Pre-alpha gap (stub).
        // Vault mutable borrow is dropped here so we can pass `&ctx` without aliasing.
        do_approve_message_cpi(&ctx, &args)?;

        // Phase 3: post-CPI state update + event emission.
        let vault = &mut ctx.accounts.policy_vault;
        let vault_key = vault.key();
        vault.spent_today_micros = vault
            .spent_today_micros
            .saturating_add(args.declared_value_micros);
        vault.last_sign_at_ms = now_ms;

        emit!(PolicySigned {
            vault: vault_key,
            actuator,
            declared_value_micros: args.declared_value_micros,
            spent_today_after_micros: vault.spent_today_micros,
            daily_cap_micros: vault.daily_cap_micros,
        });

        Ok(())
    }

    /// Flip the panic flag. Any actuator. Idempotent.
    pub fn panic(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);

        if !vault.panicked {
            vault.panicked = true;
            vault.panic_at_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
            emit!(PanicTriggered {
                vault: vault.key(),
                actuator,
                panic_at_ms: vault.panic_at_ms,
                unfreeze_delay_ms: vault.unfreeze_delay_ms,
            });
        }
        Ok(())
    }

    /// Clear the panic flag after the unfreeze delay elapsed.
    pub fn unfreeze(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(vault.panicked, PolicyError::NotPanicked);

        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        require!(
            now_ms >= vault.panic_at_ms + vault.unfreeze_delay_ms,
            PolicyError::UnfreezeDelayActive
        );

        vault.panicked = false;
        let panic_was_at_ms = vault.panic_at_ms;
        vault.panic_at_ms = 0;
        emit!(UnfrozeTriggered {
            vault: vault.key(),
            actuator,
            panic_was_at_ms,
            unfreeze_at_ms: now_ms,
        });
        Ok(())
    }

    /// Set the daily cap. When `stage_cap_raises` is OFF, immediate any direction. When ON:
    /// raises staged behind `stage_delay_ms`; decreases immediate.
    pub fn set_daily_cap(ctx: Context<ActuatorOnly>, new_cap_micros: u64) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);

        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        lazy_commit_pending(vault, now_ms);

        let prev = vault.daily_cap_micros;
        if !vault.stage_cap_raises || new_cap_micros <= prev {
            vault.daily_cap_micros = new_cap_micros;
            // a decrease supersedes any pending raise
            vault.pending_cap_micros = None;
            vault.pending_cap_at_ms = 0;
            emit!(DailyCapChanged {
                vault: vault.key(),
                prev,
                next: new_cap_micros,
            });
        } else {
            vault.pending_cap_micros = Some(new_cap_micros);
            vault.pending_cap_at_ms = now_ms + vault.stage_delay_ms;
            emit!(PendingCapStaged {
                vault: vault.key(),
                prev,
                pending: new_cap_micros,
                commits_at_ms: vault.pending_cap_at_ms,
            });
        }
        Ok(())
    }

    pub fn set_cool_down(ctx: Context<ActuatorOnly>, new_cool_down_ms: u64) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        let prev = vault.cool_down_ms;
        vault.cool_down_ms = new_cool_down_ms;
        emit!(CoolDownChanged {
            vault: vault.key(),
            prev,
            next: new_cool_down_ms,
        });
        Ok(())
    }

    /// Set or clear the rescue address. Forbidden while panicked (an attacker who panicked
    /// could otherwise set their own rescue address before the user can react).
    pub fn set_rescue_address(
        ctx: Context<ActuatorOnly>,
        rescue_address_bytes: Option<Vec<u8>>,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        if let Some(ref bytes) = rescue_address_bytes {
            require!(
                bytes.len() <= MAX_RESCUE_ADDRESS_BYTES,
                PolicyError::RescueAddressTooLong
            );
        }
        let has_address = rescue_address_bytes.is_some();
        vault.rescue_address_bytes = rescue_address_bytes;
        emit!(RescueAddressChanged {
            vault: vault.key(),
            has_address,
        });
        Ok(())
    }

    /// Add a new actuator. Forbidden while panicked or while an unwrap is pending: the
    /// latter is the anti-bypass gate (attacker must not be able to add a confederate
    /// during their stolen-key unwrap window).
    pub fn add_actuator(ctx: Context<ActuatorOnly>, new_actuator: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        require!(!vault.unwrap_requested, PolicyError::UnwrapAlreadyRequested);
        require!(
            !vault.actuators.contains(&new_actuator),
            PolicyError::ActuatorAlreadyExists
        );
        require!(
            vault.actuators.len() < MAX_ACTUATORS,
            PolicyError::TooManyActuators
        );
        vault.actuators.push(new_actuator);
        emit!(ActuatorAdded {
            vault: vault.key(),
            actuator: new_actuator,
        });
        Ok(())
    }

    /// Remove an actuator. Forbidden while panicked. Also forbidden while an unwrap is
    /// pending: this is the critical anti-bypass gate. Attacker who stole an actuator key
    /// must not be able to `request_unwrap` and then `remove_actuator(legitimate_user)` to
    /// lock the legitimate user out of panicking during the delay window.
    pub fn remove_actuator(ctx: Context<ActuatorOnly>, target: Pubkey) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        require!(!vault.unwrap_requested, PolicyError::UnwrapAlreadyRequested);
        require!(vault.actuators.len() > 1, PolicyError::ActuatorNotFound);
        let idx = vault
            .actuators
            .iter()
            .position(|a| a == &target)
            .ok_or(PolicyError::ActuatorNotFound)?;
        vault.actuators.swap_remove(idx);
        emit!(ActuatorRemoved {
            vault: vault.key(),
            actuator: target,
        });
        Ok(())
    }

    /// Request unwrap. Mirrors the Sui Move `request_unwrap`. Actuator-only, not-panicked,
    /// no double-request. Sets `unwrap_requested = true` and `unwrap_at_ms = now + stage_delay_ms`.
    /// See the Sui-side doc comment for the bypass-attack analysis.
    pub fn request_unwrap(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        require!(!vault.unwrap_requested, PolicyError::UnwrapAlreadyRequested);

        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        let claimable_at_ms = now_ms.saturating_add(vault.stage_delay_ms);
        vault.unwrap_requested = true;
        vault.unwrap_at_ms = claimable_at_ms;

        emit!(UnwrapRequested {
            vault: vault.key(),
            actuator,
            request_at_ms: now_ms,
            claimable_at_ms,
            stage_delay_ms: vault.stage_delay_ms,
        });
        Ok(())
    }

    /// Cancel a pending unwrap. Any actuator. Idempotent. Allowed even while panicked
    /// (cancel is always safe).
    pub fn cancel_unwrap(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);

        if vault.unwrap_requested {
            vault.unwrap_requested = false;
            vault.unwrap_at_ms = 0;
            let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
            emit!(UnwrapCancelled {
                vault: vault.key(),
                actuator,
                cancelled_at_ms: now_ms,
            });
        }
        Ok(())
    }

    /// Claim the unwrap. Mirrors the Sui Move `claim_unwrap`. Actuator-only, unwrap
    /// requested, delay elapsed, not-panicked. The CPI body that resets the on-chain ika
    /// dWallet authority to the caller's pubkey is `do_release_authority_cpi`, a `todo!`
    /// stub until ika Solana Alpha-1 publishes the inverse of its caller-PDA-as-authority
    /// surface. Until then, this instruction performs the local state transition (clears
    /// `unwrap_requested`, emits the event) so storage + UI surfaces can be exercised, but
    /// does NOT actually release dWallet authority on chain.
    ///
    /// Once Alpha-1 lands, fill `do_release_authority_cpi` with the real `invoke_signed`
    /// call (the inverse of `do_approve_message_cpi`). At that point the account will also
    /// be closed (lamports returned to the actuator) to mirror Sui's `object::delete`.
    pub fn claim_unwrap(ctx: Context<ClaimUnwrap>) -> Result<()> {
        let actuator = ctx.accounts.actuator.key();
        let vault_key = ctx.accounts.policy_vault.key();
        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;

        {
            let vault = &ctx.accounts.policy_vault;
            require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
            require!(vault.unwrap_requested, PolicyError::UnwrapNotRequested);
            require!(!vault.panicked, PolicyError::Panicked);
            require!(now_ms >= vault.unwrap_at_ms, PolicyError::UnwrapDelayActive);
        }

        do_release_authority_cpi(&ctx, actuator)?;

        let vault = &mut ctx.accounts.policy_vault;
        vault.unwrap_requested = false;
        vault.unwrap_at_ms = 0;

        emit!(VaultUnwrapped {
            vault: vault_key,
            actuator,
            claimed_at_ms: now_ms,
        });
        Ok(())
    }

    /// Toggle staging. ON immediate (turning protection on is always safe); OFF staged.
    pub fn set_stage_cap_raises(ctx: Context<ActuatorOnly>, next: bool) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);

        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        lazy_commit_pending(vault, now_ms);

        let prev = vault.stage_cap_raises;
        if prev == next {
            return Ok(());
        }
        if !prev && next {
            vault.stage_cap_raises = true;
            vault.pending_stage_off = false;
            vault.pending_stage_off_at_ms = 0;
            emit!(StageCapRaisesToggled {
                vault: vault.key(),
                prev,
                next,
                staged_until_ms: 0,
            });
        } else {
            vault.pending_stage_off = true;
            vault.pending_stage_off_at_ms = now_ms + vault.stage_delay_ms;
            emit!(PendingStageOffStaged {
                vault: vault.key(),
                commits_at_ms: vault.pending_stage_off_at_ms,
            });
        }
        Ok(())
    }

    pub fn set_stage_delay_ms(ctx: Context<ActuatorOnly>, new_delay_ms: u64) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        require!(!vault.panicked, PolicyError::Panicked);
        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        lazy_commit_pending(vault, now_ms);

        let prev = vault.stage_delay_ms;
        // Increase always immediate (more conservative); decrease staged when staging is on.
        if !vault.stage_cap_raises || new_delay_ms >= prev {
            vault.stage_delay_ms = new_delay_ms;
            emit!(StageDelayChanged {
                vault: vault.key(),
                prev,
                next: new_delay_ms,
                staged: false,
            });
        } else {
            // v0 parity with the Sui side: emit-only; the user must accept the existing
            // larger delay until they explicitly toggle staging off.
            emit!(StageDelayChanged {
                vault: vault.key(),
                prev,
                next: new_delay_ms,
                staged: true,
            });
        }
        Ok(())
    }

    pub fn commit_pending_cap(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        lazy_commit_pending(vault, now_ms);
        Ok(())
    }

    pub fn commit_pending_stage_off(ctx: Context<ActuatorOnly>) -> Result<()> {
        let vault = &mut ctx.accounts.policy_vault;
        let actuator = ctx.accounts.actuator.key();
        require!(vault.actuators.contains(&actuator), PolicyError::NotActuator);
        let now_ms = (Clock::get()?.unix_timestamp.max(0) as u64) * 1000;
        lazy_commit_pending(vault, now_ms);
        Ok(())
    }
}

/// Internal: apply any staged changes whose delay has elapsed. Idempotent.
fn lazy_commit_pending(vault: &mut Account<PolicyVault>, now_ms: u64) {
    if let Some(next) = vault.pending_cap_micros {
        if now_ms >= vault.pending_cap_at_ms {
            let prev = vault.daily_cap_micros;
            vault.daily_cap_micros = next;
            vault.pending_cap_micros = None;
            vault.pending_cap_at_ms = 0;
            emit!(PendingCapCommitted {
                vault: vault.key(),
                prev,
                next,
            });
        }
    }
    if vault.pending_stage_off && now_ms >= vault.pending_stage_off_at_ms {
        vault.stage_cap_raises = false;
        vault.pending_stage_off = false;
        vault.pending_stage_off_at_ms = 0;
        emit!(PendingStageOffCommitted {
            vault: vault.key(),
        });
    }
}

/// Pre-alpha CPI stub. Returns `Ok(())` so the rest of the policy enforcement can be
/// exercised in tests and gRPC stubs, but emits a `msg!` warning that no real signature was
/// produced. Once ika Solana Alpha-1 lands and exposes a CPI target for "approve message
/// under caller-PDA-as-authority," replace this body with the real `invoke_signed`.
fn do_approve_message_cpi(
    _ctx: &Context<SignWithPolicy>,
    _args: &SignWithPolicyArgs,
) -> Result<()> {
    msg!(
        "[chromatika-policy] PRE-ALPHA: do_approve_message_cpi is a no-op stub. ika Solana Alpha-1 must expose a CPI target for caller-PDA-as-authority approve_message before this can produce real signatures."
    );
    Ok(())
}

/// Pre-alpha CPI stub for releasing dWallet authority back to the actuator (the inverse of
/// `do_approve_message_cpi`). Once ika Solana Alpha-1 publishes a CPI target for
/// "set dWallet authority under caller-PDA-as-authority," replace this body with the real
/// `invoke_signed` that resets the on-chain dWallet authority to `new_authority`.
///
/// Until then, this is a no-op so the policy-vault state transition (clearing
/// `unwrap_requested`, emitting `VaultUnwrapped`) can be exercised end-to-end at the
/// chromatika layer without a working ika authority transfer. The vault account itself is
/// NOT closed in this pre-alpha stub; once the real CPI lands, switch to `close = actuator`
/// on the `policy_vault` account constraint so claim_unwrap returns rent to the caller and
/// burns the PDA, mirroring Sui's `object::delete` consumption.
fn do_release_authority_cpi(_ctx: &Context<ClaimUnwrap>, _new_authority: Pubkey) -> Result<()> {
    msg!(
        "[chromatika-policy] PRE-ALPHA: do_release_authority_cpi is a no-op stub. ika Solana Alpha-1 must expose a CPI target for caller-PDA-as-authority set_authority before claim_unwrap can actually release the dWallet."
    );
    Ok(())
}

// ─── account contexts ────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(args: WrapAuthorityArgs)]
pub struct WrapAuthority<'info> {
    /// The user paying rent + becoming the primary actuator.
    #[account(mut)]
    pub primary_actuator: Signer<'info>,
    /// The PolicyVault PDA. Seeds = [b"chromatika-policy-v1", dwallet_pubkey_hash].
    #[account(
        init,
        payer = primary_actuator,
        space = PolicyVault::ACCOUNT_SIZE,
        seeds = [POLICY_VAULT_SEED, args.dwallet_pubkey_hash.as_ref()],
        bump,
    )]
    pub policy_vault: Account<'info, PolicyVault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SignWithPolicy<'info> {
    #[account(mut, seeds = [POLICY_VAULT_SEED, policy_vault.dwallet_pubkey_hash.as_ref()], bump = policy_vault.bump)]
    pub policy_vault: Account<'info, PolicyVault>,
    pub actuator: Signer<'info>,
    /// CHECK: ika program account; validated at CPI time once the Alpha-1 surface is wired.
    pub ika_program: AccountInfo<'info>,
    /// CHECK: ika dWallet PDA; validated at CPI time.
    pub ika_dwallet: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct ActuatorOnly<'info> {
    #[account(mut, seeds = [POLICY_VAULT_SEED, policy_vault.dwallet_pubkey_hash.as_ref()], bump = policy_vault.bump)]
    pub policy_vault: Account<'info, PolicyVault>,
    pub actuator: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimUnwrap<'info> {
    #[account(mut, seeds = [POLICY_VAULT_SEED, policy_vault.dwallet_pubkey_hash.as_ref()], bump = policy_vault.bump)]
    pub policy_vault: Account<'info, PolicyVault>,
    /// Receives the released dWallet authority once `do_release_authority_cpi` is wired up.
    #[account(mut)]
    pub actuator: Signer<'info>,
    /// CHECK: ika program account; validated at CPI time once Alpha-1 publishes the inverse
    /// of caller-PDA-as-authority set_authority.
    pub ika_program: AccountInfo<'info>,
    /// CHECK: ika dWallet PDA whose authority will be reset. Validated at CPI time.
    #[account(mut)]
    pub ika_dwallet: AccountInfo<'info>,
}

// ─── account data + arg structs ──────────────────────────────────────────────────

#[account]
pub struct PolicyVault {
    /// 32-byte hash of the dWallet identity pubkey. Lets the PDA seed be a fixed length
    /// across curves (Curve25519 is 32 bytes; Secp256k1 compressed is 33 bytes; we hash
    /// to normalize). Hash function: SHA-256.
    pub dwallet_pubkey_hash: [u8; 32],
    pub network_encryption_key_id: Pubkey,
    pub curve: u16,
    pub signature_algorithm: u16,
    pub daily_cap_micros: u64,
    pub spent_today_micros: u64,
    pub epoch_day: u64,
    pub cool_down_ms: u64,
    pub last_sign_at_ms: u64,
    pub panicked: bool,
    pub panic_at_ms: u64,
    pub unfreeze_delay_ms: u64,
    pub actuators: Vec<Pubkey>,
    pub rescue_address_bytes: Option<Vec<u8>>,

    // staging (cap-increase staged delay opt-in safety)
    pub stage_cap_raises: bool,
    pub pending_cap_micros: Option<u64>,
    pub pending_cap_at_ms: u64,
    pub pending_stage_off: bool,
    pub pending_stage_off_at_ms: u64,
    pub stage_delay_ms: u64,

    // unwrap two-step (user-controlled exit; mirrors the Sui Move sign_gate semantics)
    pub unwrap_requested: bool,
    pub unwrap_at_ms: u64,

    pub bump: u8,
}

impl PolicyVault {
    /// Worst-case account size (with all Vec/Option fields at max). Anchor 8-byte
    /// discriminator + struct fields:
    ///   - dwallet_pubkey_hash: 32
    ///   - network_encryption_key_id: 32
    ///   - curve: 2 + signature_algorithm: 2
    ///   - 6 x u64 (cap, spent, epoch, cool, last_sign, panic_at): 48
    ///   - panicked: 1
    ///   - unfreeze_delay_ms: 8
    ///   - actuators: 4 (Vec len) + 32 * MAX_ACTUATORS = 4 + 512 = 516
    ///   - rescue_address_bytes: 1 (Option tag) + 4 (Vec len) + MAX_RESCUE_ADDRESS_BYTES = 105
    ///   - stage_cap_raises: 1
    ///   - pending_cap_micros: 1 + 8 = 9
    ///   - pending_cap_at_ms: 8
    ///   - pending_stage_off: 1
    ///   - pending_stage_off_at_ms: 8
    ///   - stage_delay_ms: 8
    ///   - unwrap_requested: 1
    ///   - unwrap_at_ms: 8
    ///   - bump: 1
    /// Total fields: 781 + 9 = 790 bytes. Plus 8 discriminator + ~32 padding for safety = 833.
    pub const ACCOUNT_SIZE: usize = 8 + 32 + 32 + 2 + 2 + 48 + 1 + 8 + 516 + 105 + 1 + 9 + 8 + 1 + 8 + 8 + 1 + 8 + 1 + 32;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct WrapAuthorityArgs {
    pub dwallet_pubkey_hash: [u8; 32],
    pub network_encryption_key_id: Pubkey,
    pub curve: u16,
    pub signature_algorithm: u16,
    pub daily_cap_micros: u64,
    pub cool_down_ms: u64,
    pub unfreeze_delay_ms: u64,
    pub rescue_address_bytes: Option<Vec<u8>>,
    pub stage_delay_ms: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SignWithPolicyArgs {
    pub message: Vec<u8>,
    pub declared_value_micros: u64,
    pub hash_scheme: u32,
    pub message_centralized_signature: Vec<u8>,
}

// ─── events ──────────────────────────────────────────────────────────────────────

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub dwallet_pubkey_hash: [u8; 32],
    pub primary_actuator: Pubkey,
    pub daily_cap_micros: u64,
    pub unfreeze_delay_ms: u64,
}

#[event]
pub struct PolicySigned {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub declared_value_micros: u64,
    pub spent_today_after_micros: u64,
    pub daily_cap_micros: u64,
}

#[event]
pub struct PanicTriggered {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub panic_at_ms: u64,
    pub unfreeze_delay_ms: u64,
}

#[event]
pub struct UnfrozeTriggered {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub panic_was_at_ms: u64,
    pub unfreeze_at_ms: u64,
}

#[event]
pub struct ActuatorAdded {
    pub vault: Pubkey,
    pub actuator: Pubkey,
}

#[event]
pub struct ActuatorRemoved {
    pub vault: Pubkey,
    pub actuator: Pubkey,
}

#[event]
pub struct DailyCapChanged {
    pub vault: Pubkey,
    pub prev: u64,
    pub next: u64,
}

#[event]
pub struct CoolDownChanged {
    pub vault: Pubkey,
    pub prev: u64,
    pub next: u64,
}

#[event]
pub struct RescueAddressChanged {
    pub vault: Pubkey,
    pub has_address: bool,
}

#[event]
pub struct StageCapRaisesToggled {
    pub vault: Pubkey,
    pub prev: bool,
    pub next: bool,
    pub staged_until_ms: u64,
}

#[event]
pub struct PendingCapStaged {
    pub vault: Pubkey,
    pub prev: u64,
    pub pending: u64,
    pub commits_at_ms: u64,
}

#[event]
pub struct PendingCapCommitted {
    pub vault: Pubkey,
    pub prev: u64,
    pub next: u64,
}

#[event]
pub struct PendingStageOffStaged {
    pub vault: Pubkey,
    pub commits_at_ms: u64,
}

#[event]
pub struct PendingStageOffCommitted {
    pub vault: Pubkey,
}

#[event]
pub struct StageDelayChanged {
    pub vault: Pubkey,
    pub prev: u64,
    pub next: u64,
    pub staged: bool,
}

#[event]
pub struct UnwrapRequested {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub request_at_ms: u64,
    pub claimable_at_ms: u64,
    pub stage_delay_ms: u64,
}

#[event]
pub struct UnwrapCancelled {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub cancelled_at_ms: u64,
}

#[event]
pub struct VaultUnwrapped {
    pub vault: Pubkey,
    pub actuator: Pubkey,
    pub claimed_at_ms: u64,
}

// ─── errors ──────────────────────────────────────────────────────────────────────

#[error_code]
pub enum PolicyError {
    #[msg("caller not in actuators list")]
    NotActuator,
    #[msg("declared value would breach daily cap")]
    CapExceeded,
    #[msg("cool-down between sends still active")]
    CoolDownActive,
    #[msg("vault is panicked")]
    Panicked,
    #[msg("vault is not panicked")]
    NotPanicked,
    #[msg("unfreeze delay still active")]
    UnfreezeDelayActive,
    #[msg("invalid unfreeze delay")]
    InvalidUnfreezeDelay,
    #[msg("actuator already in list")]
    ActuatorAlreadyExists,
    #[msg("actuator not found / cannot remove last actuator")]
    ActuatorNotFound,
    #[msg("too many actuators (max 16)")]
    TooManyActuators,
    #[msg("rescue address bytes exceed 100-byte cap")]
    RescueAddressTooLong,
    #[msg("no unwrap has been requested")]
    UnwrapNotRequested,
    #[msg("unwrap delay still active")]
    UnwrapDelayActive,
    #[msg("an unwrap is already pending")]
    UnwrapAlreadyRequested,
}
