/**
 * signed-tx record store. persists local metadata about every tx chromatika signs and
 * broadcasts (or signs as a message), keyed by tx hash, scoped per dWallet Vault.
 *
 * why this exists: chromatika's activity service (`./activity.ts`) is read-only: it pulls from
 * external explorers (Sui GraphQL, Blockscout, Solana RPC, Esplora) and merges. it has no idea
 * which dapp triggered which tx, so when a user gets phished, they can't see "tx 0xabcd was
 * signed via evilsite.io" by looking at the activity feed. capturing the dapp origin URL at
 * sign time and merging it into the activity feed is the prerequisite for drain analysis,
 * proactive sim warnings, and the safety-broadcast flywheel (see
 * `wallet-extension/docs/future/SAFETY_RESCUE_BRAINSTORM.md`).
 *
 * design choices:
 * - storage key: `chromatika_signed_txs_v1` in `chrome.storage.local`. per-vault scoped at the
 *   top level (`{ [vaultId]: SignedTxRecord[] }`), same convention as `dwallet_meta_v2_<vaultId>`.
 * - cap at 500 records per vault, FIFO rotation. avoids unbounded growth on long-running
 *   installs while keeping enough history for drain analysis.
 * - origin can be `null` for wallet-ui-initiated sends (no dapp involved), which is meaningful
 *   distinct state from "we forgot to record it".
 * - encrypted notes attach via `EncryptedRef` (see `../encryption/types.ts`). the store is
 *   backend-agnostic; the activity-notes router decides which backend to use.
 *
 * pre-release: per CLAUDE.md, no migrations needed. v1 is a fresh key.
 */

import { STORAGE_KEYS } from '@/background/storage';
import type { EncryptedRef } from '@/background/encryption/types';

const STORAGE_KEY = STORAGE_KEYS.SIGNED_TXS_V1;
const MAX_RECORDS_PER_VAULT = 500;

/** discriminator for the kind of signed action. used by drain analysis to distinguish tx vs message sigs. */
export type SignedTxKind =
  | 'evm-send'
  | 'evm-message-sign'
  | 'evm-typed-data'
  | 'sui-send'
  | 'sui-message-sign'
  | 'sol-send'
  | 'sol-message-sign'
  | 'sol-tx-sign'
  | 'btc-send'
  | 'apt-send'
  /** PC-Token wrap (SPL -> pcSPL). plaintext SPL leg visible; only post-wrap balance hidden. */
  | 'pc-wrap'
  /** PC-Token confidential transfer. amount + recipient pcToken account hidden; sender visible. */
  | 'pc-transfer-hidden'
  /** PC-Token unwrap step (one of: burn, decrypt, complete). UI activity row groups by tx hash. */
  | 'pc-unwrap'
  /** native DESO transfer via /api/v0/send-deso -> ika SECP sign -> /api/v0/submit-transaction. */
  | 'deso-send'
  /** DeSo post (text + optional media) via /api/v0/submit-post. */
  | 'deso-post';

export type SignedTxChainId = number | string;

export interface SignedTxRecord {
  /**
   * stable id for this signed action. EVM tx hash, Sui digest, Solana signature, BTC txid, etc.
   * matches `ActivityItem.digest` so the activity merge can join on this.
   */
  txHash: string;
  /**
   * dapp origin URL when signed via the dapp-bridge approval flow. `null` for wallet-ui sends
   * (where the user is in chromatika UI making an intentional action, no dapp involvement).
   */
  origin: string | null;
  /** EVM chain id (number) or chain registry id ('sui-mainnet', 'sol-devnet', 'btc-mainnet', etc.). */
  chainId: SignedTxChainId;
  /** vault that signed this. records are stored under their vault. */
  vaultId: string;
  /** local clock at sign time. authoritative ordering field for the records list. */
  timestampMs: number;
  /** action kind (see `SignedTxKind`). */
  kind: SignedTxKind;
  /**
   * optional encrypted note attached by the user via the activity-notes flow. backend-tagged
   * envelope reference; decrypt routes through the encryption registry.
   */
  encryptedNote?: EncryptedRef;
}

interface StoreShape {
  [vaultId: string]: SignedTxRecord[];
}

