/**
 * per dWallet Vault custom display names for dWallet object ids.
 * `chromatika_dwallet_names_v1_<vaultId>` → `{ [dwalletId]: name }`
 */
import { VAULT_SCOPED_KEYS } from '@/background/storage';

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.dwalletNames(vaultId);
}

export async function getDwalletDisplayNameMap(vaultId: string): Promise<Record<string, string>> {
  const key = storageKey(vaultId);
  const r = await chrome.storage.local.get(key);
  const raw = r[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  }
  return {};
}

export async function setDwalletDisplayNameForVault(
  vaultId: string,
  dwalletId: string,
  name: string,
): Promise<void> {
  const trimmed = name.trim();
  const map = await getDwalletDisplayNameMap(vaultId);
  if (!trimmed) {
    delete map[dwalletId];
  } else {
    map[dwalletId] = trimmed.slice(0, 64);
  }
  await chrome.storage.local.set({ [storageKey(vaultId)]: map });
}
