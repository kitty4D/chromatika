#!/usr/bin/env node
/**
 * controlled experiment: create one global presign per curve on ika mainnet via the
 * documented `requestGlobalPresign` flow, then poll each for state transitions. used
 * to prove whether ED25519 presigns actually advance past `Requested` on the current
 * mainnet validator set, by running them right next to a SECP256K1 control under
 * identical code/package/network conditions.
 *
 * usage:
 *   SUI_PRIVATE_KEY=suiprivkey1... node scripts/test-presign-curves.mjs
 *
 * the signer needs to hold (on Sui mainnet at the suiprivkey's address):
 *   - >= ~0.3 SUI total at the address (gas budget + per-presign sui protocol fee, x2)
 *   - >= ~0.02 mainnet IKA coins (per-presign ika protocol fee, x2). mainnet IKA coin
 *     type is `${ikaDwallet2pcMpc network-configs `ikaPackage`}::ika::IKA`.
 *
 * what it prints:
 *   - enum -> u32 conversion the SDK does for each curve / signature algorithm
 *   - the digest + presign_id for each submitted PTB
 *   - every state transition observed during a 120s poll window
 *   - a final summary line per curve: `completed` (with elapsed ms) or `timeout`
 *
 * if SECP256K1 reaches `Completed` and ED25519 sits in `Requested`, the bottleneck
 * is curve-side at the validators, not in chromatika or the SDK.
 */

import {
  IkaClient,
  IkaTransaction,
  Curve,
  SignatureAlgorithm,
  getNetworkConfig,
} from '@ika.xyz/sdk';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import process from 'node:process';

const PRIV = process.env.SUI_PRIVATE_KEY;
if (!PRIV) {
  console.error('error: SUI_PRIVATE_KEY env var not set');
  console.error('expected: bech32 `suiprivkey1...` for a mainnet-funded address');
  process.exit(1);
}

const { secretKey } = decodeSuiPrivateKey(PRIV);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const owner = keypair.toSuiAddress();

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
const NETWORK_CONFIG = getNetworkConfig('mainnet');
const ikaClient = new IkaClient({
  suiClient,
  config: NETWORK_CONFIG,
  cache: true,
});

const IKA_COIN_TYPE = `${NETWORK_CONFIG.packages.ikaPackage}::ika::IKA`;

