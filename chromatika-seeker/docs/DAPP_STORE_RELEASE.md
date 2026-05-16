# dApp store release runbook

solana mobile dApp store flow for the seeker app. condensed from [`../../skills/solana-seeker/SKILL.md`](../../skills/solana-seeker/SKILL.md) §"dApp Store publishing and deployment". read that skill for full context, this is the seeker-specific cheat sheet.

## one-time setup

1. **generate a unique signing keystore** (NOT the google play keystore - dApp store requires a different one):

   ```
   keytool -genkey -v -keystore dappstore.keystore \
     -alias dappstore -keyalg RSA -keysize 2048 -validity 10000
   ```

   store the `.keystore` and password somewhere durable - losing it means we can never publish updates.

2. **register keystore location** in `chromatika-seeker/keystore.properties` (gitignored):

   ```properties
   dappstore.storeFile=/abs/path/dappstore.keystore
   dappstore.storePassword=...
   dappstore.keyAlias=dappstore
   dappstore.keyPassword=...
   ```

   the `app/build.gradle.kts` `signingConfigs.dappstore` block reads from this.

3. **prepare publisher wallet**: ~0.2 SOL on mainnet-beta, used for App NFT + Release NFT minting.

4. **publisher portal KYC** at https://publish.solanamobile.com (one-time per publisher).

5. **listing assets** at `chromatika-seeker/store-listing/assets/`:

   - icon 512x512
   - banner 1200x600
   - 4+ screenshots, 1080x1080 or higher, consistent aspect ratio
   - optional feature graphic 1200x1200
   - optional mp4 video, 720p+ (install `ffmpeg` if using video)

## per-release flow

```bash
# 1. bump versionCode + versionName in app/build.gradle.kts
# 2. build the ika-js bundle
cd chromatika-seeker/ika-js && pnpm install && pnpm run build && cd ..

# 3. build a signed release APK
./gradlew :app:assembleDappstoreRelease

# 4. (if signing config is not wired into gradle) sign manually
apksigner sign --ks dappstore.keystore --ks-key-alias dappstore \
    --out chromatika-seeker-v$(VERSION)-signed.apk \
    app/build/outputs/apk/dappstore/release/app-dappstore-release-unsigned.apk

# 5. verify signature
apksigner verify --print-certs chromatika-seeker-v$(VERSION)-signed.apk

# 6. mint App NFT (one-time across releases, skip after first)
npx dapp-store create app -k <publisher-keypair> -u <mainnet-rpc>

# 7. mint Release NFT
npx dapp-store create release -k <publisher-keypair> -b <android-sdk-build-tools> -u <mainnet-rpc>

# 8. submit for review
npx dapp-store publish submit -k <publisher-keypair> -u <mainnet-rpc> \
  --requestor-is-authorized --complies-with-solana-dapp-store-policies
```

## review checklist

before submitting:

- [ ] solana ika base disclaimer visible on every relevant screen + setup flow checkbox acknowledged.
- [ ] mainnet sends never route through ika-on-solana (code path hard-blocks, assertion + test covers it).
- [ ] MWA pair tested end-to-end with at least one shipping dapp (jupiter or magic eden mobile).
- [ ] seed vault sign tested on a real seeker (or seed vault simulator on android 12 emulator if no device).
- [ ] backup + restore: a vault created on one device with a given seeker, then restored on a different device with the same seeker, shows the same dWallet IDs.
- [ ] cold-start latency budget for ika DKG + first sign under 4 seconds on seeker hardware.
- [ ] dapp store CLI `validate` exits clean: `npx dapp-store validate -k <devkey> -b <android-sdk-build-tools>`.

## post-submission

- review SLA is 2-5 business days. ping #dapp-store on solana mobile discord if blocked.
- on approval: app appears in dApp store. push social + chromatika.xyz announcement.
- on rejection: address feedback, bump versionCode, rerun the flow from step 1.
