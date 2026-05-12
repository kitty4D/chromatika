# Policy Vault: how chromatika ships on-chain spend caps, panic, and rescue

> Status: design doc, pending the first production deploy. The four primitives (caps, cooldown, rescue, panic) ship in chromatika today behind a `chromatika_policy` Sui Move package; this doc covers the deployment + trust story we are landing for the public production cut.

This page explains, in plain English, how chromatika's "on-chain spend caps and panic button" feature is built, why we ship it the way we do, and how you can verify the trust claims for yourself.

If you only have two minutes, the short version is:

- chromatika ships a small, audited smart-contract module that wraps your dWallet signing authority and enforces four rules on every signature: daily spend cap, cooldown between sends, rescue address (a fail-safe destination), and a panic button that freezes the vault on demand.
- The contract is deployed once by the chromatika team and its upgrade authority is **destroyed at publish**. Once live, nobody (not chromatika, not a future malicious maintainer, not a court order) can change the code. It is frozen on chain forever.
- You can leave the policy at any time. There is a configurable delay (you pick it at opt-in) before your dWallet cap is returned to you. The delay is the security feature, not a lock-in: it gives you time to hit panic if someone steals your keys and tries to escape with your funds.

The rest of this page walks through each of those choices and the alternatives we considered.

## what Policy Vault does

When you opt in, your dWallet's signing authority gets wrapped inside a small on-chain object called a `PolicyVault`. After wrapping, your normal signing flow is unchanged from your perspective: open chromatika, click send, the transaction broadcasts. But every signature now routes through the `PolicyVault` contract, which enforces four rules before allowing the signature to complete.

**Daily spend cap.** You set a USD ceiling on how much value can leave the vault in a 24-hour window. Today we enforce this on caller-declared value (soft policy), with chain-specific decoders shipped for EVM (RLP parsing), Bitcoin (BIP143 UTXO sum), and DeSo (binary output parsing) so the cap reads the value out of the transaction bytes directly. Solana and Sui hard-policy decoders ship next.

**Cooldown.** A minimum time between sends. Zero by default, but you can dial it up: 60 seconds, 5 minutes, whatever fits your threat model. The cooldown gives someone (you, a friend, your other device, a relayer that monitors safety alerts) a chance to react to a tx that looks wrong before the next one fires.

