# PC-Token phase-0 spike (working notes)

> ngmi-grade pre-alpha working doc. delete once `PC_TOKEN.md` ships in phase 7. all confirmations pulled from `dwallet-labs/encrypt-pre-alpha` `main` (chains/solana/examples/pc-token) on 2026-04-29 - upstream may drift fast, so re-anchor to the repo, not this file, when wiring builders.

## 1. findings summary (TL;DR)

- **the plan is buildable, but the protocol shape diverges from the plan in 3 important ways. don't treat the plan as gospel; treat *this* doc as the truer working reference until phase 1 builders land.**
- **ciphertext accounts are NOT PDAs**. they are **fresh `Keypair.generate()` accounts that the signer transaction creates and signs into existence**. only the **TokenAccount** (the wrapper around the encrypted balance ciphertext) is a PDA per `(mint, owner)`. so "send the same Alice/Bob ciphertext account every transfer" is **wrong** - every wrap/transfer ix creates a new amount-ct keypair on the fly. correlatable-on-chain story is more nuanced (see section 4).
- **PDA seed order is `(mint, owner)`, NOT `(owner, mint)`**. seed string is `pc_account`. the plan got the order backwards.
- **wrap reveals plaintext amount in instruction data**. the wrap ix carries an 8-byte LE u64 plaintext amount alongside the encrypted amount-ct. this matches expectations (the SPL transfer leg has to be plaintext anyway), but worth noting for the disclaimer modal copy.
- **unwrap is genuinely 3 separate transactions**, *not* 3 instructions in one tx. the executor must commit a decryption response between `UnwrapDecrypt` and `UnwrapComplete`, which is async. budget UX for a 2-step progress indicator with executor wait between burn/decrypt and decrypt/complete.
- **PC-Token program ID is NOT the same as the Encrypt program ID.** chromatika's `ENCRYPT_SOLANA_PROGRAM_ID = 4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8` is the Encrypt program. PC-Token is a *separate* program, deployed alongside Encrypt, taking the Encrypt program ID as a CPI target. **the upstream e2e takes both program IDs as CLI args** (`bun main.ts <ENCRYPT_ID> <PC_TOKEN_ID>`) and the PC-Token devnet program ID is not in the docs - we'll need to either (a) get a deployed devnet program ID from the Encrypt team, or (b) deploy the pinocchio variant ourselves to a known address. **this is a hard blocker for phase 1.**
- **gRPC reuse is total**. our existing `encrypt-protobuf-wire.ts` `CreateInput` shape is byte-for-byte sufficient. `chain = 0` (Solana), `authorized = PC_TOKEN_PROGRAM_ID.toBytes()` (note: PC-Token program, not Encrypt program), `fheType = 4` (EUint64 for amounts), `networkEncryptionPublicKey = 32 bytes hex 0x55*32` mock key. zero new proto work needed.

## 2. program ID + endpoints

| field | value | source |
| --- | --- | --- |
| Encrypt program ID | `4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8` | `wallet-extension/src/background/encrypt/encrypt-constants.ts:3` |
| Encrypt gRPC | `https://pre-alpha-dev-1.encrypt.ika-network.net:443` | `encrypt-constants.ts:4` |
| Solana RPC | `https://api.devnet.solana.com` | `encrypt-constants.ts:5` |
| **PC-Token program ID (devnet)** | **UNKNOWN - blocker** | upstream e2e takes it as CLI arg, no canonical address in docs |
| Network encryption key (mock) | `Buffer.alloc(32, 0x55)` | `chains/solana/examples/pc-token/e2e/main.ts` line creating `nk` |

**action required before phase 1**: file an issue on `dwallet-labs/encrypt-pre-alpha` or ping in their dev chat asking for the canonical devnet PC-Token program ID. fallback: deploy the pinocchio variant ourselves to a chromatika-controlled program address (use `solana program deploy`).

## 3. per-instruction wire format

