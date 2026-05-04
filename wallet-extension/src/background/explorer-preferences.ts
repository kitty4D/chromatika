import { STORAGE_KEYS } from '@/background/storage';
import {
  DEFAULT_EXPLORER_PREFERENCES,
  type ExplorerPreferences,
  type SolanaExplorerPreset,
  type SuiExplorerPreset,
} from '@/config/explorers';

const KEY = STORAGE_KEYS.EXPLORER_PREFERENCES_V1;

function normalizePreset<TPreset extends string>(
  value: unknown,
  allowed: readonly TPreset[],
  fallback: TPreset,
): TPreset {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as TPreset) : fallback;
}

function normalizeTemplate(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalize(value: unknown): ExplorerPreferences {
  const raw = value && typeof value === 'object' ? (value as Partial<ExplorerPreferences>) : {};
  const suiRaw = raw.sui && typeof raw.sui === 'object' ? (raw.sui as Partial<ExplorerPreferences['sui']>) : undefined;
  const solRaw = raw.solana && typeof raw.solana === 'object'
    ? (raw.solana as Partial<ExplorerPreferences['solana']>)
    : undefined;
  return {
    sui: {
      preset: normalizePreset<SuiExplorerPreset>(suiRaw?.preset, ['suiscan', 'suivision', 'custom'], 'suiscan'),
      customTemplate: normalizeTemplate(suiRaw?.customTemplate),
    },
    solana: {
      preset: normalizePreset<SolanaExplorerPreset>(solRaw?.preset, ['solscan', 'solanaExplorer', 'orb', 'custom'], 'solscan'),
      customTemplate: normalizeTemplate(solRaw?.customTemplate),
    },
  };
}

export async function getExplorerPreferences(): Promise<ExplorerPreferences> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([KEY], (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(normalize(result[KEY] ?? DEFAULT_EXPLORER_PREFERENCES));
    });
  });
}

export async function setExplorerPreferences(next: ExplorerPreferences): Promise<void> {
  const normalized = normalize(next);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [KEY]: normalized }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export const EXPLORER_PREFERENCES_STORAGE_KEY = KEY;
