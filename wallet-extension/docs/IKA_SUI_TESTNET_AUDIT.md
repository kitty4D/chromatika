# Ika on Sui base, on Sui testnet + Ika testnet: risk audit

> read-only audit, 2026-05-04 (with one follow-up code change recorded in section 9). confirms whether you can DKG + sign on Sui testnet today, and lists every place the wiring could bite.

## 1. tl;dr

**verdict: doable today, with two metadata caveats and a funding pre-req.** the whole pipeline (`vault.network='testnet'` -> `dwalletNet.suiNetworkId='sui-testnet'` -> `registrySuiIdToSuiNetworkId()='testnet'` -> `getNetworkConfig('testnet')` from `@ika.xyz/sdk@0.4.0`) resolves cleanly to ika testnet packages, and `SuiIkaAdapter` is fully implemented (no stubs, no "mainnet only" guards anywhere on the sign path). signing flows (DKG, presign refill, sui native sends, evm sends, dapp tx) are correctly wired and chain-aware. what's awkward: the explorer/ChromaLab view filters IKA balances by a hardcoded mainnet coin type, so testnet IKA looks invisible there even though the wallet's protocol code uses the right type. what's broken: nothing on the actual sign path. like, srsly nothing. the rest is rough edges and "fund both faucets first or you'll get a clear-but-late error".

## 2. how the wallet resolves to ika testnet

trace:

1. user picks a registry network (`sui-testnet` is the only "non-mainnet" sui option after the change in section 9). gets stored on the dWallet vault settings.
2. [`src/config/sui.ts`](../src/config/sui.ts) `registrySuiIdToSuiNetworkId()` maps `sui-testnet` to ika's `'testnet'`. ika SDK only knows `'mainnet' | 'testnet'`.
3. [`src/background/vault-session-builder.ts:369-372`](../src/background/vault-session-builder.ts) constructs `new IkaClient({ suiClient, config: getNetworkConfig(dwalletSui), cache: true })`. `dwalletSui` is the value from step 2.
4. `node_modules/@ika.xyz/sdk/dist/esm/client/network-configs.js` returns the testnet config:

| field | testnet value |
|---|---|
| `ikaPackage` | `0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a` |
| `ikaCommonPackage` | `0x96fc75633b6665cf84690587d1879858ff76f88c10c945e299f90bf4e0985eb0` |
| `ikaSystemPackage` | `0xde05f49e5f1ee13ed06c1e243c0a8e8fe858e1d8689476fdb7009af8ddc3c38b` |
| `ikaDwallet2pcMpcPackage` | `0x6573a6c13daf26a64eb8a37d3c7a4391b353031e223072ca45b1ff9366f59293` |
| `ikaSystemObject.objectID` | `0x2172c6483ccd24930834e30102e33548b201d0607fb1fdc336ba3267d910dec6` (initialSharedVersion 508060325) |
| `ikaDWalletCoordinator.objectID` | `0x4d157b7415a298c56ec2cb1dcab449525fa74aec17ddba376a83a7600f2062fc` (initialSharedVersion 510819272) |

(values are public on-chain ids, sanity-check by reading the SDK file directly.)

## 3. sui graphql endpoint pairing

[`src/config/sui.ts:7-10`](../src/config/sui.ts) ships only `mainnet` and `testnet` GraphQL URLs (`https://graphql.testnet.sui.io/graphql` for testnet). the same `dwalletNet.suiNetworkId` feeds both `SuiGraphQLClient` and `IkaClient`, so testnet RPC + testnet ika packages stay aligned by construction. no separate config knob to mismatch. it's all one source of truth in `vault-session-builder.ts`. zero chance of "ika testnet packages on sui mainnet RPC" unless someone manually edits storage rows. solid.

## 4. adapter parity (no stubs on sui)

[`src/background/ika/ika-adapter.ts:88-130`](../src/background/ika/ika-adapter.ts) `SuiIkaAdapter` directly delegates every method to `IkaClient`:

- `getDWallet`, `getOwnedDWalletCaps`
- `getPresignInParticularState`
- `getEncryptedUserSecretKeyShare`
- `getSign`, `getSignInParticularState`
- `executeTx` (routes through `executeSuiTransaction` for PTB submission)

contrast with `SolanaIkaAdapter` (lines 136-187), which is the well-known stubs-and-throwers situation. that's not relevant on this audit; we're firmly on sui base.

## 5. risks, ranked

