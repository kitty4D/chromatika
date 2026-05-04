/**
 * persists hardware accounts (address + derivation path) in chrome.storage.local.
 * these are display-only records; private keys never leave the device.
 */

import { STORAGE_KEYS } from '@/background/storage';
import type { HardwareAccount } from './types';

const KEY = STORAGE_KEYS.HARDWARE_ACCOUNTS_V1;

async function load(): Promise<HardwareAccount[]> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[KEY] as HardwareAccount[]) ?? []);
    });
  });
}

async function persist(accounts: HardwareAccount[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: accounts }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getHardwareAccounts(): Promise<HardwareAccount[]> {
  return load();
}

export async function addHardwareAccount(account: Omit<HardwareAccount, 'id' | 'addedAtMs'>): Promise<HardwareAccount> {
  const accounts = await load();
  // dedup by address
  const existing = accounts.find((a) => a.address.toLowerCase() === account.address.toLowerCase());
  if (existing) return existing;
  const next: HardwareAccount = {
    ...account,
    id: `${account.vendor}-${Date.now()}`,
    addedAtMs: Date.now(),
  };
  accounts.push(next);
  await persist(accounts);
  return next;
}

/** match a connected Ledger EVM account by checksummed or lowercase hex address. */
export async function findLedgerEvmAccount(address: string): Promise<HardwareAccount | null> {
  const list = await getHardwareAccounts();
  const want = address.trim().toLowerCase();
  return (
    list.find((a) => a.vendor === 'ledger' && a.chain === 'evm' && a.address.toLowerCase() === want) ??
    null
  );
}

export async function removeHardwareAccount(id: string): Promise<void> {
  const accounts = await load();
  await persist(accounts.filter((a) => a.id !== id));
}

export async function getHardwareAccountById(id: string): Promise<HardwareAccount | null> {
  const accounts = await load();
  return accounts.find((a) => a.id === id) ?? null;
}