**Rescue address.** A pre-registered destination address. While the vault is panicked (see below), normal sends are blocked, but `rescue_sign` lets you drain residual funds to this one specific address. The point is to have a known-safe destination (a hardware wallet, a cold-storage address, a friend's wallet) baked in before things go wrong. If you set the rescue address only AFTER your hot key is compromised, it is too late: setting the rescue address itself is gated on the vault not being panicked.

**Panic button.** Any of your registered actuators can flip the panic flag. While panicked, all normal sends abort. Only `rescue_sign` works. Unfreezing requires the same actuator pool AND a configurable delay (you pick at opt-in, default 7 days). The delay is the protection: an attacker who triggered the panic cannot immediately undo it.

You can have multiple actuators. Your primary chromatika address, a friend's address for social recovery, your phone (set up as a separate signer), a chromatika-team auto-panic address that triggers on safety-alerts signals you opted into. Any one of them can panic; none of them can undo the panic alone within the delay window.

## why on-chain enforcement matters (and not just local-side caps)

Chromatika has another, simpler caps system for x402 payments: `chromatika_x402_caps_v1`, a local browser-storage row that gates a per-counterparty daily USD limit on web-page-side payments. That is fine for low-value, high-frequency micropayment flows where the browser extension is the trust anchor.

Policy Vault is for the case where the browser extension is the *threat*. If chromatika itself is malicious, compromised by a supply-chain attack, exploited by a content-script bug, or just behaving badly because of a bug, the local-storage caps row offers zero protection: the same code that "enforces" the cap is the code you are trying to defend against. Whoever has write access to the cap row can also disable it.

On-chain enforcement flips that. The cap is a struct field on a Sui shared object (or a PDA on Solana). The dWallet's signing authority sits inside that struct. Even if every line of chromatika code on your laptop is malicious, the only way to invoke `coordinator.approve_message` against your dWallet is to call `sign_with_policy` on the contract, which runs the cap check on chain. The malicious extension can lie about declared value, but it cannot bypass the check, and v1's hard-policy decoders read the value out of the message bytes themselves so the lie does not stick.

This is the trust model: chromatika could go to zero and your dWallet would still be cap-protected and panic-able. That property is the entire reason this feature exists.

## the deploy choice: three options we considered

When you ship a smart contract that wraps a user's signing authority, there is a deploy-time question that does not get enough attention: who owns the upgrade authority on the contract? Three real options:

**Option A: each user deploys their own copy of the contract.** You install chromatika, you also install the Sui CLI, fund a deployer keypair with about half a SUI, build the Move package, publish it, paste the resulting package id into Settings. Sounds maximally sovereign. In practice, it filters out everyone who is not a developer, every user pays mainnet rent for code identical to every other user's, and there is no defense against the most common mistake: forgetting to burn the upgrade authority after publish, which leaves it on the deployer keypair. If that keypair is ever compromised, the policy module that was supposed to defend your funds is now upgradable by the attacker.

We have built this path. It is shipped as the current `pnpm run deploy:sui-policy` script. We are retiring it as a user option. It remains available for power users and friend groups who want a private deploy, but chromatika does not surface it in Settings anymore.

**Option B: the chromatika team deploys once, keeps the upgrade authority.** Smooth UX, single audit target, but the team can now upgrade the contract at any moment. That means the contract supposedly defending you from a compromised chromatika is defended by an authority the same team controls. This is a back door dressed as convenience. We do not ship this in production, ever. We do use it during testing (more on that below).

**Option C: the chromatika team deploys once, and destroys the upgrade authority in the same transaction.** This is what we ship. The contract is on chain. The mechanism that would let anybody (including us) modify it is gone. You can verify this for yourself by reading the package's upgrade policy on chain and confirming the `UpgradeCap` object was consumed in the publish transaction. After that point, the bytecode is the bytecode forever.

The cost of Option C is that bugfixes cannot patch the live contract in place. If we find a bug, the only path is to publish a new immutable version (call it v2) and ask users to migrate (more on migration below). That cost is real but it is exactly the cost we want to pay: it forces every change to be deliberate, public, and audited, instead of slipping into your wallet's trust path overnight.

## what "immutable" actually means on chain, and how to verify it

On Sui, every published Move package gets a companion `UpgradeCap` object that controls future upgrades. The `sui::package::make_immutable(cap)` function consumes the `UpgradeCap` and burns it. After that, calling `sui client upgrade` against the package id returns a failure: there is no `UpgradeCap` to authorize the upgrade.

Our production deploy runs `sui client publish` and `make_immutable` in the same programmable transaction block. Two outcomes:

1. The package is published and the cap is consumed atomically. You can read the publish transaction on chain and see both operations.
2. Something fails before the cap is consumed, and the whole transaction reverts. We do not end up in a half-burned state.

On Solana, the equivalent is `solana program set-upgrade-authority <program_id> --final`. The `--final` flag sets the upgrade authority to `None`. After that, `solana program deploy <new.so>` against the same program id fails: there is no authority that can authorize an upgrade.

Verification recipe for the production deploy (full paths land in the audit links section below):

1. Pull the `chromatika_policy` source at the audited commit hash from github.
2. Run `sui move build --path move/chromatika-policy` (or `anchor build` for the Solana side).
3. Compute the bytecode hash of the resulting compiled package.
4. Look up the on-chain package object via Sui Explorer (or `sui client object`) and read the `bytecode` field hash.
5. The two hashes match.
6. Look up the publish transaction. Confirm `make_immutable` was called on the package's `UpgradeCap` in the same tx.

That is the full verification chain. If steps 5 and 6 hold, no upgrade is possible. If step 5 fails, the deployed bytecode does not match the audited source and you should not trust the package.

We ship the audited commit hash, the published package id, the bytecode hash, and the publish-and-burn transaction id in the Settings panel and in the audit links at the bottom of this page.

## you can always exit the policy

This is the part the trust story usually gets wrong, so we want to be specific.

Policy Vault wraps your `DWalletCap`. The wrap is one-way today (chromatika v0). The first immutable production cut (v2 of the Move package) adds a two-step exit:

1. **Request unwrap.** Any of your actuators calls `request_unwrap`. The vault records the request and starts a countdown equal to the `stage_delay_ms` you configured at opt-in (defaults to 24 hours, you can pick anywhere from instant to 30 days).
2. **Claim unwrap.** After the countdown, any of your actuators calls `claim_unwrap`. The vault's `DWalletCap` is returned to the caller, and the `PolicyVault` shared object is consumed. Your dWallet is now policy-free.

You can cancel the request at any time during the countdown. While the request is pending, normal `sign_with_policy` calls keep working: requesting an exit does not freeze you out of using your funds.

**Why the delay exists.** If exit were instant, a thief who got your active key could escape with the `DWalletCap` before you noticed. The delay gives you (and your other actuators) a window to hit panic. Once panicked, `claim_unwrap` aborts: an actuator who triggered exit-then-panic cannot collect the cap. The legitimate user who configured a 7-day delay gets a 7-day window to realize their hot key is compromised and panic, freezing the attacker out.

This is not theoretical. The exit primitive is exactly the kind of escape hatch a sophisticated attacker would target first. The delay is a hard requirement, not a UX inconvenience.

## bugfix and version migration (and why migration also has a delay)

Because the package is immutable, fixing a bug means publishing a new immutable package (call it v2) with the fix. v1 vaults keep working forever: the v1 contract is still on chain, still enforcing the same rules, still consuming the same `DWalletCap`. Nothing forces you to migrate. You can stay on v1 forever if you want.

When you decide to migrate, the path is: `claim_unwrap` on v1, then `wrap_dwallet_cap` on v2, in a single transaction. That means migration is subject to the same delay as plain exit.

We could have built an "instant migration" path with no delay. We chose not to. Here is the attack we were closing:

1. Attacker steals your active key (one of your actuators on the v1 vault).
2. Normal `request_unwrap` works but has a 7-day delay. You will panic during the wait.
3. If `migrate_to_v2` had no delay, the attacker calls it instead. The cap lands in a fresh v2 vault.
4. The fresh v2 vault has a brand new actuator list, seeded only with whoever called migration. **You are no longer an actuator on v2 and can no longer panic it.**
5. The attacker calls v2's `request_unwrap` and waits its delay alone, with no panic risk.
6. The attacker walks away with your dWallet cap.

The delay on unwrap was supposed to give you time to react. A no-delay migration path makes that delay irrelevant: an attacker just routes around it. To prevent the bypass we would need to either carry the v1 actuator list into v2 faithfully (auditable but adds code) or verify that the v2 package is a trusted successor (impossible to encode in v1's bytecode because v2 does not exist when v1 is published, unless we add a separate migration-registry contract).

Both alternatives are real and would work. We picked the simpler one: migration shares the unwrap delay, no extra code to audit, the existing security gates do the work. Your migration takes as long as your configured exit delay, which is the same wait you already accepted.

## pre-alpha Solana caveats

The same design ships on Solana as a parallel Anchor program at `chromatika-policy`. Today Solana ika is **pre-alpha**: signatures run through a single mock signer, not a real distributed MPC. The on-chain ika program will be wiped when ika transitions to Alpha-1. Chromatika never presents Solana pre-alpha ika as production custody.

Concretely for Policy Vault on Solana:

- The `PolicyVault` PDA shape mirrors the Sui struct (caps, cooldown, panic, rescue, actuators, staging).
- All instructions are implemented and tested.
- The CPI body that actually transfers dWallet authority into the PDA is a stub today, awaiting ika Solana Alpha-1 publishing a stable CPI surface for "set dWallet authority under caller-PDA-as-authority". Until then, `wrap_authority` writes the policy state but does not move the on-chain dWallet authority.
- The unwrap path lands in lockstep: once Alpha-1 ships, both `wrap_authority` and `claim_unwrap` get real CPI bodies.

If you are exploring Policy Vault on Solana today, treat it as a UI/storage preview, not real custody. The Sui side is the production target.

## what we would ask you to verify

If you treat this writeup as a marketing claim and not a verifiable trust artifact, we have not done our job. Here is the checklist:

- **Audited source matches the live bytecode.** Pull the `chromatika_policy` source at the commit hash linked below. Build. Hash the compiled package. Compare to the on-chain package's bytecode hash. They match.
- **Upgrade authority is destroyed.** On Sui, the `UpgradeCap` for the package was consumed in the publish transaction. On Solana, the program's upgrade authority is `None`. Both verifiable on a block explorer.
- **The `DWalletCap` cannot be extracted except through the staged two-step unwrap.** Read the `sign_gate.move` source. Search for any function that returns `DWalletCap` by value. Only `claim_unwrap` exists, and it is gated on actuator membership, not-panicked, and the staged delay.
- **Cap, cooldown, panic, and rescue are enforced on chain.** Read `sign_with_policy` and `rescue_sign`. The asserts run before the `coordinator.approve_message` call.
- **The audit report.** Linked below. Read it. The auditor is named, the methodology is named, the report is dated.

If any of those fail, the trust claim fails. Tell us.

## source and audit links

Pending the production deploy. When we cut the first immutable production package, this section gets the audited commit hash, the audit firm name and report link, the published package id on Sui mainnet (and on Solana mainnet when ika Solana ships), the bytecode hash, the publish-and-burn transaction id, and the explorer links for all of the above. Until then, the source lives at [`wallet-extension/move/chromatika-policy/sources/sign_gate.move`](https://github.com/dwallet-labs/chromatika/blob/main/wallet-extension/move/chromatika-policy/sources/sign_gate.move) (and the Solana parallel at [`wallet-extension/solana/chromatika-policy/programs/chromatika-policy/src/lib.rs`](https://github.com/dwallet-labs/chromatika/blob/main/wallet-extension/solana/chromatika-policy/programs/chromatika-policy/src/lib.rs)) and the deploy script is at [`wallet-extension/scripts/deploy-sui-policy.mjs`](https://github.com/dwallet-labs/chromatika/blob/main/wallet-extension/scripts/deploy-sui-policy.mjs).
