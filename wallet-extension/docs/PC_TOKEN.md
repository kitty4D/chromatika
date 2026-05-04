# PC-Token (chromatika)

> status: 2026-04-30 — fully built, **gated on adding at least one PC-Token market**. The user-facing wrap / hidden transfer / unwrap flows live on the **Portfolio** and **Send** pages (Solana rail). Settings → **PC-Token markets** is the admin surface where deployed programs are registered. See "Configuring a market" below.
>
> A "market" is the tuple `(splMint, programId, mintAuthority?, network)`. Multiple markets are supported — e.g. `pcUSDC` and `pcUSDC-friends-group` for participating in two different deployments from the same vault.

## TL;DR

PC-Token is encrypt.xyz's FHE-encrypted SPL wrapper. chromatika now ships:
- **wrap** (SPL → pcSPL, 1:1, plaintext SPL leg visible, post-wrap balance hidden)
- **hidden transfer** (encrypted amount + encrypted recipient pcToken account)
- **unwrap** (3-step burn → executor decrypt → release)
- **encrypted balance read** (1× ika MPC sign + gRPC `ReadCiphertext` per refresh, cached 60s)
- **send-hidden form** with a 3-checkbox honesty disclaimer (sender visible / correlatable accounts / pre-alpha mock executor)
- **MCP `listActiveAlerts`-style integration** — pc-* tx records flow through the existing activity feed with a lock-icon badge; agents can read the surface state via standard chromatika MCP tools.

The privacy guarantees are real but narrow. **Read the limitations section** before pitching this to users.

## Privacy model — what's hidden, what's not

| concern | hidden? | note |
|---|---|---|
| Transfer amounts | yes | FHE-encrypted in the on-chain ciphertext account |
| Recipient pcToken account | yes | not the recipient's plaintext SPL ATA |
| Sender wallet | **NO** | the tx signer (your solana address) is visible to anyone |
| Per-user pcToken account address | NO (deterministic per `(mint, owner)`) | the same Alice + same pcUSDC = same on-chain TokenAccount PDA every time. Repeat sends correlate. |
| Wrap deposit amount | NO | the SPL leg of the wrap ix carries an 8-byte plaintext u64 |
| Unwrap amount (intra-tx window) | partially | a short-lived "receipt" account holds the plaintext during step 2; closed after step 3 |

The honesty disclaimer modal in [`HiddenSendDisclaimerModal.tsx`](../src/ui/components/HiddenSendDisclaimerModal.tsx) surfaces these three bullets verbatim before the first send.

## Trust model (pre-alpha)

- **Single mock executor** runs the FHE graph. Ciphertexts may be plaintext on devnet for testing.
- **No threshold decryption** in pre-alpha. Mainnet alpha is the cutover point for real cryptographic privacy.
- **Devnet wipes** rotate ciphertext accounts; chromatika translates "ciphertext not found" into a `devnet-wipe` structured error so the UI can render an actionable "re-wrap to recover" message.

**Never present pc-token sends as production-grade privacy.** Every UI surface that touches PC-Token MUST show the "encrypt.xyz pre-alpha · sender visible · dev preview" pill.

## Configuring a market

**Self-deploy is the only path** — confirmed via exhaustive repo + docs site search (no committed program ID, no CI deploy, no published releases, no `addresses.json` / `Anchor.toml`). Both upstream `pc-token/e2e/main.ts` and `pc-swap/e2e/main.ts` take the PC-Token program ID as a CLI arg with no default fallback. Users self-deploy and pass the result.

chromatika stores deployed programs as **markets** in a per-install registry at `chrome.storage.local` key `chromatika_pc_token_markets_v1`. **You don't need to edit source files or rebuild the extension** — add a market in Settings → PC-Token markets and the wrap / hidden transfer / unwrap UI on the Portfolio + Send pages goes live immediately.

### One-time deploy (~5 minutes) — recommended path

chromatika ships a one-shot setup script that wraps clone + build + deploy + capture:

```bash
cd wallet-extension
pnpm setup:pc-token
# → preflight checks (cargo, cargo build-sbf, solana, git, devnet config, deployer balance)
# → clone or pull dwallet-labs/encrypt-pre-alpha into .pc-token-deploy/
# → cargo build-sbf the pinocchio variant
# → solana program deploy
# → prints + saves the resulting Program Id
```