async function findCoin(coinType, minBalance) {
  let cursor;
  for (;;) {
    const page = await suiClient.getCoins({ owner, coinType, cursor });
    for (const c of page.data) {
      if (BigInt(c.balance) >= minBalance) return c.coinObjectId;
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }
  throw new Error(`no ${coinType} coin with balance >= ${minBalance} at ${owner}`);
}

// matches src/background/ika/pricing.ts. takes the max across ALL pricing entries
// (any curve, any protocol step) so a single coin split covers whichever specific
// protocol step the move call ends up doing. coins are passed by `&mut`, so excess
// stays in the coin - over-provisioning is safe, under-provisioning aborts with
// code 1 (ika) or 2 (sui) in sessions_manager::initiate_user_session.
async function getRequiredCoinAmounts() {
  const { coordinatorInner } = await ikaClient.ensureInitialized();
  const entries = coordinatorInner.pricing_and_fee_manager.current.pricing_map.contents;
  let maxIka = 0n;
  let maxSui = 0n;
  for (const e of entries) {
    const feeIka = BigInt(e.value.fee_ika);
    const gasSui =
      BigInt(e.value.gas_fee_reimbursement_sui) +
      BigInt(e.value.gas_fee_reimbursement_sui_for_system_calls);
    if (feeIka > maxIka) maxIka = feeIka;
    if (gasSui > maxSui) maxSui = gasSui;
  }
  if (maxIka === 0n && maxSui === 0n) {
    return { ikaAmount: 10_000_000n, suiAmount: 10_000_000n };
  }
  return { ikaAmount: maxIka + maxIka / 10n, suiAmount: maxSui + maxSui / 10n };
}

// SDK enum -> u32 map (from node_modules/@ika.xyz/sdk/dist/esm/client/hash-signature-validation.js
// CURVE_SIGNATURE_HASH_CONFIG). `fromCurveToNumber` is internal to that module so we mirror it
// here for diagnostic logging.
const CURVE_TO_U32 = {
  [Curve.SECP256K1]: 0,
  [Curve.SECP256R1]: 1,
  [Curve.ED25519]: 2,
  [Curve.RISTRETTO]: 3,
};
// per-curve relative numbering, same source. EdDSA on ED25519 is `0` even though the
// global "absolute" number for EdDSA elsewhere is 3 - we use per-curve relative because
// that's what the SDK passes to the Move call and what `support_config.validate_curve_and_signature_algorithm`
// looks up in `supported_curves_to_signature_algorithms_to_hash_schemes[curve]`.
const SIG_ALGO_PER_CURVE_U32 = {
  [SignatureAlgorithm.ECDSASecp256k1]: 0,
  [SignatureAlgorithm.Taproot]: 1,
  [SignatureAlgorithm.ECDSASecp256r1]: 0,
  [SignatureAlgorithm.EdDSA]: 0,
  [SignatureAlgorithm.SchnorrkelSubstrate]: 0,
};

function presignIdFromEvents(events) {
  for (const ev of events ?? []) {
    const typeStr = typeof ev.type === 'string' ? ev.type : '';
    if (!typeStr.includes('Presign')) continue;
    const json = ev.parsedJson;
    if (!json || typeof json !== 'object') continue;
    const eventData = json.event_data;
    if (eventData && typeof eventData === 'object') {
      if (typeof eventData.presign_id === 'string' && eventData.presign_id.startsWith('0x')) {
        return eventData.presign_id;
      }
    }
    if (typeof json.presign_id === 'string' && json.presign_id.startsWith('0x')) {
      return json.presign_id;
    }
  }
  return undefined;
}

async function runOneCurve(label, curveEnum, sigAlgoEnum) {
  console.log(`\n===== ${label} =====`);
  console.log(`  curve enum=${curveEnum} -> u32=${CURVE_TO_U32[curveEnum]}`);
  console.log(`  sigAlgo enum=${sigAlgoEnum} -> u32=${SIG_ALGO_PER_CURVE_U32[sigAlgoEnum]} (per-curve relative)`);

  const networkKey = await ikaClient.getLatestNetworkEncryptionKey();
  console.log(`  networkKey.id=${networkKey.id}`);

  const { ikaAmount, suiAmount } = await getRequiredCoinAmounts();
  console.log(`  required ikaAmount=${ikaAmount}, suiAmount=${suiAmount}`);

  const ikaCoinId = await findCoin(IKA_COIN_TYPE, ikaAmount);
  console.log(`  ikaCoin=${ikaCoinId}`);
  console.log(`  suiCoin=tx.gas (split from auto-selected gas payment)`);

  const tx = new Transaction();
  const ikaTx = new IkaTransaction({ ikaClient, transaction: tx });

  // split sui from tx.gas to match the docs example and avoid needing a separate sui input.
  // splitting 0 is allowed - move just needs the &mut reference. transferring the empty
  // result back to owner keeps the PTB well-formed (no unused values).
  const splitIka = tx.splitCoins(tx.object(ikaCoinId), [ikaAmount]);
  const splitSui = tx.splitCoins(tx.gas, [suiAmount]);

  const presignCap = ikaTx.requestGlobalPresign({
    dwalletNetworkEncryptionKeyId: networkKey.id,
    curve: curveEnum,
    signatureAlgorithm: sigAlgoEnum,
    ikaCoin: splitIka[0],
    suiCoin: splitSui[0],
  });

  // UnverifiedPresignCap has no drop ability - must be transferred (or consumed in same PTB)
  tx.transferObjects([presignCap], owner);
  // split remainders also need to land somewhere
  tx.transferObjects([splitIka[0], splitSui[0]], owner);

  console.log('  submitting PTB...');
  const t0 = Date.now();
  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    options: { showEvents: true, showEffects: true },
  });
  const submitMs = Date.now() - t0;
  console.log(`  PTB committed in ${submitMs}ms, digest=${result.digest}, status=${result.effects?.status?.status}`);

  if (result.effects?.status?.status !== 'success') {
    console.error('  PTB FAILED:', result.effects?.status?.error);
    return { label, status: 'tx-failed', error: result.effects?.status?.error };
  }

  // pull events again via waitForTransaction to make sure the indexer has them
  const full = await suiClient.waitForTransaction({
    digest: result.digest,
    options: { showEvents: true },
  });

  const presignId = presignIdFromEvents(full.events);
  if (!presignId) {
    console.error('  no presign_id found in events. raw events:');
    console.error(JSON.stringify(full.events ?? [], null, 2).slice(0, 2000));
    return { label, status: 'no-presign-id' };
  }
  console.log(`  presignId=${presignId}`);

  // poll for state transitions
  const POLL_TIMEOUT_MS = 120_000;
  const POLL_INTERVAL_MS = 2_000;
  const tPoll0 = Date.now();
  let lastState = '';

  while (Date.now() - tPoll0 < POLL_TIMEOUT_MS) {
    try {
      const presign = await ikaClient.getPresign(presignId);
      const stateKind = presign?.state?.$kind ?? '?';
      if (stateKind !== lastState) {
        console.log(`  +${Date.now() - tPoll0}ms state=${stateKind}`);
        lastState = stateKind;
      }
      if (stateKind === 'Completed') {
        const elapsedMs = Date.now() - tPoll0;
        console.log(`  ✓ ${label}: reached Completed in ${elapsedMs}ms`);
        return { label, status: 'completed', presignId, elapsedMs };
      }
    } catch (e) {
      console.warn(`  poll error: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log(`  ✗ ${label}: TIMEOUT after ${POLL_TIMEOUT_MS}ms, last state=${lastState}`);
  return { label, status: 'timeout', presignId, lastState };
}

async function main() {
  console.log(`signer=${owner}`);
  console.log(`network=mainnet, ikaDwallet2pcMpcPackage=${NETWORK_CONFIG.packages.ikaDwallet2pcMpcPackage}`);

  // print the SDK enum -> u32 values so we can confirm exactly what hits the chain
  console.log('SDK enum values:');
  console.log(`  Curve.SECP256K1=${Curve.SECP256K1}, Curve.ED25519=${Curve.ED25519}`);
  console.log(`  SignatureAlgorithm.ECDSASecp256k1=${SignatureAlgorithm.ECDSASecp256k1}, SignatureAlgorithm.EdDSA=${SignatureAlgorithm.EdDSA}`);

  const results = [];
  results.push(await runOneCurve('SECP256K1 / ECDSASecp256k1', Curve.SECP256K1, SignatureAlgorithm.ECDSASecp256k1));
  results.push(await runOneCurve('ED25519 / EdDSA', Curve.ED25519, SignatureAlgorithm.EdDSA));

  console.log('\n===== SUMMARY =====');
  for (const r of results) console.log(JSON.stringify(r));

  const secpOk = results[0]?.status === 'completed';
  const edOk = results[1]?.status === 'completed';
  if (secpOk && !edOk) {
    console.log('\nDIAGNOSIS: SECP256K1 completes but ED25519 does not under identical conditions.');
    console.log('this isolates the bottleneck to curve-specific processing on the mainnet validator set.');
    console.log('the wallet code, package id, function call, and numbering are all confirmed not at fault.');
  } else if (secpOk && edOk) {
    console.log('\nDIAGNOSIS: both curves completed. ED25519 IS live on mainnet validators.');
    console.log('the chromatika presign timeout must be for a different reason - re-run the original');
    console.log('Jupiter sign and inspect why that specific presign was stuck.');
  } else if (!secpOk && !edOk) {
    console.log('\nDIAGNOSIS: neither curve completed. likely a network-wide outage, or a signer-specific');
    console.log('issue (fee account, indexer lag). re-run later or try a different signer.');
  } else {
    console.log('\nUNEXPECTED: ED25519 completed but SECP256K1 did not. log a bug somewhere.');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
