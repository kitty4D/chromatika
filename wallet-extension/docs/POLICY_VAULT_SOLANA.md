# Policy Vault — Solana base (chromatika)

> status (2026-05-11): **DISABLED in UI; pre-alpha scaffolding; awaits ika Solana Alpha-1.** The chromatika-policy Solana program mirrors `chromatika_policy::sign_gate` (Sui Move) field-for-field, but the on-chain `do_approve_message_cpi` is a no-op stub until ika Solana exposes a CPI target for caller-PDA-as-authority approve_message. Wrapping a Solana-base dWallet in the policy program would not gate anything until Alpha-1, so chromatika reflects that honesty by **disabling the surface in the wallet UI today**:
>
> - `PolicyVaultPanel` renders a "Sui-only for now" notice when the active vault's baseChain is `solana` instead of the opt-in form.
> - `PolicyVaultBanner` does not mount on Solana sends.
> - `optInToPolicyVault` throws `no-package` on Solana-base as defense-in-depth.
>
> The Anchor program source stays in tree as Alpha-1 scaffolding (`anchor build` works for compile verification). **No TS test harness exists today**: `solana-bankrun` and `litesvm` (the two viable in-process Solana VMs for TS tests) both ship no Windows binary, Docker is upstream's documented Windows workaround, and the program has no real signer to test against until Alpha-1 lands. When Alpha-1 ships, both the program CPI bodies and the chromatika UI gates flip in one coordinated change.

## Why this is shipped scoped down

Solana ika is in pre-alpha:
- Solana ika today uses a **single mock signer** (not distributed MPC); signatures aren't real custody.
- The Solana ika program + on-chain data **WILL BE WIPED** on Alpha-1.
- chromatika **never presents Solana pre-alpha as production MPC or custody.**

Building a fully working Solana-base policy gate today would burn effort that gets wiped. The shipped slice is the maximally useful thing we can build without risking that wipe:
- Full Anchor program with the PolicyVault PDA + every instruction the Sui side has.
- Full TS dispatch scaffolding so Settings / opt-in / panic / cap setters all wire up.
- A clean "pre-alpha-cpi-stub" failure mode so callers know to fall back instead of silent failure.

When Alpha-1 ships, the only file changes needed to flip Solana base from soft to hard policy are: (a) replace `do_approve_message_cpi` body with the real `invoke_signed`, (b) flip `signBytesThroughPolicySolana` to actually build + send the Solana ix instead of throwing.

## Architecture

```
wallet-extension/solana/chromatika-policy/
├── Anchor.toml                                    Anchor config; placeholder program id
├── Cargo.toml                                     workspace
└── programs/chromatika-policy/
    ├── Cargo.toml                                 anchor-lang = "0.30.1"
    └── src/lib.rs                                 PolicyVault PDA + 12 instructions

wallet-extension/src/background/policy-vault/
├── policy-vault-storage.ts                        PolicyPackageConfig.solanaProgramId +
│                                                  PolicyVaultLink.baseChain
├── policy-vault-sign-solana.ts                    NEW: shouldDispatchThroughPolicySolana,
│                                                  signBytesThroughPolicySolana
│                                                  (throws pre-alpha-cpi-stub today)
└── policy-vault-sign.ts                           Sui-base; unchanged
```

### Solana program (lib.rs)

Mirrors the Sui `PolicyVault` struct field-for-field:

| Sui Move field | Solana account field | Notes |
|---|---|---|
| `dwallet_cap: DWalletCap` | `dwallet_pubkey_hash: [u8; 32]` | Sui has a transferable capability object; Solana doesn't, so the PDA is the authority. The 32-byte hash normalizes Curve25519 (32) and Secp256k1-compressed (33) keys to a fixed seed length. |
| `presigns: vector<UnverifiedPresignCap>` | (none in v0) | Sui pools presigns inside the vault; Solana per-Sign Presign is fresh per gRPC request (Solana-base ika never pools `ED25519_EDDSA`: RFC 8032 deterministic + pre-alpha gRPC `PresignForDWallet` is ECDSA-only). |
| `dwallet_network_encryption_key_id: ID` | `network_encryption_key_id: Pubkey` | parity. |
| `panicked / panic_at_ms` | same | parity. |
| `daily_cap_micros / spent_today_micros / epoch_day` | same | parity; same ms/micro-USD semantics. |
| `cool_down_ms / last_sign_at_ms` | same | parity. |
| `actuators: vector<address>` | `actuators: Vec<Pubkey>` | capped at 16 (`MAX_ACTUATORS`) for Solana account-size budgeting. |
| `unfreeze_delay_ms` | same | `MIN_UNFREEZE_DELAY_MS = 0` mirrors Sui. |
| `rescue_address_bytes: Option<vector<u8>>` | `rescue_address_bytes: Option<Vec<u8>>` | capped at 100 bytes. |
| `stage_cap_raises / pending_cap_micros / pending_cap_at_ms / pending_stage_off / pending_stage_off_at_ms / stage_delay_ms` | same | full parity for the cap-increase staged delay opt-in safety. |
| (none) | `bump: u8` | Anchor PDA bump. |

Account size: ~824 bytes (8 disc + 32 hash + 32 enc-key + 4 curve+sigalgo + 48 u64 fields + 1 panic + 8 unfreeze-delay + 516 actuators + 105 rescue + 1 stage-flag + 9 pending-cap-option + 8 pending-cap-at + 1 stage-off + 8 stage-off-at + 8 stage-delay + 1 bump + 32 padding).

### PDA seed scheme

```
seeds = [b"chromatika-policy-v1", dwallet_pubkey_hash[32]]
```

`dwallet_pubkey_hash` is `SHA-256(dwallet_pubkey_bytes)` — chromatika TS computes this once at opt-in and persists it on the link record so subsequent calls don't re-hash.

### Pre-alpha CPI gap (the one thing missing)

`do_approve_message_cpi` is intentionally a `Ok(())` stub with a `msg!` warning. The reason: there's no published ika Solana program API today for "approve message under caller-PDA-as-authority." When Alpha-1 ships:

```rust
fn do_approve_message_cpi(ctx: &Context<SignWithPolicy>, args: &SignWithPolicyArgs) -> Result<()> {
    let signer_seeds: &[&[&[u8]]] = &[&[
        POLICY_VAULT_SEED,
        ctx.accounts.policy_vault.dwallet_pubkey_hash.as_ref(),
        &[ctx.accounts.policy_vault.bump],
    ]];
    // TODO Alpha-1: replace with the real ika program account discriminator + accounts list.
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.ika_program.clone(),
        ApproveMessage {
            authority: ctx.accounts.policy_vault.to_account_info(),
            dwallet: ctx.accounts.ika_dwallet.clone(),
        },
        signer_seeds,
    );
    ika_cpi::approve_message(cpi_ctx, args.message.clone(), args.message_centralized_signature.clone(), args.hash_scheme)
}
```

## Storage extensions

`PolicyPackageConfig.solanaProgramId?: string` — base58 Solana pubkey of the deployed chromatika-policy program. Required only when the user has at least one Solana-base dWallet they want to opt in. Sui-base users see no behavior change; the field is optional + ignored when null.

`PolicyVaultLink.baseChain?: 'sui' | 'solana'` — defaults to 'sui' (back-compat). When 'solana', `vaultObjectId` is a base58 PDA address instead of a 0x-prefixed Sui object id; `dwalletId` is also a base58 PDA. `setPolicyVaultLink` validation branches accordingly.

## Deploy runbook (devnet only — pre-alpha)

> ⚠️ Not for mainnet. Solana ika is pre-alpha mock signing; never submit real-value transactions through this stack. This deploy is purely for **chromatika team / contributors exercising the storage shape + UI surface** so when Alpha-1 ships, everything except the CPI body is already validated.

