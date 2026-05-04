# Solana phone-wallet pairing — runbook

How to pair a phone wallet (Solana Seeker or any MWA-compliant Android wallet, or any WalletConnect-shipping wallet like Phantom / Solflare / Backpack) with Chromatika running on **desktop Chromium**, so the phone's Seed Vault / passkey drives every Solana transaction without ever exposing secret bytes to the extension.

> **Pre-alpha disclaimer:** Solana ika base is **devnet only** and uses a **single mock signer** — there is no real MPC. **Do not use with real-value / mainnet assets.**

> **Heads up on the MWA-remote path:** Solana Mobile's reflector demo at `development.reflector.solanamobile.com` is currently unreliable for everyone (the wallet-side allowlists or untested code paths cause silent UI freezes). MWA-remote is **off by default in prod builds** (`VITE_ENABLE_MWA_REMOTE=false`); flip to `true` after Solana Mobile fixes the reflector. **WalletConnect v2 is the canonical desktop Solana hardware path today.**

---

## When to use which path

| Scenario | Pick |
|---|---|
| Chromatika on **desktop Chromium**, want to pair Phantom / Solflare / Backpack / Jupiter / any WC-shipping phone wallet | **WalletConnect** (canonical desktop path; requires `VITE_WC_PROJECT_ID` set at build time, register at cloud.reown.com) |
| Chromatika on **desktop Chromium**, want to pair a **Solana Seeker** (or any MWA wallet on Android) over QR, AND the public Solana Mobile reflector is working | **Seeker (QR pair)** — MWA-remote — this doc. Off by default; flip `VITE_ENABLE_MWA_REMOTE=true` to surface. |
| Chromatika on **Android Chromium / Kiwi**, the wallet app is on the **same phone** | **Solana Mobile (this phone)** — local Android intent, fastest path on the same device |
| You want a hardware Solana fee payer with no phone | Ledger Solana app (WebHID popup) |

The hardware step's UA gate flips automatically: Android UAs see the local entry, desktops see the WC entry plus the MWA-remote entry (when enabled).

---

## How it works under the hood (MWA-remote path)

1. **Pairing.** `SeekerConnect` calls `startRemoteScenario()` from `@solana-mobile/mobile-wallet-adapter-protocol-web3js`, opening a wss connection to `development.reflector.solanamobile.com` (the value of `MWA_REMOTE_HOST_AUTHORITY` in `src/background/hardware/mwa-remote.ts`). The lib returns an `associationUrl`; we render it as a QR plus a copyable string. The phone scans (or pastes into "scan link"), runs the MWA ECDH handshake, and after the user approves in Seed Vault, returns `{ accounts: [{ address }], auth_token }`. Address + token + reflector host are persisted on the `HardwareVaultRecord` (encrypted with the rest of the vault).
2. **Pairing also signs the ika derivation message.** During pairing, chromatika asks the wallet to sign `IKA_USK_DERIVATION_MESSAGE` (`'ika.chromatika.user-share-encryption-key.v1'`). Because Ed25519 is RFC 8032 deterministic, the same Seeker / phone wallet on any device produces the same signature for the same message. Two things derive from that signature:
   - **ika `UserShareEncryptionKeys` seed** at index 0: `keccak256(signature || index_le)` via `ikaRootSeedFromMwaSignature`. Same signature on any device = same seed = same dWallet (so a fresh chromatika install + same Seeker recovers the dWallet without an HD seed phrase).
   - **In-extension Solana fee-payer keypair** at index 1: `solanaFeeKeypairFromWalletSignature(signature, IKA_FEE_PAYER_DERIVATION_INDEX = 1)`, persisted as `ikaGrpcFeePayerSolSecretKeyB64` on the hardware record. The fee payer pays ika gRPC `approve_message` fees on devnet. Index 1 is reserved exclusively for fee-payer derivation; **index 0 is reserved for the ika seed and would key-collide if reused**.
   The Seed Vault on the phone signs **all chain transactions** (sends, dapp signing, dWallet authorize). The fee-payer keypair only signs ika gRPC fees inside the extension.
