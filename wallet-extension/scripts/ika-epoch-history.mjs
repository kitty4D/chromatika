#!/usr/bin/env node
/**
 * walk recent transactions that mutated the ika system object, find epoch transitions,
 * and print "epoch X started at timestamp T". useful to answer "was ika at the same
 * epoch 24h ago, or has it been advancing?"
 *
 * usage:
 *   node scripts/ika-epoch-history.mjs
 */

import { getNetworkConfig } from '@ika.xyz/sdk';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
const NETWORK_CONFIG = getNetworkConfig('mainnet');

const SYSTEM_OBJ = NETWORK_CONFIG.objects.ikaSystemObject.objectID;
const COORD_OBJ = NETWORK_CONFIG.objects.ikaDWalletCoordinator.objectID;

function fmtTimestamp(ms) {
  return new Date(Number(ms)).toISOString();
}

function hoursAgo(ms) {
  return ((Date.now() - Number(ms)) / 3600_000).toFixed(1);
}

async function getEpochAtVersion(objectId, version) {
  try {
    const past = await suiClient.tryGetPastObject({
      id: objectId,
      version,
      options: { showContent: true },
    });
    if (past.status !== 'VersionFound') return null;
    const fields = past.details?.content?.fields;
    if (!fields) return null;
    // ika system object stores `inner` -> system_inner with `epoch`
    const innerEpoch =
      fields?.inner?.fields?.epoch ??
      fields?.value?.fields?.epoch ??
      fields?.epoch;
    return innerEpoch ?? null;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`system object: ${SYSTEM_OBJ}`);
  console.log(`coordinator:   ${COORD_OBJ}`);
  console.log(`packages: ikaSystem=${NETWORK_CONFIG.packages.ikaSystemPackage}`);
  console.log(`          ikaSystemOriginal=${NETWORK_CONFIG.packages.ikaSystemOriginalPackage}\n`);

  const sui = await suiClient.getLatestSuiSystemState();
  console.log(
    `sui epoch=${sui.epoch}, current sui epoch started ${fmtTimestamp(sui.epochStartTimestampMs)} (${hoursAgo(sui.epochStartTimestampMs)}h ago)\n`,
  );

  // approach 1: query events from the ika system package (original + upgraded) for any
  // epoch-transition flavor. dump types we see so we can identify the right event name.
  console.log('-- events from ikaSystemPackage (most recent) --');
  let allEvents = [];
  for (const pkg of [
    NETWORK_CONFIG.packages.ikaSystemPackage,
    NETWORK_CONFIG.packages.ikaSystemOriginalPackage,
  ]) {
    try {
      const page = await suiClient.queryEvents({
        query: { MoveEventModule: { package: pkg, module: 'system_inner' } },
        limit: 50,
        order: 'descending',
      });
      console.log(`  ${pkg}: ${page.data?.length ?? 0} events`);
      for (const ev of page.data ?? []) {
        allEvents.push(ev);
      }
    } catch (e) {
      console.log(`  ${pkg}: error ${e.message}`);
    }
  }

  // dedupe by tx digest+id
  const seenEvKey = new Set();
  allEvents = allEvents.filter((e) => {
    const k = `${e.id?.txDigest}:${e.id?.eventSeq}`;
    if (seenEvKey.has(k)) return false;
    seenEvKey.add(k);
    return true;
  });
  allEvents.sort((a, b) => Number(b.timestampMs ?? 0) - Number(a.timestampMs ?? 0));

  // group by event type
  const byType = new Map();
  for (const ev of allEvents) {
    const t = ev.type ?? 'unknown';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(ev);
  }
  console.log(`\n-- event type breakdown --`);
  for (const [t, list] of byType.entries()) {
    console.log(`  ${list.length}x ${t}`);
  }

  // for each event type, print the most recent occurrence
  console.log(`\n-- most recent occurrence of each event type --`);
  for (const [t, list] of byType.entries()) {
    const ev = list[0];
    const ts = Number(ev.timestampMs ?? 0);
    console.log(`  ${t}`);
    console.log(`    ts=${fmtTimestamp(ts)} (${hoursAgo(ts)}h ago) digest=${ev.id?.txDigest}`);
    console.log(`    parsedJson=${JSON.stringify(ev.parsedJson).slice(0, 300)}`);
  }

  // also try filtering on common epoch-related event names
  console.log(`\n-- searching for epoch-related events specifically --`);
  for (const t of byType.keys()) {
    if (!/epoch|reconfig/i.test(t)) continue;
    const list = byType.get(t);
    console.log(`\n  ${t} (${list.length} events):`);
    for (const ev of list.slice(0, 10)) {
      const ts = Number(ev.timestampMs ?? 0);
      const epoch =
        ev.parsedJson?.epoch ??
        ev.parsedJson?.new_epoch ??
        ev.parsedJson?.advance_to ??
        '?';
      console.log(`    epoch=${epoch} at ${fmtTimestamp(ts)} (${hoursAgo(ts)}h ago)`);
    }
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