source of truth: [`chains/solana/examples/pc-token/e2e/instructions.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/pc-token/e2e/instructions.ts) and the pinocchio program at `chains/solana/examples/pc-token/pinocchio/src/lib.rs`. helpers (`encryptCpiAccounts`, `pda`) at [`chains/solana/examples/_shared/encrypt-setup.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/_shared/encrypt-setup.ts) and [`_shared/helpers.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/_shared/helpers.ts).

### 3.0 the `encryptCpiAccounts(...)` 9-account block

every PC-Token ix that runs an FHE op (`InitializeAccount`, `Transfer`, `Wrap`, `UnwrapBurn`, `UnwrapDecrypt`) appends this fixed 9-account suffix. order matters - the program reads them positionally.

| idx | account | signer | writable | source |
| ---: | --- | --- | --- | --- |
| 0 | `encryptProgram` | n | n | constant `4ebfz...` |
| 1 | `configPda` | n | y | PDA `["encrypt_config"]` on Encrypt program |
| 2 | `depositPda` | n | y | PDA `["encrypt_deposit", payer]` on Encrypt program |
| 3 | `cpiAuthority` | n | n | PDA `["__encrypt_cpi_authority"]` on **PC-Token** program (the caller program) |
| 4 | `callerProgram` | n | n | the PC-Token program ID itself |
| 5 | `networkKeyPda` | n | n | PDA `["network_encryption_key", networkKey32]` on Encrypt program |
| 6 | `payer` | y | y | the user (or vault PDA when CPI'd) |
| 7 | `eventAuthority` | n | n | PDA `["__event_authority"]` on Encrypt program |
| 8 | `SystemProgram` | n | n | constant `11111...` |

note: `UnwrapDecrypt` flips `configPda` to `isWritable: false` (per upstream `instructions.ts` line `configPda` filter in `unwrapDecryptIx`).

### 3.1 InitializeMint (disc `0`)

creates the pcToken Mint PDA. one-time per (chromatika install, mint authority); the user does **not** call this for an existing pcUSDC market.

- accounts (4): `[mintPda(w), mintAuthority(s), payer(s, w), systemProgram]`
- ix data (35 bytes, no freeze authority): `[disc=0, mintBump, decimals, mintAuthority(32)]`
- ix data (67 bytes, with freeze authority): same + `[1, freezeAuthority(32)]`
- gRPC: none
- PDA: `["pc_mint", mintAuthority]`

**chromatika won't usually call this** - we'd reuse a community-deployed pcUSDC mint. if no canonical pcUSDC mint exists on devnet yet, we deploy one ourselves at chromatika onboarding (single-shot setup script).

### 3.2 InitializeAccount (disc `1`)

creates the per-user TokenAccount PDA + the initial encrypted-zero balance ciphertext keypair. **this is the user's "open a pcUSDC account" gesture.**

- accounts: `[accountPda(w), mint, owner, balanceCt(s, w)] + encryptCpiAccounts`
- ix data (3 bytes): `[disc=1, accountBump, cpiBump]`
- gRPC: none (no plaintext input - the program runs an internal FHE graph that initializes balance to encrypted zero)
- PDA: `["pc_account", mint, owner]` (note **mint first, owner second**)
- **`balanceCt` is a fresh `Keypair.generate()`** the caller creates and signs the tx with. the program writes the encrypted-zero ciphertext into this fresh account, and the TokenAccount PDA stores `balanceCt.publicKey` as a pointer.

implications for chromatika:
- on first open of `PrivateBalancesPage`, if the user's pcUSDC TokenAccount PDA doesn't exist yet, prompt to initialize. one-shot per (vault, mint) pair.
- the balance ciphertext account *changes* on every `Transfer` / `Wrap` because the program creates a *new* output ciphertext each time the encrypted balance updates. so reading balance means reading the **TokenAccount PDA** to find the *current* balanceCt pubkey, then `ReadCiphertext` on that pubkey. the TokenAccount PDA's `balance.ciphertext` field is the moving target; the PDA itself is stable.

### 3.3 Transfer (disc `3`) - **the hidden-send moment**

- accounts: `[fromAccountPda, toAccountPda, fromBalanceCt(w), toBalanceCt(w), amountCt(w), owner(s)] + encryptCpiAccounts`
- ix data (2 bytes): `[disc=3, cpiBump]`
- gRPC pre-call: `CreateInput { chain: 0, inputs: [{ ciphertextBytes: mockEncryptScalarBytes(amount, 4), fheType: 4 }], proof: [], authorized: PC_TOKEN_PROGRAM_ID.toBytes(), networkEncryptionPublicKey: nk }`
- recipient resolution: caller passes recipient's `Solana address`. caller derives `toAccountPda = pda(["pc_account", mint, recipientAddress])` and `toBalanceCt` is read from that PDA's `balance.ciphertext` field on-chain.
- **gotcha**: if Bob has never called `InitializeAccount` for this mint, `toAccountPda` does **not exist**. Transfer will fail. chromatika must fail-fast with an actionable error ("recipient hasn't opened a pcUSDC account yet - send them this URL to onboard").

### 3.4 Wrap (disc `30`) - SPL → pcSPL

- accounts: `[vaultPda, tokenAccountPda, userAta(w), vaultAta(w), balanceCt(w), amountCt(w), owner(s)] + encryptCpiAccounts + [splTokenProgram]`
- ix data (10 bytes): `[disc=30, cpiBump, amount(u64 LE 8 bytes)]`
- gRPC pre-call: same shape as Transfer - one EUint64 amountCt
- **wrap reveals plaintext amount**. the 8-byte LE u64 in ix data IS the plaintext deposit amount. the SPL leg is a normal `spl_token::Transfer` from `userAta` to `vaultAta` for that exact amount. **the privacy guarantee is "post-wrap balance is hidden", not "wrap amount is hidden"** - confirm in the disclaimer modal copy.

### 3.5 UnwrapBurn (disc `31`)

step 1 of 3 in the unwrap flow. burns the encrypted amount from the user's balance and creates a `WithdrawalReceipt` PDA tracking what's owed.

- accounts: `[vaultPda, tokenAccountPda(w), receiptPda(w), balanceCt(w), amountCt(w), burnedCt(w), owner(s)] + encryptCpiAccounts`
- ix data (11 bytes): `[disc=31, receiptBump, cpiBump, amount(u64 LE 8 bytes)]`
- gRPC pre-call: **TWO** `CreateInput` round-trips required - one for `amountCt` (the requested withdrawal amount), one for `burnedCt` (initially-zero ciphertext that the FHE graph will write the actually-burned amount into - silently 0 if balance < amount, equal to amount on success).
- PDA: `["pc_receipt", burnedCt.publicKey]` (per-burn receipt - **not** a fixed user receipt account)

**important pre-alpha bug call-out**: the gotcha at `skills/encrypt-solana-prealpha/references/gotchas.md` line ~116 mentions a historic bug where `UnwrapBurn` mismatched the burned amount vs the requested amount when ciphertexts were 16 bytes. chromatika's `mockEncryptScalarBytes` already emits the correct 17-byte format, so this is a non-issue for us as long as we use that helper.

### 3.6 UnwrapDecrypt (disc `32`)

step 2 of 3. requests on-chain decryption of `burnedCt` so step 3 can release exactly that many SPL tokens.

- accounts: `[receiptPda(w), requestAcct(s, w), burnedCt, owner(s)] + encryptCpiAccounts (with configPda forced isWritable=false)`
- ix data (2 bytes): `[disc=32, cpiBump]`
- gRPC: none
- `requestAcct` is **another fresh `Keypair.generate()`** that becomes a `DecryptionRequest` keypair-account (Encrypt account disc 3). the caller signs the tx with this keypair so the program can `init` it.

after this tx confirms, the chromatika UI must **wait for the executor to commit a decryption response**. the `requestAcct` data layout (per `reference-accounts.md`):
```
offset 99: total_len (u32 LE) - expected plaintext byte count
offset 103: bytes_written (u32 LE) - decryptor progress
offset 107: actual plaintext bytes
```
poll: `bytes_written === total_len && total_len > 0`. canonical helper: `pollUntil(conn, requestAcct.publicKey, isDecrypted, 120_000)` from `chains/solana/examples/_shared/helpers.ts`.

executor latency on devnet is **~3-5s for small graphs, can be ~60s** per `gotchas.md` "Two-phase execution" - so chromatika UI shows a "decrypting receipt..." spinner. **do not** try to pack `UnwrapDecrypt` and `UnwrapComplete` into one tx.

### 3.7 UnwrapComplete (disc `33`)

step 3 of 3. verifies the decryption result and releases SPL tokens.

- accounts: `[receiptPda(w), vaultPda, pcMint, requestAcct, vaultAta(w), userAta(w), owner(s), destination(w), splTokenProgram]`
- ix data (1 byte): `[disc=33]`
- gRPC: none
- `destination` = the SOL rent-reclaim destination when the receipt closes. usually `payer.publicKey`.

### 3.8 InitializeVault (disc `23`) - one-time per (pcMint, splMint) pair

- accounts (5): `[vaultPda(w), pcMint, splMint, payer(s, w), systemProgram]`
- ix data (2 bytes): `[disc=23, vaultBump]`
- gRPC: none
- PDA: `["pc_vault", pcMint]`

after `InitializeVault`, the caller must also create a **vault SPL ATA** (`createSplTokenAccount(conn, payer, splMint, vaultPda)` - vault PDA is the ATA owner). this is the escrow that holds wrapped SPL.

### 3.9 instructions chromatika does NOT need for v0

skipped per the explicit non-goals in the plan. handlers exist upstream but no chromatika integration required:

- `MintTo` (disc `7`) - bypassed in pc-token use case (wrap is the only inflow)
- `Approve` (disc `4`) / `Revoke` (disc `5`) - allowance pattern; not needed for direct sends
- `FreezeAccount` (disc `10`) / `ThawAccount` (disc `11`) - admin-only
- `TransferFrom` (disc `20`) - delegated transfer, allowance-based; not for v0
- `TransferWithReceipt` (disc `22`) - the receipt-gated composability for PC-Swap. **not for v0** but worth knowing exists - the receipt pattern is the upstream-blessed way to compose PC-Token with other programs (see `flows.md` flow 7).

## 4. account derivation + initialization

| account | type | seeds | created by | who creates |
| --- | --- | --- | --- | --- |
| pcMint | PDA | `["pc_mint", mintAuthority]` | `InitializeMint` | mint admin (one-shot per pcToken market) |
| Vault | PDA | `["pc_vault", pcMint]` | `InitializeVault` | mint admin or first wrapper |
| Vault SPL ATA | SPL account | n/a (ATA) | `createSplTokenAccount` w/ vaultPda owner | mint admin |
| TokenAccount | PDA | `["pc_account", mint, owner]` | `InitializeAccount` | end user (per-vault, per-mint, one-shot) |
| balanceCt | **Keypair** | n/a | `InitializeAccount` then implicitly replaced on every Transfer/Wrap/Unwrap | end user (signs init), program (replaces) |
| amountCt | **Keypair (gRPC-derived)** | n/a (the ciphertext_identifier returned from `CreateInput` IS the account pubkey) | `CreateInput` gRPC | end user |
| burnedCt | same as amountCt | n/a | `CreateInput` gRPC (with plaintext value `0`) | end user, only for Unwrap |
| WithdrawalReceipt | PDA | `["pc_receipt", burnedCt]` | `UnwrapBurn` | end user |
| DecryptionRequest | **Keypair** | n/a | `UnwrapDecrypt` | end user (signs init) |

**the `balanceCt` keypair situation** (this is the most subtle bit):

1. `InitializeAccount` takes `balanceCt = Keypair.generate()` as a signer and writes encrypted-zero into it. the **TokenAccount PDA** stores `balanceCt.publicKey` in its `balance` field.
2. On the *next* `Transfer` / `Wrap` / `Unwrap`, the program runs an FHE graph that **outputs a fresh balance ciphertext** to a *new* keypair-account (or possibly reuses - the e2e passes the same `aliceBal.publicKey` to multiple ops, so it's likely **mutated in place**). need to confirm by reading the pinocchio source `lib.rs` more carefully or via field test.
3. **chromatika's read flow**: to get a user's pcUSDC balance, (a) compute TokenAccount PDA, (b) read it on-chain, (c) extract `balance.ciphertext_pubkey` field, (d) `ReadCiphertext` on that pubkey via gRPC.

## 5. gRPC reuse vs new methods

**chromatika's existing wire layer covers PC-Token completely.** no new proto work needed.

| gRPC method | chromatika file | PC-Token use |
| --- | --- | --- |
| `CreateInput` | `wallet-extension/src/background/encrypt/encrypt-grpc-web-fetch.ts:51` | encrypt the wrap/transfer/unwrap amount ciphertexts and the burnedCt(0) seed |
| `ReadCiphertext` | `encrypt-grpc-web-fetch.ts:58` | read the user's current balance ciphertext for `PrivateBalancesPage` |
| `mockEncryptScalarBytes` | `wallet-extension/src/background/encrypt/encrypt-lab-service.ts:46` | 17-byte format helper, **directly reusable**, drop-in for amount encoding |
| `decodeCreateInputResponse` | `encrypt-protobuf-wire.ts:42` | extracts ciphertext_identifiers (pubkeys) from CreateInput response |
| `encodeReadCiphertextMessage` | `encrypt-read-msg.ts:6` | BCS-serialized signed read message for ReadCiphertext |
| `signMessageSol` (ika ed25519) | `wallet-extension/src/background/chains/signing/ed25519.ts` | signs the ReadCiphertext message under the active dWallet ed25519 |

**values to pass for PC-Token CreateInput**:
- `chain: 0` (Solana - same as label encryption today)
- `fheType: 4` (EUint64 - amounts are u64)
- `authorized: PC_TOKEN_PROGRAM_ID.toBytes()` - **the PC-Token program, not the Encrypt program**. label encryption today uses `ENCRYPT_SOLANA_PROGRAM_ID.toBytes()` (`encrypt-lab-service.ts:185`); PC-Token must instead authorize the PC-Token program.
- `networkEncryptionPublicKey: nk` - the same 32-byte hex key resolved by `resolveNetworkEncryptionPublicKey()` at `encrypt-lab-service.ts:135`. the upstream e2e uses the mock `Buffer.alloc(32, 0x55)`; chromatika resolves the live on-chain network key. both should match in pre-alpha.

## 6. TS reference impl pointers

**primary reference** (verbatim copy this when wiring builders):
- ix builders: [`chains/solana/examples/pc-token/e2e/instructions.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/pc-token/e2e/instructions.ts) - 9.3 KB, ~290 lines, has `derivePcTokenPdas`, `deriveMintPda`, `deriveAccountPda`, `deriveVaultPda`, `deriveReceiptPda`, plus `initializeMintIx` / `initializeAccountIx` / `transferIx` / `wrapIx` / `unwrapBurnIx` / `unwrapDecryptIx` / `unwrapCompleteIx`
- e2e flow: [`chains/solana/examples/pc-token/e2e/main.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/pc-token/e2e/main.ts) - 10.4 KB, ~140 lines, full Alice/Bob/Mark wrap-transfer-unwrap flow
- spl helpers: [`chains/solana/examples/pc-token/e2e/spl-helpers.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/pc-token/e2e/spl-helpers.ts) - chromatika won't reuse this directly because we already have an SPL stack; pcUSDC will use the existing devnet SPL USDC mint.
- shared CPI suffix: [`chains/solana/examples/_shared/encrypt-setup.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/_shared/encrypt-setup.ts) - `encryptCpiAccounts(...)` returns the 9-account suffix verbatim
- shared helpers: [`chains/solana/examples/_shared/helpers.ts`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/_shared/helpers.ts) - `pda`, `mockCiphertext`, `pollUntil`, `isVerified` (`d[99] === 1`), `isDecrypted` (`bytes_written === total_len > 0` at offset 99/103)
- on-chain program: [`chains/solana/examples/pc-token/pinocchio/src/lib.rs`](https://github.com/dwallet-labs/encrypt-pre-alpha/blob/main/chains/solana/examples/pc-token/pinocchio/src/lib.rs) - 37.5 KB, source of truth for state layouts and discriminators

**proto generation step**: not needed. chromatika's `encrypt-protobuf-wire.ts` already hand-codes the wire layer for `CreateInput` and `ReadCiphertext`. PC-Token uses the *same* `encrypt.v1.EncryptService` proto.

**test vectors**: none published. closest thing is the e2e itself, which can be re-run via `bun chains/solana/examples/pc-token/e2e/main.ts <ENCRYPT_ID> <PC_TOKEN_ID>` once we have a PC-Token program ID.

## 7. devnet artifacts for demo prep

| artifact | value | source / blocker |
| --- | --- | --- |
| Encrypt program ID | `4ebfzWdKnrnGseuQpezXdG8yCdHqwQ1SSBHD3bWArND8` | confirmed |
| Encrypt gRPC | `https://pre-alpha-dev-1.encrypt.ika-network.net:443` | confirmed |
| Solana RPC | `https://api.devnet.solana.com` | confirmed |
| **Devnet USDC mint** | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's devnet USDC; faucet at https://faucet.circle.com/ (USDC dropdown, Solana network). **note**: the upstream e2e doesn't use Circle's USDC - it `createSplMint`s a fresh dev mint and self-mints to Alice. for chromatika demo we should match Circle's mint so the SPL leg is recognizable in solana explorer ("USDC, Circle") rather than an anonymous dev SPL. |
| **PC-Token program ID** | **UNKNOWN** | hard blocker - see section 2 |
| PC-USDC mint PDA | depends on mint authority chosen | once PC-Token program ID is known, derive `["pc_mint", chosenMintAuth]` and document |
| Vault PDA | depends on chosen pcUSDC mint | derive `["pc_vault", pcUsdcMint]` |
| Pre-initialized test accounts | none yet | per the plan, phase 0 deliverable - "pre-deploy a test pcUSDC token account on devnet so the transfer demo has a known good source". needs PC-Token program ID first. |

## 8. open questions / blockers

1. **HARD BLOCKER: PC-Token program ID on devnet**. without this, builders can't ship. options:
   - ask in dwallet-labs dev chat or open an issue on the encrypt-pre-alpha repo
   - deploy the pinocchio variant to a chromatika-controlled program address (~30min, requires `cargo build-sbf` + `solana program deploy` + ~3-5 SOL devnet rent)
   - if the team has a private devnet deployment, get the address shared via DM
2. **balance ciphertext mutation semantics**. the e2e passes the same `aliceBal.publicKey` to multiple Transfer ops. confirm: does the program **mutate the existing ciphertext account's digest** in place (typical Encrypt account behavior - the digest field at offset 2 is rewritten by `commit_ciphertext`), or does it allocate a fresh balance-ct each op? if mutated in place, our balance-read flow stays simple (read TokenAccount PDA → balanceCt pubkey → ReadCiphertext, all stable). if reallocated, we may need to track a balance-ct registry.  **provisional answer based on the e2e: mutated in place** (the e2e never calls `Keypair.generate()` for a new balance-ct after `InitializeAccount`). field test in phase 1.
3. **executor commit latency in production demo**. plan budget: ~3-5s typical, up to 60s worst case. if devnet is slow during the live demo, the unwrap flow's "decrypting..." spinner will stall. mitigation: do all the wrap/transfer/unwrap pre-flight before the live demo, only do the *transfer* step live (single tx, no executor wait between user click and visible state change other than ciphertext commit).
4. **MintTo (disc 7) vs Wrap (disc 30) for first balance**. the e2e uses Wrap for everything, and that's what the plan assumes. confirmed: **MintTo is bypassed; pcUSDC supply only enters via Wrap**. no chromatika code changes needed.
5. **TransferWithReceipt vs Transfer (disc 22 vs 3)**. plain `Transfer` (disc 3) silently no-ops on insufficient balance per upstream `flows.md` flow 7. TransferWithReceipt (disc 22) emits a binary receipt. **for v0 chromatika sticks with disc 3** since we don't compose with PC-Swap, but worth noting: a user with insufficient balance currently sees a successful tx that did nothing. **chromatika should pre-check the user's decrypted balance before submitting Transfer** to avoid silent failures - read pcUSDC balance, refuse send if `requestedAmount > decryptedBalance`. otherwise UX is "tx succeeded, why didn't Bob receive anything?".
6. **devnet wipes**. encrypt.xyz devnet may rotate; all ciphertext accounts and TokenAccount PDAs would clear. document the recovery (re-init account, re-wrap) in `PC_TOKEN.md`. same gotcha as encrypted activity notes.
7. **vault SPL ATA ownership**. the e2e creates `vaultAta` via `createSplTokenAccount(conn, payer, usdcMint, vaultPda)` - the ATA *owner* is the vault PDA itself. confirm this works with the standard `getAssociatedTokenAddress` derivation chromatika uses today, or whether we need a custom token account creation path.

## 9. plan deltas

the plan at `C:\Users\cletu\.claude\plans\review-this-plan-and-delightful-journal.md` is ~85% accurate but has 3 concrete corrections + 2 additions:

### corrections

1. **plan section "what was confirmed via research" → "ciphertext accounts: deterministic per (owner, token)"**: this is **wrong**. only the **TokenAccount PDA** is deterministic; the **balance ciphertext** is a Keypair (likely mutated in place). honestly the on-chain identifier that's deterministic and correlatable across sends is the **TokenAccount PDA**, not the ciphertext. update the disclaimer copy from "pcToken accounts are deterministic per (owner, token)" to "pcToken **accounts** are deterministic per (mint, owner) - same Alice + same pcUSDC = same on-chain TokenAccount PDA every time, even though the ciphertext inside it changes".
2. **plan phase 1 wrap flow → "derive deterministic pcToken ciphertext account (per upstream account layout: PDA over [owner, mint])"**: PDA seed order is `(mint, owner)`, not `(owner, mint)`. fix in `pc-token-program.ts` constants and the comments throughout the new `encrypt-pc/` module.
3. **plan phase 4 unwrap flow → "pack all 3 ix into one solana versioned tx so the plaintext-receipt window is intra-tx only"**: not possible. `UnwrapDecrypt` requires the executor to commit a decryption response between it and `UnwrapComplete`, async. update the unwrap UX to a 3-step progress: (a) burn+receipt creation tx, (b) "waiting for executor decryption" spinner with poll, (c) complete+release tx. plaintext-receipt window is **inter-tx**, lasts ~3-60s.

### additions

4. **plan phase 0 "spike" deliverable section → no PC-Token program ID listed**: add as the first phase-1 blocker. either get it from upstream or self-deploy. budget: half a day if self-deploying.
5. **plan phase 2 transfer flow → does not mention recipient must have called InitializeAccount first**: add a precheck. if `toAccountPda` doesn't exist, fail the send with a "recipient hasn't onboarded pcUSDC yet" error and a deeplink the sender can copy and share. relevant for the "send hidden" UX flow on `SendPage.tsx` (phase 5) and the test plan (phase 6 acceptance criterion).

### what the plan got right

- gRPC reuse is total (section 5 here confirms)
- 17-byte format helper is reusable (`mockEncryptScalarBytes` works as-is)
- per-mint cache TTL of 60s for balance reads is sensible given executor decrypt cost
- 3 honesty disclaimers in the modal are the right shape; correlation disclaimer needs minor wording tweak per correction #1
- hardcoded USDC-only for v0 is fine
- `PrivateBalancesPage` + `SendPage` "send hidden" toggle are the right surfaces
- `kind: 'pc-wrap' | 'pc-transfer-hidden' | 'pc-unwrap'` SignedTxKind extension lines up with the `tx-record.ts:32` enum (currently has 10 entries; add 3 more)

### bottom line

ship the plan **with the 5 deltas above applied** and unblock the PC-Token program ID. everything else (the `encrypt-pc/` module structure, tRPC procedures, UI surfaces, disclaimer copy, test plan) is sound.
