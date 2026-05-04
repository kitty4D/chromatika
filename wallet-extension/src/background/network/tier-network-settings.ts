/**
 * per-dWallet Vault network tiers: **vault** (fee payer / owner reads) vs **dWallet** (signing, dApps, portfolio rails).
 * storage keys follow `chromatika_<domain>_vN_<vaultId>` (see CLAUDE.md). no legacy migration, seed on first unlock only.
 */

import type { ActiveNetworks } from '@/background/network/active-network';
import { setActiveNetworks } from '@/background/network/active-network';
import type { BaseChain } from '@/background/ika/ika-adapter';
import { resolveBuiltinSolanaPreset } from '@/config/networks';
import { VAULT_SCOPED_KEYS } from '@/background/storage';

const VAULT_KEY = (vaultId: string) => VAULT_SCOPED_KEYS.vaultNetworks(vaultId);
const DWALLET_KEY = (vaultId: string) => VAULT_SCOPED_KEYS.dwalletNetworks(vaultId);

export type SolanaConnectionSettings = {
  solNetworkId: string;
  customRpcUrl: string | null;
  /** 0 = no extra priority tip (standard). */
  priorityFeeMicroLamportsPerCu: number;
  commitment: 'processed' | 'confirmed' | 'finalized';
  maxRetries: number;
  skipPreflight: boolean;
};

export type VaultNetworkSettings = {
  /** registry id, e.g. `sui-mainnet`, see `BUILTIN_SUI`. */
  suiNetworkId: string;
  solana: SolanaConnectionSettings;
};

export type DWalletNetworkSettings = {
  evmChainId: number;
  suiNetworkId: string;
  solana: SolanaConnectionSettings;
  aptNetworkId: string;
  btcNetworkId: string;
};

export const DEFAULT_SOLANA_CONNECTION_SETTINGS: SolanaConnectionSettings = {
  solNetworkId: 'sol-devnet',
  customRpcUrl: null,
  priorityFeeMicroLamportsPerCu: 0,
  commitment: 'confirmed',
  maxRetries: 3,
  skipPreflight: false,
};

/** ika on Solana is pre-alpha: same devnet default as Sui-primary vaults */
const DEFAULT_SOLANA_FOR_IKA_SOLANA_VAULT: SolanaConnectionSettings = {
  ...DEFAULT_SOLANA_CONNECTION_SETTINGS,
  solNetworkId: 'sol-devnet',
};

import type { SuiNetworkId } from '@/config/sui';

type SeedVault = { network: SuiNetworkId; baseChain?: BaseChain };

function solanaTierDefaultsForVault(baseChain: BaseChain | undefined): SolanaConnectionSettings {
  return baseChain === 'solana'
    ? { ...DEFAULT_SOLANA_FOR_IKA_SOLANA_VAULT }
    : { ...DEFAULT_SOLANA_CONNECTION_SETTINGS };
}

function defaultVaultNetworkFromRecord(record: SeedVault): VaultNetworkSettings {
  const suiNetworkId = record.network === 'testnet' ? 'sui-testnet' : 'sui-mainnet';
  return {
    suiNetworkId,
    solana: solanaTierDefaultsForVault(record.baseChain),
  };
}

function defaultDwalletNetworkFromRecord(record: SeedVault): DWalletNetworkSettings {
  const suiNetworkId = record.network === 'testnet' ? 'sui-testnet' : 'sui-mainnet';
  return {
    evmChainId: 1,
    suiNetworkId,
    solana: solanaTierDefaultsForVault(record.baseChain),
    aptNetworkId: 'apt-mainnet',
    btcNetworkId: 'btc-mainnet',
  };
}

export { registrySuiIdToSuiNetworkId } from '@/config/sui';

export function resolveSolanaRpcUrl(sol: SolanaConnectionSettings): string {
  if (sol.customRpcUrl && /^https?:\/\//i.test(sol.customRpcUrl.trim())) {
    return sol.customRpcUrl.trim();
  }
  return resolveBuiltinSolanaPreset(sol.solNetworkId).rpcUrl;
}

function mergeSolana(
  base: SolanaConnectionSettings,
  patch: Partial<SolanaConnectionSettings> | undefined,
): SolanaConnectionSettings {
  if (!patch) return { ...base };
  return { ...base, ...patch };
}

export async function getVaultNetworkSettings(
  vaultId: string,
  fallbackSeed?: SeedVault,
): Promise<VaultNetworkSettings> {
  const key = VAULT_KEY(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        const raw = r[key] as Partial<VaultNetworkSettings> | undefined;
        if (!raw || typeof raw !== 'object') {
          if (fallbackSeed) resolve(defaultVaultNetworkFromRecord(fallbackSeed));
          else reject(new Error('Vault network settings missing — unlock wallet to seed defaults'));
          return;
        }
        resolve({
          suiNetworkId: typeof raw.suiNetworkId === 'string' ? raw.suiNetworkId : 'sui-mainnet',
          solana: mergeSolana(solanaTierDefaultsForVault(fallbackSeed?.baseChain), raw.solana),
        });
      }
    });
  });
}

export async function setVaultNetworkSettings(
  vaultId: string,
  patch: Partial<Omit<VaultNetworkSettings, 'solana'>> & { solana?: Partial<SolanaConnectionSettings> },
): Promise<VaultNetworkSettings> {
  const base = await getVaultNetworkSettings(vaultId, { network: 'mainnet' });
  const next: VaultNetworkSettings = {
    suiNetworkId: patch.suiNetworkId ?? base.suiNetworkId,
    solana: mergeSolana(base.solana, patch.solana),
  };
  const key = VAULT_KEY(vaultId);
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [key]: next }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  return next;
}

