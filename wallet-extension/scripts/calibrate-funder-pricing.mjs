#!/usr/bin/env node
/**
 * one-shot calibration for funder/src/config.ts. reads the live mainnet ika coordinator
 * pricing map via @ika.xyz/sdk and prints the per-session SUI + IKA amounts the team
 * funder should send. mirrors getRequiredCoinAmounts() in
 * src/background/ika/pricing.ts (same fold-max + 10% buffer) so the funder lines up
 * with the wallet's own pricing calculation.
 *
 * usage:
 *   node scripts/calibrate-funder-pricing.mjs
 *
 * output: human-readable block + a JSON line for piping into tooling. paste the
 * `PER_SESSION_*` values into funder/src/config.ts and stamp the comment block above
 * those constants with today's date + observed numbers.
 *
 * re-runs are safe (read-only RPC). expected runtime is a few seconds.
 */

import { IkaClient, getNetworkConfig } from '@ika.xyz/sdk';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

// the wallet uses graphql.mainnet.sui.io in production (src/config/sui.ts); the funder
// is currently pointed at sui-mainnet.mystenlabs.com in wrangler.toml. ika config object
// reads sometimes 502 against the mystenlabs gateway, so calibration runs against the
// wallet's endpoint. pricing data is identical (same chain) - this only affects which
// gateway hands us the read.
const SUI_GRAPHQL_URL = 'https://graphql.mainnet.sui.io/graphql';

/**
 * mirror of installGetObjectsChunking in src/background/sui-client.ts. without this,
 * IkaClient.ensureInitialized() asks for 50 config objects in one POST and Mysten's
 * GraphQL gateway rejects the oversized body. chromatika installs this wrapper at
 * every new SuiGraphQLClient(...) site in the wallet, and the funder Worker does
 * the same (see funder/src/sui.ts:createGraphQLClient).
 */
function installGetObjectsChunking(client) {
  const core = client.core;
  const original = core.getObjects.bind(core);
  core.getObjects = async (options) => {
    const ids = options?.objectIds ?? [];
    if (!Array.isArray(ids) || ids.length <= 12) return original(options);
    const merged = [];
    for (let i = 0; i < ids.length; i += 12) {
      const slice = ids.slice(i, i + 12);
      const page = await original({ ...options, objectIds: slice });
      merged.push(...(page?.objects ?? []));
      if (i + 12 < ids.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return { objects: merged };
  };
  return client;
}

// fallback floor lives in funder/src/config.ts. duplicated here so we can compute
// the final value the user should paste without round-tripping back to that file.
const FALLBACK_PER_SESSION_IKA = 10_000_000n;
const FALLBACK_PER_SESSION_SUI = 10_000_000n;

// matches funder/src/config.ts SCOPE_MULTIPLIER: 2 dWallets * 5 sessions * 1.2 buffer.
const SCOPE_MULTIPLIER = 12n;

const BPS_BUFFER = 10n; // +10%, same as pricing.ts.

function maxBigint(a, b) {
  return a > b ? a : b;
}

function formatBaseUnits(n, decimals = 9) {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${s}` : s;
}

async function main() {
  const suiClient = installGetObjectsChunking(new SuiGraphQLClient({ url: SUI_GRAPHQL_URL }));
  const ikaClient = new IkaClient({
    suiClient,
    config: getNetworkConfig('mainnet'),
    cache: false,
  });

  const { coordinatorInner } = await ikaClient.ensureInitialized();
  const entries = coordinatorInner.pricing_and_fee_manager.current.pricing_map.contents;

  let maxIka = 0n;
  let maxSui = 0n;
  for (const entry of entries) {
    const feeIka = BigInt(entry.value.fee_ika);
    const gasSui =
      BigInt(entry.value.gas_fee_reimbursement_sui) +
      BigInt(entry.value.gas_fee_reimbursement_sui_for_system_calls);
    if (feeIka > maxIka) maxIka = feeIka;
    if (gasSui > maxSui) maxSui = gasSui;
  }

  // matches pricing.ts: if the on-chain map is empty (theoretically possible during
  // governance migrations), fall through to the SDK's hardcoded floor.
  const observedIka = maxIka === 0n ? FALLBACK_PER_SESSION_IKA : maxIka + maxIka / BPS_BUFFER;
  const observedSui = maxSui === 0n ? FALLBACK_PER_SESSION_SUI : maxSui + maxSui / BPS_BUFFER;

  // funder uses max(observed, fallback) as a safety floor so a temporarily depressed
  // pricing map (or a governance bug) never under-funds a new user.
  const perSessionIka = maxBigint(observedIka, FALLBACK_PER_SESSION_IKA);
  const perSessionSui = maxBigint(observedSui, FALLBACK_PER_SESSION_SUI);
  const fundingIka = perSessionIka * SCOPE_MULTIPLIER;
  const fundingSui = perSessionSui * SCOPE_MULTIPLIER;

  console.log('chromatika team funder pricing calibration');
  console.log('==========================================');
  console.log(`source:        ${SUI_GRAPHQL_URL}`);
  console.log(`pricing rows:  ${entries.length}`);
  console.log('');
  console.log('observed (max across all curves / protocols, +10% buffer):');
  console.log(`  per-session IKA: ${observedIka} base units  (${formatBaseUnits(observedIka)} IKA)`);
  console.log(`  per-session SUI: ${observedSui} mist        (${formatBaseUnits(observedSui)} SUI)`);
  console.log('');
  console.log('fallback floor:');
  console.log(`  per-session IKA: ${FALLBACK_PER_SESSION_IKA}`);
  console.log(`  per-session SUI: ${FALLBACK_PER_SESSION_SUI}`);
  console.log('');
  console.log(`paste into funder/src/config.ts (max(observed, fallback)):`);
  console.log(`  export const PER_SESSION_IKA: bigint = ${perSessionIka}n;`);
  console.log(`  export const PER_SESSION_SUI: bigint = ${perSessionSui}n;`);
  console.log('');
  console.log(`with SCOPE_MULTIPLIER = ${SCOPE_MULTIPLIER}n -> per-recipient drip:`);
  console.log(`  FUNDING_IKA: ${fundingIka} base units  (${formatBaseUnits(fundingIka)} IKA)`);
  console.log(`  FUNDING_SUI: ${fundingSui} mist        (${formatBaseUnits(fundingSui)} SUI)`);
  console.log('');
  console.log('machine-readable:');
  console.log(JSON.stringify({
    source: SUI_GRAPHQL_URL,
    pricingRows: entries.length,
    observed: { ikaBaseUnits: observedIka.toString(), suiMist: observedSui.toString() },
    floor: { ikaBaseUnits: FALLBACK_PER_SESSION_IKA.toString(), suiMist: FALLBACK_PER_SESSION_SUI.toString() },
    paste: { PER_SESSION_IKA: perSessionIka.toString(), PER_SESSION_SUI: perSessionSui.toString() },
    perRecipient: { FUNDING_IKA: fundingIka.toString(), FUNDING_SUI: fundingSui.toString() },
  }));
}

main().catch((e) => {
  console.error('calibration failed:', e?.stack || e);
  process.exit(1);
});