| sev | where | what it actually means |
|---|---|---|
| 🟢 not a blocker | [`src/background/ika/anchored-discovery-address.ts:17`](../src/background/ika/anchored-discovery-address.ts) hardcodes `'mainnet'` as the third arg to `deriveChainAddressesFromActivePublicOutput`. verified at [`dwallet-derived-addresses.ts:62-94`](../src/background/chains/dwallet-derived-addresses.ts) the `btcNetwork` arg only branches inside the SECP256K1 path; the ED25519 branch (which this caller uses) ignores it completely. | dead-arg. cosmetic only. document and move on, don't fix as part of this audit. |
| 🟡 caveat (UX) | [`src/background/ika/explorer.ts:25`](../src/background/ika/explorer.ts) hardcodes `IKA_COIN_TYPE = '0x7262fb2f...::ika::IKA'`, which is the **mainnet** ikaPackage. compare to the dynamic helper at [`src/background/ika/coins.ts:12-14`](../src/background/ika/coins.ts) (`ikaCoinType(config)` derives from `ikaConfig.packages.ikaPackage`). | the explorer / ChromaLab activity view will mis-filter IKA on a testnet vault. **does not affect DKG, presign refill, or signing**, those use `coins.ts` correctly. file as a follow-up bug, not a blocker for the user's testnet run. |
| 🟡 caveat (UX) | no pre-DKG funding estimate. [`src/background/ika/coins.ts:160-181`](../src/background/ika/coins.ts) `requireSuiAndIkaCoins` throws `"No SUI coins for gas..."` / `"No IKA for protocol fees..."` only at DKG time. | first-DKG attempt with empty wallet returns a clear-but-late error. just hit both faucets first. |
| 🟡 caveat (UX) | move abort decoding. [`src/background/ika/lifecycle/dkg.ts:179-183`](../src/background/ika/lifecycle/dkg.ts) stringifies raw `FailedTransaction` errors. per CLAUDE.md, abort code 1 = insufficient IKA, code 2 = insufficient SUI in `sessions_manager::initiate_user_session`. | if on-chain pricing changes between `getRequiredCoinAmounts()` and execution, the user gets a cryptic `MoveAbort(...)` instead of "fund more IKA/SUI." `getRequiredCoinAmounts` already adds a 10% buffer, so this is rare but possible. |
| 🟡 caveat (UX) | silent zero-trust fallback. [`src/background/ika/lifecycle/dkg.ts:221-238`](../src/background/ika/lifecycle/dkg.ts) catches and swallows failures from `acceptEncryptedUserShareForCurve`, leaving the dWallet in `awaiting_key_holder_signature` with no UI prompt to retry. | if your testnet GraphQL flakes during the accept-share PTB, you'll have a "DKG done" dWallet that won't sign until accept-share is re-run. worth knowing, totally fixable in a follow-up. |
| 🟢 already handled | coin amounts on PTBs come from `getRequiredCoinAmounts(ikaClient)` ([`pricing.ts`](../src/background/ika/pricing.ts)) which queries the testnet coordinator's pricing map. zero hardcoded mainnet amounts. |
| 🟢 already handled | presign pool refill ([`src/background/ika/presign-pool.ts:25-29, 164-206`](../src/background/ika/presign-pool.ts)) uses `requestGlobalPresign` for sui-base across all three pools and splits coins via the pricing map. ED25519 pool is **not** skipped on sui-base (only solana-base skips it for the documented Ed25519-deterministic + gRPC reasons in CLAUDE.md). |
| 🟢 already handled | sui personal-message hashing. `sui-personal-message.ts:33-37` uses BLAKE2b correctly for sui's intent-message envelope. `signMessageSol` then routes through ika with SHA512 (the ika-side hash, not the message hash). this is the documented "ika sha512 path, not blake2b" gotcha from CLAUDE.md, and it's the right call: the wallet's `sui_signPersonalMessage` produces signatures that verify byte-for-byte against `@mysten/sui` `verifyPersonalMessageSignature` (covered by `chains/sui-personal-message.test.ts`). |
| 🟢 already handled | MV3 service worker compat. `IkaClient` rides `SuiGraphQLClient` (fetch-only). no websockets, no node `https`, no `window` access. the solana `confirmTransaction` MV3 trap doesn't apply to the sui path at all. |
| 🟢 already handled | STATUS.md does not gate sui-base ika as `stubbed` / `gated` / `future`. it's plainly listed as shipped. |

## 6. pre-flight checklist (for the eventual live run)