export async function getDwalletNetworkSettings(
  vaultId: string,
  fallbackSeed?: SeedVault,
): Promise<DWalletNetworkSettings> {
  const key = DWALLET_KEY(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([key], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else {
        const raw = r[key] as Partial<DWalletNetworkSettings> | undefined;
        if (!raw || typeof raw !== 'object') {
          if (fallbackSeed) resolve(defaultDwalletNetworkFromRecord(fallbackSeed));
          else reject(new Error('dWallet network settings missing — unlock wallet to seed defaults'));
          return;
        }
        resolve({
          evmChainId: typeof raw.evmChainId === 'number' ? raw.evmChainId : 1,
          suiNetworkId: typeof raw.suiNetworkId === 'string' ? raw.suiNetworkId : 'sui-mainnet',
          solana: mergeSolana(solanaTierDefaultsForVault(fallbackSeed?.baseChain), raw.solana),
          aptNetworkId: typeof raw.aptNetworkId === 'string' ? raw.aptNetworkId : 'apt-mainnet',
          btcNetworkId: typeof raw.btcNetworkId === 'string' ? raw.btcNetworkId : 'btc-mainnet',
        });
      }
    });
  });
}

export async function setDwalletNetworkSettings(
  vaultId: string,
  patch: Partial<Omit<DWalletNetworkSettings, 'solana'>> & { solana?: Partial<SolanaConnectionSettings> },
): Promise<DWalletNetworkSettings> {
  const base = await getDwalletNetworkSettings(vaultId, { network: 'mainnet' });
  const next: DWalletNetworkSettings = {
    evmChainId: patch.evmChainId ?? base.evmChainId,
    suiNetworkId: patch.suiNetworkId ?? base.suiNetworkId,
    solana: mergeSolana(base.solana, patch.solana),
    aptNetworkId: patch.aptNetworkId ?? base.aptNetworkId,
    btcNetworkId: patch.btcNetworkId ?? base.btcNetworkId,
  };
  const key = DWALLET_KEY(vaultId);
  await new Promise<void>((resolve, reject) => {
    chrome.storage.local.set({ [key]: next }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  await syncLegacyActiveNetworksFromDwallet(next);
  return next;
}

/** keep `chromatika_active_networks_v1` aligned with dWallet tier for locked UI + legacy call sites. */
export async function syncLegacyActiveNetworksFromDwallet(d: DWalletNetworkSettings): Promise<ActiveNetworks> {
  const active: ActiveNetworks = {
    evmChainId: d.evmChainId,
    suiNetworkId: d.suiNetworkId,
    solNetworkId: d.solana.solNetworkId,
    aptNetworkId: d.aptNetworkId,
    btcNetworkId: d.btcNetworkId,
  };
  await setActiveNetworks(active);
  return active;
}

export function dwalletSettingsToActiveNetworks(d: DWalletNetworkSettings): ActiveNetworks {
  return {
    evmChainId: d.evmChainId,
    suiNetworkId: d.suiNetworkId,
    solNetworkId: d.solana.solNetworkId,
    aptNetworkId: d.aptNetworkId,
    btcNetworkId: d.btcNetworkId,
  };
}

/**
 * seed per-vault keys from vault record defaults (no read of `chromatika_active_networks_v1`).
 * call during unlock before building session.
 */
export async function ensureTierNetworkSettingsForVault(record: SeedVault & { id: string }): Promise<void> {
  const vaultId = record.id;
  const vKey = VAULT_KEY(vaultId);
  const dKey = DWALLET_KEY(vaultId);
  const raw = await new Promise<Record<string, unknown>>((resolve, reject) => {
    chrome.storage.local.get([vKey, dKey], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r as Record<string, unknown>);
    });
  });
  const tasks: Promise<void>[] = [];
  if (raw[vKey] == null) {
    tasks.push(
      new Promise((resolve, reject) => {
        chrome.storage.local.set({ [vKey]: defaultVaultNetworkFromRecord(record) }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      }),
    );
  }
  if (raw[dKey] == null) {
    const dDefault = defaultDwalletNetworkFromRecord(record);
    tasks.push(
      new Promise((resolve, reject) => {
        chrome.storage.local.set({ [dKey]: dDefault }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      }),
    );
  }
  await Promise.all(tasks);
  if (raw[dKey] == null) {
    const dDefault = defaultDwalletNetworkFromRecord(record);
    await syncLegacyActiveNetworksFromDwallet(dDefault);
  }
}

/**
 * pre-release: Solana ika vaults defaulted to public mainnet RPC (403 from extensions).
 * move built-in mainnet -> devnet when user has no custom Solana RPC.
 */
export async function normalizeSolanaIkaVaultNetworksIfNeeded(
  record: SeedVault & { id: string; baseChain: BaseChain },
): Promise<void> {
  if (record.baseChain !== 'solana') return;
  const seed = { network: record.network, baseChain: record.baseChain };
  const [v, d] = await Promise.all([
    getVaultNetworkSettings(record.id, seed),
    getDwalletNetworkSettings(record.id, seed),
  ]);
  const stuckOnPublicMainnet = (s: SolanaConnectionSettings) =>
    s.solNetworkId === 'sol-mainnet' && !s.customRpcUrl?.trim();
  if (stuckOnPublicMainnet(v.solana)) {
    await setVaultNetworkSettings(record.id, { solana: { solNetworkId: 'sol-devnet' } });
  }
  if (stuckOnPublicMainnet(d.solana)) {
    await setDwalletNetworkSettings(record.id, { solana: { solNetworkId: 'sol-devnet' } });
  }
}
