# Policy Vault deploy quickstart (chromatika team only)

> **internal team doc.** End users never deploy their own Policy Vault package. The team publishes the audited production cut with the UpgradeCap burned in the same transaction (Sui) or the upgrade authority set to `--final` (Solana), and ships the resulting identifiers via the built-in registry at [`src/background/policy-vault/policy-vault-builtin.ts`](../src/background/policy-vault/policy-vault-builtin.ts). The user-facing trust story lives at [`local/wallet-special/policy-vault-deployment.md`](../../local/wallet-special/policy-vault-deployment.md).
>
> Sui mainnet is already shipped: package id `0x8cd25cd3ae7966b61eeae97d77b7e029b29b37307b533b505c6a76b63e22d727` (published 2026-05-11). End users on Sui mainnet get the package automatically. Use this doc when you (the team) need to:
> - Run an **iteration deploy** (no `:final` flag) to test bug fixes against a mutable package while the UpgradeCap stays on the deployer keypair. Common for testnet / devnet work.
> - Run the **audited production deploy** (`:final` flag) once the bytecode is audit-clean. This consumes the UpgradeCap atomically (Sui) or sets upgrade authority to None (Solana). After `:final`, the package is immutable forever; bugfixes require a fresh package + chromatika-side migration via the unwrap two-step.

> one-page setup for running `pnpm run deploy:sui-policy:*` and `pnpm run deploy:solana-policy:*`. covers the prereq CLIs, wallet setup, funding, and the actual deploy commands. linked from [`POLICY_VAULT.md`](POLICY_VAULT.md) and [`POLICY_VAULT_SOLANA.md`](POLICY_VAULT_SOLANA.md).

---

## TL;DR

```bash
cd wallet-extension

# Sui (production-ready):
pnpm run build:sui-policy                  # sui move build
pnpm run test:sui-policy                   # sui move test
pnpm run deploy:sui-policy:testnet         # iteration deploy (UpgradeCap retained for bugfixes)
pnpm run deploy:sui-policy:testnet:final   # AUDITED PRODUCTION CUT: burns the UpgradeCap atomically
# -> for iteration deploys, paste the id into Settings via the "chromatika team only" details block.
# -> for `:final` deploys, paste the id, bytecode hash, audit refs into policy-vault-builtin.ts
#    and ship a chromatika release.

# Solana (PRE-ALPHA, devnet only - mock signing, never real funds):
pnpm run build:solana-policy               # anchor build
pnpm run deploy:solana-policy:devnet       # iteration deploy (upgrade authority retained)
pnpm run deploy:solana-policy:devnet:final # AUDITED PRODUCTION CUT: sets upgrade authority to None
# -> same registry-paste-and-release flow as Sui for :final deploys.
```

If both CLIs are already installed and your wallets are funded, that's it. Otherwise read the per-CLI sections below.

---

## Sui CLI setup

### 1. Install

