#!/usr/bin/env node
/**
 * read-only status check against mainnet ika. prints:
 *   - current ika epoch + sui epoch (compare to see if ika is keeping up)
 *   - active network encryption key id (compare to what `getLatestNetworkEncryptionKey` returns)
 *   - validator committee size for the active epoch
 *   - any obvious "paused" / inactive flags on the coordinator
 *
 * useful when presigns stay in `Requested` - if ika's epoch hasn't advanced in a while, or
 * the active committee is empty, the off-chain MPC nodes aren't running.
 *
 * usage:
 *   node scripts/ika-status.mjs
 */

import { IkaClient, getNetworkConfig } from '@ika.xyz/sdk';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';

const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('mainnet') });
const NETWORK_CONFIG = getNetworkConfig('mainnet');
const ikaClient = new IkaClient({
  suiClient,
  config: NETWORK_CONFIG,
  cache: true,
});

function safe(obj, ...path) {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

async function main() {
  console.log('network=mainnet');
  console.log(`coordinator id=${NETWORK_CONFIG.objects.ikaDWalletCoordinator.objectID}`);
  console.log(`system id    =${NETWORK_CONFIG.objects.ikaSystemObject.objectID}`);

  // sui side
  const suiEpoch = await suiClient.getLatestSuiSystemState();
  console.log(`\nsui epoch=${suiEpoch.epoch}, epochStart=${new Date(Number(suiEpoch.epochStartTimestampMs)).toISOString()}`);

  // ika side
  const { coordinatorInner, systemInner } = await ikaClient.ensureInitialized();

  // dump useful top-level fields - the SDK type names them like `current_epoch`, `active_committee`, etc.
  // we walk a few likely paths and print whatever is present.
  const ikaEpochCandidates = [
    ['coordinatorInner.current_epoch', safe(coordinatorInner, 'current_epoch')],
    ['coordinatorInner.epoch', safe(coordinatorInner, 'epoch')],
    ['systemInner.epoch', safe(systemInner, 'epoch')],
    ['systemInner.current_epoch', safe(systemInner, 'current_epoch')],
  ];
  console.log('\nika epoch candidates:');
  for (const [path, val] of ikaEpochCandidates) {
    if (val !== undefined) console.log(`  ${path}=${typeof val === 'object' ? JSON.stringify(val) : val}`);
  }

  // active committee size (if any presence of validator info)
  const committee =
    safe(systemInner, 'validator_set', 'active_committee') ??
    safe(systemInner, 'active_committee') ??
    safe(coordinatorInner, 'active_committee');
  if (committee) {
    const members =
      safe(committee, 'members') ?? safe(committee, 'contents') ?? committee;
    if (Array.isArray(members)) {
      console.log(`\nactive_committee members=${members.length}`);
    } else {
      console.log(`\nactive_committee (raw)=${JSON.stringify(committee).slice(0, 300)}`);
    }
  }

  // latest network encryption key
  const latest = await ikaClient.getLatestNetworkEncryptionKey();
  console.log(`\ngetLatestNetworkEncryptionKey:`);
  console.log(`  id=${latest.id}`);
  console.log(`  epoch=${latest.epoch}`);
  console.log(`  networkDKGOutputID=${latest.networkDKGOutputID}`);
  console.log(`  reconfigurationOutputID=${latest.reconfigurationOutputID}`);
  console.log(`  all fields: ${Object.keys(latest).join(', ')}`);
  // also dump the raw on-chain object so we see every persisted field, not just what
  // the SDK type surfaces (the SDK may strip fields it doesn't model).
  const keyObj = await suiClient.getObject({
    id: latest.id,
    options: { showContent: true },
  });
  console.log(`\nencryption key raw on-chain object:`);
  console.log(`  version=${keyObj.data?.version}`);
  console.log(`  previousTransaction=${keyObj.data?.previousTransaction}`);
  if (keyObj.data?.content && 'fields' in keyObj.data.content) {
    console.log(`  fields=${JSON.stringify(keyObj.data.content.fields, null, 2).slice(0, 1500)}`);
  } else {
    console.log(`  content=${JSON.stringify(keyObj.data?.content).slice(0, 1500)}`);
  }

  // also list all keys on the coordinator if accessible
  const networkKeysField =
    safe(coordinatorInner, 'dwallet_network_encryption_keys') ??
    safe(coordinatorInner, 'network_encryption_keys');
  if (networkKeysField) {
    console.log(`\ncoordinator network keys field type=${typeof networkKeysField}`);
    if (networkKeysField.contents && Array.isArray(networkKeysField.contents)) {
      console.log(`  count=${networkKeysField.contents.length}`);
      for (const entry of networkKeysField.contents.slice(0, 10)) {
        console.log(`  entry=${JSON.stringify(entry).slice(0, 200)}`);
      }
    } else {
      console.log(`  raw=${JSON.stringify(networkKeysField).slice(0, 400)}`);
    }
  }

  // top-level paused flags or status
  const paused = {
    paused_curves: safe(coordinatorInner, 'support_config', 'paused_curves'),
    paused_signature_algorithms: safe(
      coordinatorInner, 'support_config', 'paused_signature_algorithms',
    ),
    paused_hash_schemes: safe(coordinatorInner, 'support_config', 'paused_hash_schemes'),
  };
  console.log('\npause flags:');
  for (const [k, v] of Object.entries(paused)) {
    console.log(`  ${k}=${JSON.stringify(v)}`);
  }

  // recent activity proxy: pull the coordinator object's last `previousTransaction`
  const obj = await suiClient.getObject({
    id: NETWORK_CONFIG.objects.ikaDWalletCoordinator.objectID,
    options: { showPreviousTransaction: true, showOwner: true },
  });
  console.log(`\ncoordinator previousTransaction=${obj.data?.previousTransaction}`);
  console.log(`coordinator version=${obj.data?.version}, owner=${JSON.stringify(obj.data?.owner)}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
