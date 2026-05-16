# chromatika seeker

native android wallet on the solana seeker. sibling to the chrome extension under [`../wallet-extension/`](../wallet-extension/), additive (not a replacement).

planning doc: [`../plans/plan-a-native-solana-shiny-steele.md`](../plans/plan-a-native-solana-shiny-steele.md) (in `~/.claude/plans/` on the dev machine that planned this; reproduced inline below where it matters).

## why this exists

1. **seed vault is the user's hardware**. when the seeker signs `ika.chromatika.user-share-encryption-key.v1`, `keccak256(sig)` is the same 32-byte ika `UserShareEncryptionKeys` seed the extension derives at MWA-remote pair time ([`hd.ts:131`](../wallet-extension/src/background/keyring/hd.ts:131)). ed25519 is deterministic per RFC 8032, so the same seeker on any device, in the extension or the app, lands on the **same dWallet IDs**. zero migration.
2. **seeker app becomes an MWA wallet**. other android dapps + desktop dapps via WC pair with a first-party chromatika wallet instead of routing through solana mobile's reflector demo host. removes the reflector fragility that keeps `VITE_ENABLE_MWA_REMOTE=false` in extension prod builds.

## pre-alpha disclaimer (canonical)

per the project-wide rule at the top of [`../CLAUDE.md`](../CLAUDE.md):

> solana ika base is **devnet-only pre-alpha**. signatures come from a **single mock signer**, not distributed MPC. do **not** submit real-value transactions through ika-on-solana. mainnet solana sends use seed vault directly (no MPC). sui-base ika stays production-grade.

the app surfaces this banner on every solana-base dwallet screen and hard-blocks mainnet routes through the ika gRPC client.

## current state (phase 0 + identity kernel)

shipped:

- gradle project skeleton (AGP 8.7, kotlin 2.0, compose-compiler stable, jdk 17).
- android manifest with seed vault + MWA wallet-side `solana-wallet://` intent filter.
- compose entry surface with the pre-alpha disclaimer above the fold.
- **kotlin port of the ika seed derivation kernel** at [`app/src/main/java/xyz/chromatika/seeker/identity/IkaSeedDerivation.kt`](app/src/main/java/xyz/chromatika/seeker/identity/IkaSeedDerivation.kt). byte-for-byte parity with the extension's [`hd.ts:131`](../wallet-extension/src/background/keyring/hd.ts:131). same `IKA_USK_DOMAIN` string, same keccak256(sig || index_le) preimage, same RFC 8032 ed25519 keypair shape.
- parity test suite at [`app/src/test/java/xyz/chromatika/seeker/identity/IkaSeedDerivationTest.kt`](app/src/test/java/xyz/chromatika/seeker/identity/IkaSeedDerivationTest.kt) mirroring the invariants in the extension's [`hd.test.ts`](../wallet-extension/src/background/keyring/hd.test.ts).
- ika-js webview bridge skeleton at [`ika-js/`](ika-js/) (vite single-file output into `app/src/main/assets/ika-js/`).

not yet wired:

- real seed vault SDK binding (only the `SeedVaultIdentity` interface ships in phase 0).
- the rest of the plan (chains, UI parity, dapp bridge, MCP, etc.) - see the plan file.

## how to build

prerequisites:

- jdk 17.
- android sdk + build-tools 35.
- node 20+ for `ika-js/`.
- (optional) seed vault simulator on a fresh android 12 emulator for dev work without a seeker.

steps:

```bash
# 1. build the ika-js bundle (writes into app/src/main/assets/ika-js/)
cd chromatika-seeker/ika-js
pnpm install
pnpm run build

# 2. build the android APK
cd ..
./gradlew :app:assembleDevDebug          # development APK with .dev applicationId suffix
./gradlew :app:assembleDappstoreRelease  # dApp Store release APK (signing config required)
```

unit tests (no device or emulator needed):

```bash
./gradlew :app:testDevDebugUnitTest
```

the parity tests for ika seed derivation run as part of this. if they fail after a kotlin or extension change, **stop and figure out why before merging** - drift here breaks cross-app identity continuity.

## release

dApp store flow (per [`../skills/solana-seeker/SKILL.md`](../skills/solana-seeker/SKILL.md) §"dApp Store publishing and deployment"):

```bash
# one-time per app
npx dapp-store create app -k <publisher-keypair>

# every release
./gradlew :app:assembleDappstoreRelease
# sign the apk with the dApp Store keystore (never reuse the Google Play key!)
apksigner sign --ks dappstore.keystore --ks-key-alias dappstore \
    --out chromatika-seeker-v0.1.0-signed.apk \
    app/build/outputs/apk/dappstore/release/app-dappstore-release-unsigned.apk

npx dapp-store create release -k <publisher-keypair> -b <android-sdk-build-tools>
npx dapp-store publish submit -k <publisher-keypair> -u <mainnet-rpc> \
  --requestor-is-authorized --complies-with-solana-dapp-store-policies
```

## docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) - phase-by-phase overview.
- [`docs/SEED_VAULT_PARITY.md`](docs/SEED_VAULT_PARITY.md) - why the identity kernel guarantees same dWallets across surfaces.
- [`docs/DAPP_STORE_RELEASE.md`](docs/DAPP_STORE_RELEASE.md) - keystore, App NFT, Release NFT, submission.
