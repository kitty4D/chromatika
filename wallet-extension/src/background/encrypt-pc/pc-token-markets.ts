/**
 * PC-Token market registry. a "market" is the tuple
 * `(splMint, programId, mintAuthority?, network)` that defines one isolated PC-Token deployment.
 *
 * why a registry (vs a single program ID): two chromatika installs that share encrypted balances
 * via `pcTokenTransferHidden` must agree on BOTH the deployed PC-Token program AND the mint
 * authority. by treating each `(splMint, programId)` pair as a discrete market, a user can
 * participate in multiple deployments (e.g. `pcUSDC` and `pcUSDC-friends-group`) from the same
 * vault simply by adding a second registry entry.
 *
 * storage:
 *   - chrome.storage.local key: `chromatika_pc_token_markets_v1`
 *   - shape: `{ markets: PcTokenMarket[]; activeMarketId: string | null }`
 *   - first add becomes active automatically; removing the active market rolls activeMarketId to
 *     the next entry (or null if empty).
 *
 * pre-release: no migration from the legacy `chromatika_pc_token_program_v1` key - that storage
 * is ignored and users re-add their program ID once when this ships.
 */

import { PublicKey } from '@solana/web3.js';
import { STORAGE_KEYS } from '@/background/storage';

export interface PcTokenMarket {
  /** stable user-facing id, e.g. "pcUSDC" or "pcUSDC-friends" */
  id: string;
  /** displayed in UI, e.g. "pcUSDC (friends group)" */
  label: string;
  /** base58 - the underlying SPL mint that gets wrapped */
  splMint: string;
  /** symbol for UI rendering, e.g. "USDC" */
  splSymbol: string;
  /** decimals for amount formatting */
  splDecimals: number;
  /** base58 - the deployed PC-Token program */
  programId: string;
  /**
   * optional mint authority override; defaults to active dWallet ed25519 when null. sharing a
   * market across installs requires both sides agree on this value.
   */
  mintAuthorityB58?: string;
  /** which solana network this market lives on */
  network: 'sol-devnet' | 'sol-mainnet';
  /** true for shipped defaults (none in v0); false for user-added entries */
  builtin: boolean;
  createdAtMs: number;
}

export interface PcTokenRegistry {
  markets: PcTokenMarket[];
  activeMarketId: string | null;
}

const STORAGE_KEY = STORAGE_KEYS.PC_TOKEN_MARKETS_V1;

let _runtimeRegistry: PcTokenRegistry | null = null;

function emptyRegistry(): PcTokenRegistry {
  return { markets: [], activeMarketId: null };
}

function isValidBase58Pubkey(value: string): boolean {
  try {
    const pk = new PublicKey(value);
    return pk.toBase58() === value;
  } catch {
    return false;
  }
}

function isValidMarketId(id: string): boolean {
  // user-facing slug; allow alphanumerics + dashes/underscores; reasonable length
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id);
}

async function readStored(): Promise<PcTokenRegistry> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (r) => {
      const v = r[STORAGE_KEY];
      if (!v || typeof v !== 'object' || !Array.isArray((v as PcTokenRegistry).markets)) {
        resolve(emptyRegistry());
        return;
      }
      resolve(v as PcTokenRegistry);
    });
  });
}

async function writeStored(reg: PcTokenRegistry): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY]: reg }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** idempotent - call from SW startup AND defensively at the top of every PC-Token tRPC procedure. */
export async function bootPcTokenMarkets(): Promise<PcTokenRegistry> {
  const stored = await readStored();
  _runtimeRegistry = stored;
  return stored;
}

function getRuntime(): PcTokenRegistry {
  return _runtimeRegistry ?? emptyRegistry();
}

export function listMarkets(): PcTokenMarket[] {
  return getRuntime().markets.slice();
}

export function getActiveMarketId(): string | null {
  return getRuntime().activeMarketId;
}

export function getActiveMarket(): PcTokenMarket | null {
  const reg = getRuntime();
  if (!reg.activeMarketId) return null;
  return reg.markets.find((m) => m.id === reg.activeMarketId) ?? null;
}

export function getMarketById(id: string): PcTokenMarket | null {
  return getRuntime().markets.find((m) => m.id === id) ?? null;
}

/**
 * set of every distinct splMint across registered markets. UI uses this to gate the Wrap CTA on
 * Portfolio rows: a USDC SPL row gets a Wrap button when at least one market wraps that mint.
 */
export function eligibleSplMints(): Set<string> {
  return new Set(getRuntime().markets.map((m) => m.splMint));
}

/** markets matching a given splMint. multiple entries are valid (different programIds). */
export function marketsForSplMint(splMintB58: string): PcTokenMarket[] {
  return getRuntime().markets.filter((m) => m.splMint === splMintB58);
}

export interface AddMarketInput {
  id: string;
  label: string;
  splMint: string;
  splSymbol: string;
  splDecimals: number;
  programId: string;
  mintAuthorityB58?: string;
  network: 'sol-devnet' | 'sol-mainnet';
}

