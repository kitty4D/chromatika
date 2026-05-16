/**
 * global address book for the Send tab. one chrome.storage.local key holds the full list across
 * every vault: addresses are public info, no reason to lock them behind the vault password, and
 * a global book matches user expectation ("my Alice address works regardless of which vault I'm
 * sending from").
 *
 * entries are chain-scoped because address formats overlap across chains in ways that would
 * break "send to Alice"-style copy if we tried to be smart about it (a Sui object id is "0x" +
 * 64 hex, same prefix as an EVM address but different length; some Bitcoin and Sui addresses
 * coexist with totally different validators). the Send tab filters the dropdown to whichever
 * chain the user's selected token lives on.
 */

import { isAddress as isEvmAddress } from 'ethers';
import { PublicKey } from '@solana/web3.js';
import { STORAGE_KEYS } from '@/background/storage';

const STORAGE_KEY = STORAGE_KEYS.ADDRESS_BOOK_V1;

export type AddressBookChain = 'evm' | 'sui' | 'solana' | 'btc' | 'aptos';

export type AddressBookEntry = {
  id: string;
  name: string;
  address: string;
  chain: AddressBookChain;
  addedAtMs: number;
};

type Store = { entries: AddressBookEntry[] };

async function loadStore(): Promise<Store> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const raw = r[STORAGE_KEY] as Store | undefined;
      resolve(raw && Array.isArray(raw.entries) ? raw : { entries: [] });
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

/** per-chain format check. throws with a friendly message when the address is malformed. */
export function validateAddressForChain(address: string, chain: AddressBookChain): void {
  const a = address.trim();
  if (!a) throw new Error('Address is required');
  switch (chain) {
    case 'evm':
      if (!isEvmAddress(a)) throw new Error('Not a valid EVM address (expected 0x + 40 hex chars)');
      return;
    case 'sui': {
      const ok = /^0x[0-9a-fA-F]{64}$/.test(a);
      if (!ok) throw new Error('Not a valid Sui address (expected 0x + 64 hex chars)');
      return;
    }
    case 'solana': {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        new PublicKey(a);
      } catch {
        throw new Error('Not a valid Solana address');
      }
      return;
    }
    case 'btc': {
      // lightweight check to avoid pulling bitcoinjs-lib into address-book paths.
      // bech32/SegWit: bc1... / tb1..., legacy/P2SH: 1.../3..., taproot uses bc1p...
      const ok = /^(bc1|tb1|[13])[0-9A-Za-z]{20,87}$/.test(a);
      if (!ok) throw new Error('Not a valid Bitcoin address');
      return;
    }
    case 'aptos': {
      const ok = /^0x[0-9a-fA-F]{1,64}$/.test(a);
      if (!ok) throw new Error('Not a valid Aptos address (expected 0x + up to 64 hex chars)');
      return;
    }
    default: {
      const _exhaustive: never = chain;
      throw new Error(`Unknown chain: ${String(_exhaustive)}`);
    }
  }
}

export function isValidAddressForChain(address: string, chain: AddressBookChain): boolean {
  try {
    validateAddressForChain(address, chain);
    return true;
  } catch {
    return false;
  }
}

export async function listAddressBook(): Promise<AddressBookEntry[]> {
  const store = await loadStore();
  return [...store.entries].sort((a, b) => {
    if (a.chain !== b.chain) return a.chain.localeCompare(b.chain);
    return a.name.localeCompare(b.name);
  });
}

function newId(): string {
  return `ab_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

export async function addAddressBookEntry(
  input: { name: string; address: string; chain: AddressBookChain },
): Promise<AddressBookEntry> {
  const name = input.name.trim();
  const address = input.address.trim();
  if (!name) throw new Error('Name is required');
  if (name.length > 64) throw new Error('Name must be 64 characters or fewer');
  validateAddressForChain(address, input.chain);

  const store = await loadStore();
  const dup = store.entries.find(
    (e) => e.chain === input.chain && e.address.toLowerCase() === address.toLowerCase(),
  );
  if (dup) {
    throw new Error(`Address already in book as "${dup.name}"`);
  }
  const entry: AddressBookEntry = {
    id: newId(),
    name,
    address,
    chain: input.chain,
    addedAtMs: Date.now(),
  };
  store.entries.push(entry);
  await saveStore(store);
  return entry;
}

export async function removeAddressBookEntry(id: string): Promise<void> {
  const store = await loadStore();
  store.entries = store.entries.filter((e) => e.id !== id);
  await saveStore(store);
}

export async function renameAddressBookEntry(id: string, name: string): Promise<AddressBookEntry> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Name is required');
  if (trimmed.length > 64) throw new Error('Name must be 64 characters or fewer');
  const store = await loadStore();
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error('Address book entry not found');
  e.name = trimmed;
  await saveStore(store);
  return e;
}