```bash
# 1. Build
cd wallet-extension/solana/chromatika-policy
anchor build

# 2. Capture the program id (anchor generates a keypair on first build)
solana address -k target/deploy/chromatika_policy-keypair.json
# -> ChrPo1icyVaultRealProgramID11111... (whatever pops out)

# 3. Update the placeholder in three places:
#   a. Anchor.toml [programs.devnet]
#   b. lib.rs declare_id!(...)
#   c. chromatika Settings -> Security -> "On-chain spend caps + panic" -> Solana program id

# 4. Re-build + deploy to devnet
anchor build
anchor deploy --provider.cluster devnet

# 5. Verify it deployed (program account should exist)
solana program show <programId> --url devnet
```

## Opt-in flow (chromatika UI)

1. Active vault must be on Solana ika base (the vault context bar shows the base chain).
2. Settings -> Security -> "On-chain spend caps + panic". Paste the Solana program id.
3. Click "opt in" — same form fields as Sui-base (cap, cool-down, unfreeze delay, rescue, stage delay).
4. chromatika TS:
   - Computes `dwalletPubkeyHash = sha256(dwalletPubkey)`.
   - Derives the PDA: `findProgramAddress([b"chromatika-policy-v1", dwalletPubkeyHash], programId)`.
   - Builds the `wrap_authority` ix.
   - Sends via the existing Solana fee payer + connection.
   - Persists `PolicyVaultLink { baseChain: 'solana', vaultObjectId: <pda>, dwalletId: <dwalletPda>, ... }`.
5. Pre-alpha: the ika program's authority transfer is **not yet wired**. chromatika emits a runtime warning + audit-log entry noting the dWallet's ika-side authority remains the mock-signer-controlled key.

## Sign dispatch (today vs. Alpha-1)

```ts
// wallet-extension/src/background/chains/<chain>/<send>.ts
import { trySignBytesThroughPolicySolana } from '@/background/policy-vault/policy-vault-sign-solana';

// Solana-base SECP / ED25519 sign:
const out = await trySignBytesThroughPolicySolana({ message, hashScheme, declaredValueMicros });
if (out) {
  // post-Alpha-1: real signature from chromatika-policy's sign_with_policy CPI
  return out;
}
// Pre-Alpha-1 fallback: existing direct gRPC path. chromatika UI shows the
// "Solana base soft-policy only" banner while in this mode.
return signBytesDirectSolana(...);
```

## Threat model fit (today vs. Alpha-1)

**Today (pre-alpha)**:
- Soft-policy enforcement via chromatika TS only (cap + cool-down + panic checked client-side before signing).
- Audit log captures every Solana-base sign attempt + every "policy fallback" event.
- An attacker who controls chromatika can bypass; the on-chain Solana program does not yet enforce.
- Mock-signer ika gRPC issues signatures regardless. **Honestly disclosed; not real custody.**

**Post Alpha-1**:
- The same flip the Sui side already has: on-chain `sign_with_policy` enforces; even a fully-compromised chromatika cannot bypass.
- `panic()` flips a flag on the PolicyVault PDA; the program refuses to CPI into ika until unfreeze.
- Multi-actuator + rescue address + cap-staged-delay all become real on-chain controls.

## Verification

TS tests:
```
cd wallet-extension
pnpm test --run src/background/policy-vault
```

Solana program tests (post-deploy):
```
cd wallet-extension/solana/chromatika-policy
anchor test --skip-local-validator --provider.cluster devnet
```

Manual e2e (post-Alpha-1):
1. Deploy chromatika-policy to devnet.
2. Opt in a Solana-base dWallet via Settings.
3. Try an under-cap send -> succeeds via `sign_with_policy` CPI.
4. Try an over-cap send -> aborts with `CapExceeded`.
5. Click PANIC -> on-chain panic flips; subsequent sends abort with `Panicked`.
6. Wait the unfreeze delay -> click UNFREEZE -> signing resumes.

## Related

- [`POLICY_DEPLOY_QUICKSTART.md`](POLICY_DEPLOY_QUICKSTART.md): one-page CLI setup + `pnpm run deploy:*` commands for both the Sui Move package and this Anchor program
- [`POLICY_VAULT.md`](POLICY_VAULT.md): the Sui-base parent doc; the source of truth for semantics.
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index.