Requires Solana platform tools (`cargo build-sbf`, ships with the solana CLI installer), the `solana` CLI, git, and a funded devnet keypair (~3-5 SOL).

The script is **safe to re-run** — clone step skips if the repo's already there, cargo caches its build artifacts, and `solana program deploy` of an unchanged binary just re-prints the existing program ID without burning more rent.

### Manual deploy (if you'd rather not use the script)

```bash
# clone + build the pinocchio variant
git clone https://github.com/dwallet-labs/encrypt-pre-alpha
cd encrypt-pre-alpha
cargo build-sbf --manifest-path chains/solana/examples/pc-token/pinocchio/Cargo.toml

# fund a deployer keypair on devnet
solana config set --url devnet
solana airdrop 5

# deploy
solana program deploy target/deploy/pc_token.so
# → prints "Program Id: <base58>"; copy that value
```

### Add a market in Settings

1. Open the chromatika side panel → Settings.
2. Scroll to "PC-Token markets (encrypt.xyz)".
3. Click **add market** and fill in:
   - **id** (slug, e.g. `pcUSDC` — used in tx records and asset keys)
   - **label** (shown in the Portfolio + Send UI, e.g. "pcUSDC (devnet)")
   - **program ID** (paste the base58 from `solana program deploy`)
   - **SPL mint** (the asset being wrapped — defaults to devnet USDC)
   - **symbol / decimals / network**
   - optional **mint authority override** (leave blank to use the active dWallet ed25519 — the v0 default; set explicitly when joining a market with a fixed shared authority)
4. Click **add market**. First add becomes active automatically.
5. Switch to a Solana-base vault → the **Portfolio** page now shows a `pcUSDC` row plus a **Wrap** button on any USDC SPL row.

The runtime cache is hydrated on every SW startup via `bootPcTokenMarkets()` in [`pc-token-markets.ts`](../src/background/encrypt-pc/pc-token-markets.ts). Settings survive extension reload + SW evict.

### Multiple markets (e.g. friend group + production)

Add a second market with the same `splMint` but a different `programId` and/or `mintAuthorityB58`. Both pcToken rows render in the Portfolio with their own labels; the Send asset picker lists each as a separate `pc:${marketId}` entry. The **active** market is the default for fresh sessions; you can override per call.

### Programmatic configuration (advanced)

For CI / scripted deployments:

```ts
await trpc.addPcTokenMarket.mutate({
  id: 'pcUSDC',
  label: 'pcUSDC (devnet)',
  splMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  splSymbol: 'USDC',
  splDecimals: 6,
  programId: '<the deployed program id>',
  network: 'sol-devnet',
});

await trpc.setActivePcTokenMarket.mutate({ marketId: 'pcUSDC' });
await trpc.removePcTokenMarket.mutate({ marketId: 'pcUSDC' });
await trpc.listPcTokenMarkets.query();
```

## Architecture

```
src/background/encrypt-pc/
├── pc-token-program.ts         constants, ix discriminators, program ID sentinel
├── pc-token-types.ts           PcTokenError + per-flow input/output shapes
├── pc-token-pda.ts             PDA derivations (pcMint, vault, account, receipt, CPI auth, encrypt PDAs)
├── pc-token-cpi.ts             buildEncryptCpiSuffix (the 9-account suffix on every FHE ix)
├── pc-token-amount-encrypt.ts  CreateInput gRPC → ciphertext_identifier for u64 amounts
├── pc-token-instructions.ts    ix builders: Wrap, Transfer, InitializeAccount, UnwrapBurn/Decrypt/Complete, InitializeVault
├── pc-token-flows.ts           orchestration: wrap, hidden transfer, 3-step unwrap, account status
├── pc-token-balance.ts         ReadCiphertext + 60s cache + cache-bust hook
├── pc-token-pda.test.ts        PDA derivation tests
└── pc-token-instructions.test.ts  ix layout tests

src/background/encrypt-pc/pc-token-markets.ts  market registry: add/remove/list/setActive + boot
src/server/routers/pc-token.ts                 tRPC: listPcTokenMarkets, addPcTokenMarket, pcTokenWrap, pcTokenTransferHidden, pcTokenUnwrapStep, getPcBalance, ackPcDisclaimer, ...

src/ui/components/
├── HiddenSendDisclaimerModal.tsx   3-checkbox honesty disclosure (reused on first hidden send per vault)
├── HiddenSendBadge.tsx             lock icon rendered on activity rows for pc-* txs
├── PcTokenMarketsPanel.tsx         Settings panel: add/remove/activate markets
├── WrapPcTokenModal.tsx            opens from a Wrap button on an eligible SPL Portfolio row
├── UnwrapPcTokenModal.tsx          opens from the Unwrap button on a pcToken Portfolio row; multi-step progress
└── HiddenTransferForm.tsx          rendered in SendPage when the user picks a `pc:${marketId}` asset

src/ui/pages/
├── DWalletPortfolioPage.tsx        renders pcToken + SPL rows on Solana rail; mounts wrap/unwrap modals
└── SendPage.tsx                    asset picker includes pcToken markets; HiddenTransferForm replaces the standard form when selected
```