| OS | command |
|---|---|
| macOS / Linux | `brew install sui` (Homebrew) or build from source per [docs.sui.io](https://docs.sui.io/guides/developer/getting-started/sui-install) |
| Windows | Download the prebuilt binary from [github.com/MystenLabs/sui/releases](https://github.com/MystenLabs/sui/releases), unzip, add to PATH |

verify:

```bash
sui --version
# sui 1.x.x ...
```

### 2. Create a Sui keypair

```bash
sui client                                  # first run prompts for env + keypair
# choose: testnet (recommended for chromatika dev)
# choose: ed25519 (default)
# save the recovery phrase somewhere safe
```

verify:

```bash
sui client active-address
sui client envs                             # shows registered envs (testnet/mainnet/devnet/...)
```

### 3. Fund the keypair

| env | how |
|---|---|
| testnet | `sui client faucet` (built-in faucet) or [discord faucet](https://discord.com/channels/916379725201563759/971488439931392130) |
| mainnet | bridge / buy SUI on-exchange and send to `sui client active-address` |
| devnet  | `sui client faucet` |
| localnet | the local validator pre-funds the active address |

You need ~0.5 SUI for the publish (default `--gas-budget 200000000` = 0.2 SUI plus headroom).

### 4. Deploy

```bash
cd wallet-extension

pnpm run deploy:sui-policy:testnet          # iteration deploy (most common during dev)
pnpm run deploy:sui-policy:mainnet          # iteration on mainnet (rarely needed)
pnpm run deploy:sui-policy:devnet           # iteration on devnet
pnpm run deploy:sui-policy                  # uses whichever env is active

# ── AUDITED PRODUCTION CUT (consumes UpgradeCap; package becomes immutable forever) ──
pnpm run deploy:sui-policy:testnet:final
pnpm run deploy:sui-policy:mainnet:final    # the real production deploy
pnpm run deploy:sui-policy:devnet:final
```

Expected output ends with:

```
-----------------------------------------------------------
  chromatika_policy published
-----------------------------------------------------------
  packageId: 0xabcd...

  next steps:
    1. open chromatika side panel
    2. Policy Vault tab (bottom nav)
    3. paste the packageId above into the input, click save
    4. opt in your dWallet via the panel
-----------------------------------------------------------
```

### 5. Per-flag tips

- `--build-only` (`pnpm run build:sui-policy`): faster CI smoke; runs `sui move build` and exits
- `--dry-run` (`pnpm run deploy:sui-policy:dry-run`): runs `sui client publish --dry-run` to estimate gas without spending
- `--gas-budget <mist>`: override the default 0.2 SUI gas cap (rarely needed)
- `--skip-deps`: passes `--skip-fetch-latest-git-deps` to sui — useful for offline / iterative work

### 6. Test the package locally

```bash
pnpm run test:sui-policy
# runs `sui move test --path move/chromatika-policy`
# exercises the Move-side fixtures for sign_gate, sign_gate_evm, sign_gate_btc, sign_gate_deso
```

---

## Solana CLI + Anchor setup

> ⚠️ **PRE-ALPHA - devnet only.** Solana ika today uses a single mock signer (not real MPC); on-chain data wipes on Alpha-1; chromatika never presents Solana pre-alpha as production custody. This setup is for storage-shape + UI-surface validation. Do NOT submit real-value transactions.

### 1. Install Solana CLI

| OS | command |
|---|---|
| macOS / Linux | `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"` |
| Windows | `cmd /c "curl https://release.anza.xyz/stable/solana-install-init-x86_64-pc-windows-msvc.exe --output C:\solana-install-tmp\solana-install-init.exe --create-dirs"` then run the .exe |

verify:

```bash
solana --version
```

### 2. Install Anchor

Anchor is the smart-contract framework chromatika's Solana program uses.

```bash
# avm (Anchor version manager) is the recommended path:
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest
```

verify:

```bash
anchor --version
# anchor-cli 0.30.x
```

### 3. Create + fund a Solana keypair

```bash
solana-keygen new --outfile ~/.config/solana/id.json     # save recovery phrase
solana config set --url devnet                           # devnet only for chromatika pre-alpha
solana airdrop 2                                         # 2 SOL from devnet faucet
solana balance                                           # confirm
```

You need ~1 SOL for the first deploy (program account allocation rent + the deploy tx fees). Anchor sometimes needs more on retries; airdrop another 2 SOL if the deploy fails with insufficient lamports.

### 4. Deploy

```bash
cd wallet-extension

pnpm run deploy:solana-policy:devnet
# This:
#   1. runs `anchor build` (compiles the program; generates target/deploy/chromatika_policy-keypair.json on first build)
#   2. reads the program pubkey from that keypair
#   3. splices the pubkey into lib.rs `declare_id!()` and Anchor.toml [programs.devnet]
#   4. rebuilds (so the binary's declare_id! matches the keypair pubkey)
#   5. runs `anchor deploy --provider.cluster devnet`
```

Expected output ends with:

```
-----------------------------------------------------------
  chromatika-policy (Solana) deployed
-----------------------------------------------------------
  cluster:    devnet
  program id: ChrPo1icyVau1tProgr...

  next steps:
    1. open chromatika side panel
    2. Policy Vault tab (bottom nav)
    3. paste the program id into the Solana program id field
    4. opt in your Solana-base dWallet (pre-alpha; CPI body is a stub
       until ika Solana Alpha-1)

  honesty disclosure: ... [pre-alpha disclaimer]
-----------------------------------------------------------
```

### 5. Per-flag tips

- `--cluster devnet|testnet|mainnet|localnet`: target cluster (defaults to whatever Anchor.toml says)
- `--sync-program-id`: splice the keypair's pubkey into source files before deploying. Always set on the `:devnet` script; pass yourself if running the bare `deploy:solana-policy`
- `--build-only` (`pnpm run build:solana-policy`): runs `anchor build` and exits
- `--skip-build`: skip the build step (assume `target/` is current)
- `--dry-run`: print what would run without invoking `anchor deploy`

### 6. Test the program

```bash
pnpm run test:solana-policy
# runs: anchor test --skip-local-validator --provider.cluster devnet
# requires the program to already be deployed (or use `anchor test` without --skip-local-validator
# to spin up a local validator + auto-deploy from the project's tests/ dir)
```

---

## Where the program ids land in chromatika

Both deploys end by pointing you at the same UI surface:

**chromatika side panel -> Policy Vault tab (bottom nav)**

That panel has separate input fields for the Sui packageId and the Solana program id (when present). Pasting either flips the storage shape (`PolicyPackageConfig` in [`policy-vault-storage.ts`](../src/background/policy-vault/policy-vault-storage.ts)) and unlocks the per-vault opt-in flow on dWallets matching that base chain.

---

## Common failures + fixes

### `sui CLI not found on PATH`

You haven't installed sui or it's not on your shell PATH. Verify with `sui --version` from a new shell. On Windows, after dropping `sui.exe` into a folder, add that folder to the system PATH via `setx PATH "%PATH%;C:\path\to\sui"` (then reopen the terminal).

### `Error: command "publish" failed: insufficient gas`

Your active sui address doesn't have enough SUI. `sui client active-address`, then fund it via faucet (testnet/devnet) or transfer (mainnet). The default gas budget is 0.2 SUI; you need at least that much liquid.

### `anchor deploy` fails with `Account: ... has insufficient funds`

Same fix on the Solana side: `solana balance` to confirm the active keypair, `solana airdrop 2` to top up devnet. Anchor program deploys are unusually expensive (~1+ SOL for the first deploy because of rent on the program account).

### sui publish prints output but the script can't extract `packageId`

The script logs the full publish stdout when extraction fails — copy the `packageId` manually from `objectChanges -> type: "published"` and paste into chromatika.

### Solana deploy: "program id mismatch with declare_id!"

You built without `--sync-program-id` and the keypair pubkey doesn't match the lib.rs literal. Re-run with the `:devnet` script (which always passes `--sync-program-id`), or run `pnpm run deploy:solana-policy --sync-program-id --cluster devnet` explicitly.

---

## Related

- [`POLICY_VAULT.md`](POLICY_VAULT.md): Sui-base architecture, threat model, opt-in flow, audit log
- [`POLICY_VAULT_SOLANA.md`](POLICY_VAULT_SOLANA.md): Solana-base architecture, pre-alpha gap, Alpha-1 body-swap plan
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index
- [`scripts/deploy-sui-policy.mjs`](../scripts/deploy-sui-policy.mjs): the script source (has `--help`)
- [`scripts/deploy-solana-policy.mjs`](../scripts/deploy-solana-policy.mjs): same