- [ ] vault `network` set to `testnet` (registry id `sui-testnet`, the only non-mainnet option after the section 9 cleanup). confirm via the network selector.
- [ ] active dWallet vault has `baseChain: 'sui'` (not solana).
- [ ] sui faucet: fund the vault's sui address with at least the minimum split (`MIN_SPLIT_AMOUNT_MIST = 500_000_000n` = 0.5 SUI). aim for 1-2 SUI to comfortably cover DKG + a few presign refills + a few sends.
- [ ] ika testnet faucet: fund the vault's sui address with IKA testnet coins. coin type to look for: `0x1f26bb2f711ff82dcda4d02c77d5123089cb7f8418751474b9fb744ce031526a::ika::IKA`. amount: `getRequiredCoinAmounts(ikaClient)` × (1 DKG + 3 presigns initial refill + headroom).
- [ ] expect the explorer / ChromaLab IKA balance to read 0 even when the vault holds testnet IKA (mainnet-coin-type bug noted in section 5). use sui's official testnet explorer to verify the actual coin object is in the address.

## 7. verification path (sanity-check this doc later)

audit is read-only, so verifying it = "did the quotes survive code drift?":

- open each `file:line` link in section 5 and confirm the line still says what the audit claims.
- `cat wallet-extension/node_modules/@ika.xyz/sdk/dist/esm/client/network-configs.js` and confirm the testnet object IDs match section 2.
- optional live verification (out of scope for this doc): build, load unpacked, set vault to `sui-testnet`, fund both faucets, run DKG, then `signMessageSol` against any ED25519 dWallet from the wallet UI. each step that fails should map to a 🟡 row in section 5; no row should produce a 🔴 surprise. if it does, the audit is wrong, ping it.

## 8. out of scope (intentionally)

- fixing [`explorer.ts:25`](../src/background/ika/explorer.ts) IKA_COIN_TYPE hardcode (filed as a follow-up risk, not this audit's job).
- fixing the dead `'mainnet'` arg in [`anchored-discovery-address.ts:17`](../src/background/ika/anchored-discovery-address.ts).
- adding pre-DKG funding estimate UI / move-abort decoding / accept-share retry. all listed as 🟡 caveats; product decisions for separate work.
- e2e test for the full DKG/sign cycle.
- live build / load / faucet run.

## 9. follow-up: sui-devnet removed from network selector (2026-05-04)

while writing this audit we noticed `sui-devnet` in the network selector was a footgun: picking it pointed `SuiGraphQLClient` at `https://sui-devnet.mystenlabs.com/graphql` (real sui devnet) but kept `IkaClient` on **ika testnet** packages (because `getNetworkConfig` only knows mainnet/testnet). ika testnet packages don't exist on sui devnet, so DKG + presign + sign all would have failed at simulation with package-not-found. combined with sui devnet's regular wipe cadence, the option was unusable for the wallet's identity model (which routes everything through ika dWallets per CLAUDE.md). removed it from the selector so users can't pick the broken combo.

deleted entry: [`config/networks.ts`](../src/config/networks.ts) `BUILTIN_SUI` no longer includes `sui-devnet` (was an entry pointing at `sui-devnet.mystenlabs.com/graphql`).

dead code cleaned in the same change:
- [`config/sui.ts`](../src/config/sui.ts) `registrySuiIdToSuiNetworkId` no longer special-cases `sui-devnet`.
- [`background/sui-client.ts`](../src/background/sui-client.ts) `createSuiGraphQLClientFromRegistryNetworkId` no longer carries the devnet branch (and the unused `BUILTIN_SUI` import is gone).
- [`background/services/sui-kiosk.ts`](../src/background/services/sui-kiosk.ts) `SUI_KIOSK_NETWORK` map no longer maps `sui-devnet` to `'testnet'`.
- [`config/explorers.ts`](../src/config/explorers.ts) `suiExplorerNetworkSlug` return type narrowed from `'mainnet' | 'testnet' | 'devnet'` to `'mainnet' | 'testnet'`.
- [`lib/explorer-href.ts`](../src/lib/explorer-href.ts) `balancesNetworkIdFromSlug` dropped the `'devnet' -> 'sui-devnet'` reverse mapping; two `'sui-devnet'` fallbacks (when `networks.active` is null) re-pointed to `'sui-mainnet'`.
- [`ui/pages/IkaStakingPage.tsx`](../src/ui/pages/IkaStakingPage.tsx) one `'sui-devnet'` fallback re-pointed to `'sui-mainnet'`.

result: the only "non-mainnet" sui option in the selector is now `sui-testnet`, which is what you want for testnet ika anyway. if ika ever ships actual devnet packages (or the sui devnet RPC starts hosting testnet ika packages), this can be reversed in one PR by re-adding the `BUILTIN_SUI` entry plus the `registrySuiIdToSuiNetworkId` branch.