## Reuse from chromatika's existing encrypt.xyz integration

PC-Token rides the same gRPC pipe as encrypted dWallet labels and encrypted activity notes:

| primitive | path |
|---|---|
| `CreateInput` gRPC | `encrypt-grpc-web-fetch.ts` (existing) |
| `ReadCiphertext` gRPC | `encrypt-grpc-web-fetch.ts` (existing) |
| protobuf wire codec | `encrypt-protobuf-wire.ts` (existing) — covers PC-Token byte-for-byte, no new proto work |
| 17-byte mock helper | `encrypt-lab-service.ts:mockEncryptScalarBytes` (existing) |
| network key resolver | `encrypt-lab-service.ts:resolveNetworkEncryptionPublicKey` (existing) |
| ed25519 sign for ReadCiphertext | `signMessageSol` (chains/signing/ed25519.ts) |
| solana tx broadcast | new `pc-token-flows.ts:sendPcTokenTx` modeled on `solana-send-native.ts` |

The only PC-Token-specific bit is `authorized = PC_TOKEN_PROGRAM_ID.toBytes()` on every `CreateInput` — vs the Encrypt program ID for label encryption. The proto remains identical.

## Demo flow (two profiles required)

### Setup (5 min, one-time)

1. Two chrome profiles, each with a chromatika dev build loaded unpacked from `wallet-extension/dist/`.
2. Both profiles unlock with funded Solana ika base vaults.
3. Both vaults fund their solana fee-payer with ~0.1 devnet SOL.
4. Mint test USDC on devnet to both wallets via https://faucet.circle.com/.
5. Configure `PC_TOKEN_PROGRAM_ID_B58` per "Configuring the program ID" above.

### Demo

1. **Profile A (Alice) — Settings → PC-Token markets → add market** with the deployed program ID + USDC mint. First add becomes active automatically.
2. Switch to a Solana-base vault → **Portfolio** → on the Solana rail you'll see the existing USDC SPL row with a new **Wrap** button alongside Send, plus a dimmed `pcUSDC` row.
3. Click **Wrap** on the USDC row → modal opens → enter `100`, click "wrap" → first wrap auto-initializes Alice's pcUSDC account + wraps 100 USDC. Solana explorer shows the SPL transfer to vault (visible) + ciphertext-account writes (opaque).
4. The pcUSDC row updates after the modal triggers a balance decrypt (`getPcBalance`) — `100.00` after 1-3s.
5. **Profile B (Bob) — same setup** + wrap any small amount (1 USDC) just to initialize Bob's pcUSDC account.
6. Back to **Profile A**:
   - Click **Send** on the pcUSDC Portfolio row (or open Send and pick the `🔒 pcUSDC` entry from the asset dropdown).
   - The Send page swaps in the `HiddenTransferForm` with the inline explainer card.
   - Paste Bob's solana address, amount = `25`, click "send hidden".
   - First time this session: `HiddenSendDisclaimerModal` shows all 3 acknowledgements. Check all three, click "I understand, continue".
   - Tx broadcasts. Activity feed row appears with the lock-icon `HiddenSendBadge` and label "private send · pcUSDC".
