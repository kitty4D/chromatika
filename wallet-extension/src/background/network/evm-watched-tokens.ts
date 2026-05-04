/**
 * user-approved ERC-20s from wallet_watchAsset (EIP-747), keyed by chain + wallet + contract.
 * merged into portfolio token fetches in evm-tokens.ts.
 */
import { STORAGE_KEYS } from '@/background/storage';

const STORAGE_KEY = STORAGE_KEYS.EVM_WATCHED_TOKENS_V1;

export type WatchedEvmTokenMeta = {
  contractAddress: string;
  symbol: string;
  decimals: number;
  image?: string;
  addedAt: number;
};

type Store = Record<string, WatchedEvmTokenMeta>;

function rowKey(chainId: number, walletAddress: string, tokenAddress: string): string {
  return `${chainId}:${walletAddress.toLowerCase()}:${tokenAddress.toLowerCase()}`;
}

async function loadStore(): Promise<Store> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[STORAGE_KEY] as Store) ?? {});
    });
  });
}

async function saveStore(store: Store): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function addWatchedEvmToken(
  chainId: number,
  walletAddress: string,
  meta: Omit<WatchedEvmTokenMeta, 'addedAt'>,
): Promise<void> {
  const store = await loadStore();
  const k = rowKey(chainId, walletAddress, meta.contractAddress);
  store[k] = { ...meta, contractAddress: meta.contractAddress, addedAt: Date.now() };
  await saveStore(store);
}

/** tokens the user asked to track for this wallet on this chain (may include zero balance). */
export async function listWatchedEvmTokensForWallet(
  chainId: number,
  walletAddress: string,
): Promise<WatchedEvmTokenMeta[]> {
  const store = await loadStore();
  const prefix = `${chainId}:${walletAddress.toLowerCase()}:`;
  return Object.entries(store)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, v]) => v);
}
