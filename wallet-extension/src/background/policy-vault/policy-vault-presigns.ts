/**
 * local tracker for the policy vault's presign cap object ids.
 *
 * the Move side stores `presigns: vector<UnverifiedPresignCap>` and pops with `pop_back`
 * (LIFO). to compute `messageCentralizedSignature` client-side via
 * `createUserSignMessageWithPublicOutput`, chromatika needs the actual presign BYTES, which
 * come from looking up the presign object referenced inside an `UnverifiedPresignCap`.
 *
 * this tracker keeps the cap-object-id queue in sync with the on-chain vector. two write
 * paths:
 *   - `appendPolicyPresignCapId` fires after a successful `replenish_presign` PTB; chromatika
 *     re-reads the vault and captures the LAST cap id (matches Move's `push_back`).
 *   - `popPolicyPresignCapId` fires before signing; pops the LAST id (matches Move's `pop_back`
 *     consumed by the same tx).
 *
 * if the local cache and on-chain state ever drift (e.g. chromatika reinstall, lost storage),
 * `resyncPolicyPresignsFromChain` reads the vault and replaces the local cache wholesale.
 *
 * storage shape: `chromatika_policy_presigns_v1_<vaultId>` -> `string[]`. empty array =
 * empty pool. cleared on `clearLocalPolicyVaultLink`.
 */

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { VAULT_SCOPED_KEYS } from '@/background/storage';

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.policyPresigns(vaultId);
}

async function read(vaultId: string): Promise<string[]> {
  const key = storageKey(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      const v = r[key];
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) resolve(v as string[]);
      else resolve([]);
    });
  });
}

async function write(vaultId: string, ids: string[]): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: ids }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function listPolicyPresignCapIds(vaultId: string): Promise<string[]> {
  return read(vaultId);
}

export async function appendPolicyPresignCapId(vaultId: string, capObjectId: string): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(capObjectId)) {
    throw new Error('capObjectId must be a 0x-prefixed 32-byte hex Sui object id');
  }
  const ids = await read(vaultId);
  if (!ids.includes(capObjectId)) {
    ids.push(capObjectId);
    await write(vaultId, ids);
  }
}

/** pop the LAST id (matches Move's `pop_back`). returns null when empty. */
export async function popPolicyPresignCapId(vaultId: string): Promise<string | null> {
  const ids = await read(vaultId);
  if (ids.length === 0) return null;
  const last = ids.pop()!;
  await write(vaultId, ids);
  return last;
}

/** push back without dedup (used by re-sync). */
async function setAll(vaultId: string, ids: string[]): Promise<void> {
  await write(vaultId, ids);
}

export async function clearPolicyPresignIds(vaultId: string): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/**
 * re-sync the local cache from the on-chain vault. reads the vault's `presigns` vector and
 * extracts each entry's `id.id` (the cap's object id). order matches Move's vector layout
 * (front-to-back), so `pop_back` -> last element matches `popPolicyPresignCapId` -> last.
 *
 * used as recovery when the local cache is empty / stale and we KNOW the on-chain pool has
 * presigns. returns the count.
 */
export async function resyncPolicyPresignsFromChain(
  client: SuiGraphQLClient,
  vaultId: string,
  vaultObjectId: string,
): Promise<number> {
  type RespShape = {
    objects?: Array<{
      content?: { fields?: { presigns?: unknown } } | { presigns?: unknown };
    }>;
  };
  let response: RespShape | null = null;
  try {
    const raw = await (client.core as unknown as {
      getObjects: (opts: { objectIds: string[] }) => Promise<unknown>;
    }).getObjects({ objectIds: [vaultObjectId] });
    response = raw as RespShape;
  } catch (e) {
    console.warn('[chromatika policy-presigns] resync getObjects failed:', e);
    return 0;
  }
  const obj = response?.objects?.[0];
  if (!obj?.content) return 0;
  const fieldsRoot = (obj.content as { fields?: Record<string, unknown> }).fields;
  const fields = fieldsRoot ?? (obj.content as Record<string, unknown>);
  const presigns = fields?.presigns;
  const capIds: string[] = [];
  if (Array.isArray(presigns)) {
    for (const entry of presigns) {
      if (entry && typeof entry === 'object') {
        const e = entry as Record<string, unknown>;
        // two plausible shapes from Mysten's GraphQL parsed-content layer:
        //   { id: { id: '0x...' }, presign_id: '0x...' }
        //   { fields: { id: { id: '0x...' }, presign_id: '0x...' } }
        const inner = e.fields && typeof e.fields === 'object' ? (e.fields as Record<string, unknown>) : e;
        const idField = inner.id;
        if (idField && typeof idField === 'object') {
          const idStr = (idField as { id?: unknown }).id;
          if (typeof idStr === 'string' && /^0x[0-9a-fA-F]{64}$/.test(idStr)) {
            capIds.push(idStr);
          }
        }
      }
    }
  }
  await setAll(vaultId, capIds);
  return capIds.length;
}

/** convenience: get the LAST cap id (the next one Move would pop) without removing it. */
export async function peekNextPolicyPresignCapId(vaultId: string): Promise<string | null> {
  const ids = await read(vaultId);
  return ids.length > 0 ? ids[ids.length - 1]! : null;
}