export async function addMarket(input: AddMarketInput): Promise<PcTokenMarket> {
  if (!isValidMarketId(input.id)) {
    throw new Error(`market id must match [a-zA-Z0-9_-]{1,64}, got "${input.id}"`);
  }
  if (!isValidBase58Pubkey(input.programId)) {
    throw new Error(`programId is not a valid base58 pubkey: ${input.programId}`);
  }
  if (!isValidBase58Pubkey(input.splMint)) {
    throw new Error(`splMint is not a valid base58 pubkey: ${input.splMint}`);
  }
  if (input.mintAuthorityB58 != null && !isValidBase58Pubkey(input.mintAuthorityB58)) {
    throw new Error(`mintAuthorityB58 is not a valid base58 pubkey: ${input.mintAuthorityB58}`);
  }
  if (!input.label.trim()) throw new Error('label cannot be empty');
  if (!input.splSymbol.trim()) throw new Error('splSymbol cannot be empty');
  if (!Number.isInteger(input.splDecimals) || input.splDecimals < 0 || input.splDecimals > 18) {
    throw new Error(`splDecimals must be an integer in [0, 18], got ${input.splDecimals}`);
  }

  const reg = await readStored();
  if (reg.markets.some((m) => m.id === input.id)) {
    throw new Error(`market id "${input.id}" already exists`);
  }
  const entry: PcTokenMarket = {
    id: input.id,
    label: input.label,
    splMint: input.splMint,
    splSymbol: input.splSymbol,
    splDecimals: input.splDecimals,
    programId: input.programId,
    mintAuthorityB58: input.mintAuthorityB58,
    network: input.network,
    builtin: false,
    createdAtMs: Date.now(),
  };
  const next: PcTokenRegistry = {
    markets: [...reg.markets, entry],
    // first add becomes active automatically
    activeMarketId: reg.activeMarketId ?? entry.id,
  };
  await writeStored(next);
  _runtimeRegistry = next;
  return entry;
}

export async function removeMarket(id: string): Promise<void> {
  const reg = await readStored();
  const idx = reg.markets.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const remaining = reg.markets.slice(0, idx).concat(reg.markets.slice(idx + 1));
  let nextActive = reg.activeMarketId;
  if (nextActive === id) {
    nextActive = remaining.length > 0 ? remaining[0]!.id : null;
  }
  const next: PcTokenRegistry = { markets: remaining, activeMarketId: nextActive };
  await writeStored(next);
  _runtimeRegistry = next;
}

export interface UpdateMarketPatch {
  label?: string;
  splSymbol?: string;
  splDecimals?: number;
  mintAuthorityB58?: string | null;
}

export async function updateMarket(id: string, patch: UpdateMarketPatch): Promise<PcTokenMarket> {
  const reg = await readStored();
  const idx = reg.markets.findIndex((m) => m.id === id);
  if (idx < 0) throw new Error(`market "${id}" not found`);
  const cur = reg.markets[idx]!;
  if (patch.label !== undefined && !patch.label.trim()) throw new Error('label cannot be empty');
  if (patch.splSymbol !== undefined && !patch.splSymbol.trim()) throw new Error('splSymbol cannot be empty');
  if (patch.splDecimals !== undefined) {
    if (!Number.isInteger(patch.splDecimals) || patch.splDecimals < 0 || patch.splDecimals > 18) {
      throw new Error(`splDecimals must be an integer in [0, 18], got ${patch.splDecimals}`);
    }
  }
  if (patch.mintAuthorityB58 !== undefined && patch.mintAuthorityB58 !== null) {
    if (!isValidBase58Pubkey(patch.mintAuthorityB58)) {
      throw new Error(`mintAuthorityB58 is not a valid base58 pubkey: ${patch.mintAuthorityB58}`);
    }
  }
  const updated: PcTokenMarket = {
    ...cur,
    label: patch.label ?? cur.label,
    splSymbol: patch.splSymbol ?? cur.splSymbol,
    splDecimals: patch.splDecimals ?? cur.splDecimals,
    mintAuthorityB58:
      patch.mintAuthorityB58 === null
        ? undefined
        : patch.mintAuthorityB58 ?? cur.mintAuthorityB58,
  };
  const nextMarkets = reg.markets.slice();
  nextMarkets[idx] = updated;
  const next: PcTokenRegistry = { markets: nextMarkets, activeMarketId: reg.activeMarketId };
  await writeStored(next);
  _runtimeRegistry = next;
  return updated;
}

export async function setActiveMarketId(id: string | null): Promise<void> {
  const reg = await readStored();
  if (id !== null && !reg.markets.some((m) => m.id === id)) {
    throw new Error(`cannot activate unknown market "${id}"`);
  }
  const next: PcTokenRegistry = { markets: reg.markets, activeMarketId: id };
  await writeStored(next);
  _runtimeRegistry = next;
}

/** test-only: reset the runtime cache so unit tests get a clean slate. */
export function __resetPcTokenMarketsRuntimeForTests(): void {
  _runtimeRegistry = null;
}

/** test-only: set the runtime cache directly without going through chrome.storage. */
export function __setPcTokenMarketsRuntimeForTests(reg: PcTokenRegistry | null): void {
  _runtimeRegistry = reg;
}
