/**
 * funding amounts the team faucet sends per recipient.
 *
 * derivation:
 *   chromatika `@ika.xyz/sdk` exposes `getRequiredCoinAmounts(ikaClient)` (see
 *   wallet-extension/src/background/ika/pricing.ts). it returns `{ ikaAmount, suiAmount }` —
 *   the max protocol fee across DKG / presign / sign / re-encrypt for the SECP256K1 curve, with
 *   a 10% buffer baked in. empty-pricing-map fallback is `{ 10_000_000n, 10_000_000n }`
 *   (= 0.01 IKA in base units, 0.01 SUI in mist).
 *
 * per-dWallet scope confirmed with the user: DKG + full presign pool (3) + signing headroom
 * = 5x sessions. for 2 dWallets that's 10x. add a further 20% on top of the SDK's 10% buffer
 * for headroom: 12x. multiply per-session amounts by `SCOPE_MULTIPLIER` to get FUNDING_*.
 *
 * the constants below are CONSERVATIVE FALLBACKS — they assume the on-chain pricing map is
 * empty / unparseable, which is the worst case the SDK handles. on mainnet the pricing map IS
 * populated and the real amounts may differ. before first deploy, run a one-time read of
 * mainnet pricing and bump these to `max(observed_mainnet, fallback)`. revisit quarterly,
 * since on-chain pricing can be governance-updated.
 *
 * last calibrated: 2026-05-11 against https://graphql.mainnet.sui.io/graphql (49 pricing
 *   rows). raw observed max fee_ika across all curves + protocols was 250_000_000 base
 *   units; +10% buffer gives 275_000_000 (27.5x the SDK fallback floor!). raw observed
 *   max gas_fee_reimbursement_sui was 0n on mainnet at calibration time, so SUI stays at
 *   the 10_000_000n fallback floor. re-measure with `node wallet-extension/scripts/
 *   calibrate-funder-pricing.mjs` quarterly or after any ika governance change.
 * source of truth for the formula: wallet-extension/src/background/ika/pricing.ts
 */

/** per `getRequiredCoinAmounts`-session IKA cost in base IKA units (1 IKA = 10^9 base units). */
export const PER_SESSION_IKA: bigint = 275_000_000n;

/** per `getRequiredCoinAmounts`-session SUI cost in mist (1 SUI = 10^9 mist). */
export const PER_SESSION_SUI: bigint = 10_000_000n;

/** 2 dWallets * 5 sessions per dWallet * 1.2 buffer = 12x. */
export const SCOPE_MULTIPLIER: bigint = 12n;

/** total IKA the worker sends per recipient (FUNDING_IKA = PER_SESSION_IKA * SCOPE_MULTIPLIER). */
export const FUNDING_IKA: bigint = PER_SESSION_IKA * SCOPE_MULTIPLIER;

/** total SUI (mist) the worker sends per recipient (FUNDING_SUI = PER_SESSION_SUI * SCOPE_MULTIPLIER). */
export const FUNDING_SUI: bigint = PER_SESSION_SUI * SCOPE_MULTIPLIER;

/** Sui address regex: `0x` + 1-64 lowercase hex chars (canonical form, post-normalize). */
export const SUI_ADDRESS_RE = /^0x[a-f0-9]{1,64}$/;