3. **Signing.** When a Solana tx needs the phone, the hardware-sign popup (`MwaSigner.tsx`) reads `mwaTransport` off the pending request. For `'remote'` it calls `startRemoteScenario` again, reauthorizes with the persisted `auth_token` (skipping QR), and delegates `signTransactions` / `signMessages`. The Seed Vault prompts on every approval.
4. **Re-pair UX.** If the wallet has revoked the token (`ERROR_AUTHORIZATION_FAILED`), the popup detects it via the `isAuthorizationFailedError` heuristic and surfaces a "your phone wallet revoked Chromatika's pairing — re-pair from the hardware step" message with the `needsRepair` flag.

> Old dev installs may carry the deprecated `ikaEncryptionOnlySolSecretKeyB64` field from when the fee-payer keypair was random per install. It's a read-only fallback for those vaults and receives no new writes. Per the pre-release policy, clear extension storage and re-onboard if you want the fully deterministic flow on an old vault.

---

## Manual verification

### One-time setup

```bash
cd wallet-extension
pnpm install
pnpm exec playwright install chromium   # only if you'll run the e2e suite
```

### Build with Solana ika base enabled

```bash
VITE_SOLANA_IKA_BASE=true pnpm run build
```

Load `dist/` unpacked in desktop Chromium (`chrome://extensions` → **Load unpacked**).

### Pair a Seeker (MWA-remote)

> Requires `VITE_ENABLE_MWA_REMOTE=true` at build time. WalletConnect (`VITE_WC_PROJECT_ID`) is the recommended desktop path while Solana Mobile's public reflector is unreliable.