7. **Profile B** — Portfolio → pcUSDC row → click decrypt → balance shows `26.00` (1 + 25 = 26).
8. To unwrap: click **Unwrap** on the pcUSDC row → modal runs the 3-step orchestration (burn → executor wait → release). The modal shows live progress.
9. Compare on solana explorer:
   - The hidden-transfer tx hash shows ciphertext account state writes only.
   - **No plaintext amount or recipient** in the on-chain ix data.
   - The signer (Alice's address) IS visible in the tx headers — call this out as the honest limitation.

## Known limitations / gotchas

- **Sender visibility** is fundamental to PC-Token's design today, not a chromatika omission.
- **Ciphertext-account correlation** means repeat Alice → Bob sends are linkable on-chain via TokenAccount PDA writes.
- **Devnet wipes** drop existing ciphertexts; chromatika surfaces `devnet-wipe` errors clearly.
- **Decryption latency** ~1-3s (sometimes up to 60s on slow devnet) — UI must spinner, never block.
- **Unwrap is 3 separate transactions** with executor wait between burn and complete; the orchestrator returns step results so the UI can render an accurate progress indicator.
- **Pre-balance check before transfer** prevents silent no-ops (Transfer disc 3 returns success on insufficient balance) — chromatika reads the decrypted balance before submitting to fail-fast with `insufficient-balance`.
- **Recipient must have called InitializeAccount** for the mint before they can receive a hidden transfer; chromatika returns `recipient-account-uninitialized` with copy suggesting the sender share an onboarding link.
- **Chromatika v0 is single-asset (devnet USDC)**; multi-asset is a config-table extension.
- **Per-install pcUSDC mint authority** in v0 (the active dWallet ed25519); cross-install transfers require both sides on the same demo configuration. Future: shared canonical mint.

## Brainstorm: other PC-Token-enabled features

ranked by **demo impact × effort × pre-alpha viability**:

1. **(shipped)** Hidden recipient transfer — wrap, send hidden, decrypt, unwrap.
2. **(shipped)** Encrypted portfolio view — decrypted pcToken balances in PrivateBalancesPanel.
3. **Anonymous tipping / donations** *(small, viral)* — streamer publishes a chromatika tip address; viewers send hidden pcUSDC. Fast-follow.
4. **Confidential receipts (x402 hidden)** *(medium)* — wraps the existing x402 flow with pcUSDC; receipts encrypt amounts. Sensitive billing surface. **At-rest portion shipped 2026-04-30** — toggle in Payments page (new top-level tab via the four-icon tray) encrypts `{resourceUrl, sellerAddress, signatureHex}` per receipt via `EncryptXyzBackend` (self-recipient envelope). Plain fields (host, amount, status, settlement tx) stay visible so daily caps still enforce. **On-chain pcUSDC settlement remains future** — needs an x402 facilitator that accepts pcUSDC.
5. **Hidden gift envelope** *(medium)* — encrypt a privkey via PC-Token authorized field; recipient redeems. Cute demo. Gated on key-wrapping support in PC-Token (verify upstream).
6. **Confidential payroll batch** *(large)* — N-recipient batch transfers in a single graph. Headline use case ("no on-chain comp leakage") but receipt-graph composition non-trivial.
7. **Private swap via PC-Swap** *(large, headline)* — UniV2-style AMM with FHE reserves + amounts. Receipt-gated composability with PC-Token. ~3+ weeks.
8. **Encrypted asset compartments** *(large)* — partition a dWallet into N sub-vaults each with its own pcToken list. Walrus-dependent.
9. **DAO confidential treasury** *(large)* — shared pcToken account; member proposals encrypt spend amounts + beneficiaries. Anchor governance CPI.
10. **MEV protection via PC-Swap routing** — bundle with #7.

## Related docs

- [`PC_TOKEN_SPIKE.md`](PC_TOKEN_SPIKE.md) — phase-0 working notes (delete after this doc stabilizes)
- [`ENCRYPTION_BACKEND.md`](ENCRYPTION_BACKEND.md) — encrypt.xyz backend abstraction (separate primitive; PC-Token complements but doesn't depend on it)
- [`STATUS.md`](STATUS.md) — single-source shipped/gated/future index