async function readStore(): Promise<StoreShape> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = r[STORAGE_KEY];
      if (v && typeof v === 'object') {
        resolve(v as StoreShape);
      } else {
        resolve({});
      }
    });
  });
}

async function writeStore(store: StoreShape): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: store }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * persist a signed-tx record. called from chain send paths immediately after broadcast (or
 * after a message-sign returns successfully). idempotent on `txHash`: re-recording the same
 * hash overwrites the earlier entry rather than duplicating.
 *
 * MUST NOT throw on storage errors: signing/broadcasting already succeeded by the time we get
 * here, and we never want a storage hiccup to look like a failed broadcast to the caller. logs
 * to console and returns. the activity feed will still show the tx via the explorer fetch, just
 * without the origin badge.
 */
export async function recordSignedTx(rec: SignedTxRecord): Promise<void> {
  try {
    const store = await readStore();
    const existing = store[rec.vaultId] ?? [];
    const filtered = existing.filter((r) => r.txHash !== rec.txHash);
    filtered.push(rec);
    // FIFO cap: drop the oldest records by timestamp once we exceed the per-vault cap.
    if (filtered.length > MAX_RECORDS_PER_VAULT) {
      filtered.sort((a, b) => a.timestampMs - b.timestampMs);
      filtered.splice(0, filtered.length - MAX_RECORDS_PER_VAULT);
    }
    store[rec.vaultId] = filtered;
    await writeStore(store);
  } catch (e) {
    console.warn('[chromatika tx-record] failed to persist signed tx', rec.txHash, e);
  }
}

/** get one record by tx hash within a specific vault. returns null if not found. */
export async function getSignedTxByHash(
  txHash: string,
  vaultId: string,
): Promise<SignedTxRecord | null> {
  const store = await readStore();
  const list = store[vaultId] ?? [];
  return list.find((r) => r.txHash === txHash) ?? null;
}

export interface ListSignedTxsOptions {
  vaultId: string;
  /** cap the result. default 500 (same as the per-vault storage cap). */
  limit?: number;
  /** filter to a specific chain id. otherwise returns all chains. */
  chainFilter?: SignedTxChainId;
}

/** list records for a vault, newest first. */
export async function listSignedTxs(opts: ListSignedTxsOptions): Promise<SignedTxRecord[]> {
  const store = await readStore();
  let list = store[opts.vaultId] ?? [];
  if (opts.chainFilter !== undefined) {
    list = list.filter((r) => r.chainId === opts.chainFilter);
  }
  list = [...list].sort((a, b) => b.timestampMs - a.timestampMs);
  if (opts.limit && list.length > opts.limit) {
    list = list.slice(0, opts.limit);
  }
  return list;
}

/**
 * update the encrypted note on an existing record. pass `note: undefined` to clear it. throws
 * if the record doesn't exist (caller must record the tx first via `recordSignedTx`).
 */
export async function updateSignedTxNote(
  txHash: string,
  vaultId: string,
  note: EncryptedRef | undefined,
): Promise<void> {
  const store = await readStore();
  const list = store[vaultId] ?? [];
  const idx = list.findIndex((r) => r.txHash === txHash);
  if (idx === -1) {
    throw new Error(
      `tx ${txHash} not found in vault ${vaultId} - record the tx via recordSignedTx first`,
    );
  }
  const updated = { ...list[idx]! };
  if (note === undefined) {
    delete updated.encryptedNote;
  } else {
    updated.encryptedNote = note;
  }
  list[idx] = updated;
  store[vaultId] = list;
  await writeStore(store);
}

/**
 * build a fast `Map<txHash, SignedTxRecord>` for the active vault, used by the activity service
 * to overlay origin + note presence onto explorer-sourced rows.
 */
export async function getSignedTxsMap(vaultId: string): Promise<Map<string, SignedTxRecord>> {
  const store = await readStore();
  const list = store[vaultId] ?? [];
  const m = new Map<string, SignedTxRecord>();
  for (const r of list) {
    m.set(r.txHash, r);
  }
  return m;
}

/** drop ALL records for a vault. used by the panic flow (future) and dev cleanup. */
export async function clearSignedTxsForVault(vaultId: string): Promise<void> {
  const store = await readStore();
  if (store[vaultId]) {
    delete store[vaultId];
    await writeStore(store);
  }
}