1. Open the Chromatika side panel → onboarding → **Add Hardware Vault**.
2. Switch ika base to **Solana**.
3. Click **Seeker (QR pair)**.
4. Read the pre-alpha disclaimer; click **start pairing**.
5. A 256×256 QR appears. On the Seeker, open the camera (or the wallet's "scan link" input), scan the QR, then approve in **Seed Vault**. The pairing flow asks Seeker to sign `IKA_USK_DERIVATION_MESSAGE` so chromatika can derive the ika seed + fee-payer keypair deterministically.
6. The desktop UI flips to **paired: <address>** and auto-selects the new fee account in the dropdown below.
7. Click **add hardware vault**.

### Pair via WalletConnect (recommended desktop path)

1. Make sure the build has `VITE_WC_PROJECT_ID` set (register a project at cloud.reown.com).
2. Open the side panel → onboarding → **Add Hardware Vault**.
3. Switch ika base to **Solana**.
4. Click **WalletConnect**.
5. A WC v2 QR appears. On the phone, open Phantom / Solflare / Backpack / Jupiter / any WC wallet, scan the QR, approve the session.
6. chromatika persists the WC session topic + authorized account on the `HardwareVaultRecord` `walletconnect` field. Subsequent signs replay via `signClient.request({ topic: sessionTopic, ... })`. No QR rescan after pairing.
7. ika seed + fee-payer keypair derive the same way as MWA when the wallet supports `solana_signMessage` over `IKA_USK_DERIVATION_MESSAGE`; otherwise the flow falls back to the recovery-words path.

### Fund the in-extension fee-payer keypair

After the vault is created, the **in-extension Solana fee-payer keypair** (deterministically derived from the wallet's signature) needs ~0.1 devnet SOL to pay ika gRPC `approve_message` fees. The phone wallet's Seed Vault address pays nothing — it only signs Solana txs Chromatika builds.

The fee-payer address shows in the vault row labeled separately from the phone wallet's address. Fund it via:

```bash
solana airdrop 0.1 <fee-payer-address> --url devnet
```

…or paste the address into any devnet faucet. Same Seeker / phone wallet on any device produces the same fee-payer address, so SOL persists across reinstalls when you re-pair.

### Sign a transaction

1. With the Seeker vault active, run a Solana devnet send (or any flow that signs Solana).
2. The hardware-sign popup opens. The header reads:
   - **chain:** SOLANA (MWA)
   - **transport:** Seeker / remote (development.reflector.solanamobile.com)
   - **type:** `solanaTx` or `solanaOffchain`
3. Click **sign on phone** → the wss session reauthorizes silently → Seed Vault prompts on the Seeker → approve → signature returns to the popup → tx broadcasts.

Close the side panel and reopen. Sign again — no QR rescan, the persisted `auth_token` reauthorizes the new session automatically.

### (Optional) DKG + EVM signing on the same vault

The wallet-signature-derived ika seed seeds a SECP256K1 dWallet too, so once DKG completes you can sign EVM `personal_sign` and txs against the same Seeker / phone-wallet vault. The Seeker only ever sees the Solana `approve_message` calls — the EVM signature itself comes from ika gRPC + the in-extension fee-payer keypair.

---

## Troubleshooting

- **QR appears but never resolves.** The phone can't reach `development.reflector.solanamobile.com`. Some carrier networks block wss. Try wifi. Also: the public reflector is currently unreliable; if QR scan never resolves at all, switch to the WalletConnect path.
- **"your phone wallet revoked Chromatika's pairing".** The wallet returned `ERROR_AUTHORIZATION_FAILED` on reauthorize. Open the wallet on your Seeker → trusted apps → remove Chromatika → re-pair from the hardware step.
- **Sign popup hangs at "authorize chromatika on your phone…".** The reflector session opened but the wallet hasn't responded. Check that the wallet app is in foreground; some Android battery-saver setups freeze background sockets.
- **`Insufficient lamports` on every `approve_message`.** The in-extension fee-payer keypair (not the phone-wallet address) is unfunded. Top it up with devnet SOL.
- **`ERROR_NETWORK_FAILURE` on first sign after long idle.** Reflector sessions are short-lived; the popup reopens a session per sign. Retry.
- **Side panel was closed during pairing.** `SeekerConnect` cleans up the wss in its unmount handler. Reopen the side panel and start pairing again.
- **WalletConnect QR scans but session never establishes.** Confirm `VITE_WC_PROJECT_ID` is set at build time and matches a registered project at cloud.reown.com. Without it, the WC button stays disabled with a hint; with an invalid id, the relay rejects the session silently.

---

## Architecture pointers

| Area | File |
|---|---|
| Reflector config helper | `src/background/hardware/mwa-remote.ts` (`buildRemoteMwaConfig`, `MWA_REMOTE_HOST_AUTHORITY = 'development.reflector.solanamobile.com'`) |
| QR pairing UI (MWA-remote) | `src/ui/hardware/SeekerConnect.tsx` |
| Local intent UI (MWA-local Android) | `src/ui/hardware/MwaConnect.tsx` |
| WalletConnect pairing UI | `src/ui/hardware/WalletConnectPair.tsx` (and the WC signer route) |
| Sign popup (transport dispatch) | `src/ui/hardware/MwaSigner.tsx` (`withMwaWallet`) |
| Hardware step entry / UA gate | `src/ui/wallet-setup-flow/steps/hardware.tsx` |
| Vault persistence + signature-derived seed | `src/background/wallet-service.ts` (hardware-vault MWA + Solana branch) |
| Pending-sign transport context | `src/background/hardware/types.ts` (`PendingHardwareSign.mwaTransport` / `mwaAuthToken` / `mwaReflectorHost`) |
| Session forward to enqueue sites | `src/background/session.ts` (`SessionState.solanaMwaAccount`) + `src/background/chains/signing/solana-grpc.ts` |
| ika seed + fee-payer derivation | `src/background/keyring/hd.ts` (`ikaRootSeedFromMwaSignature`, `solanaFeeKeypairFromWalletSignature`, `IKA_USK_DOMAIN`) |
| Validator | `src/server/routers/vault.ts` (`addVaultHardware` zod schema) |

---

## Out of scope

- **iOS phones** — MWA spec is Android-only. WalletConnect works on iOS for any WC-shipping wallet.
- **Self-hosted reflector** — Chromatika defaults to Solana Mobile's hosted reflector at `development.reflector.solanamobile.com`. A self-hosted Cloudflare Workers reflector lives in [`reflector/`](../../reflector/) as a fallback (Durable Objects, ~150 lines TS); swap the constant only if Solana Mobile's host goes down. Per upstream wallet-side allowlists, arbitrary self-hosted reflectors often cause silent UI freezes.
- **Real MPC signing** — Solana ika is mock signing until ika ships Alpha 1; the phone wallet is a real signer for Solana txs but ika "MPC" output is a single mock signature.
- **CSP host pinning** — `connect-src *` covers the reflector + WC relay today; if the manifest tightens to an allowlist later, add `wss://development.reflector.solanamobile.com` and `wss://relay.walletconnect.com` (and any other WC bridges).
