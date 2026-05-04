/**
 * shared types for the chromatika "scan for additional accounts" flow.
 *
 * the scan answers two questions for the user during import / restore:
 *   1. **which derivation slots have on-chain history?** for HD vaults this is bip44 account
 *      index (different sui/sol/evm addresses per index). for passkey / seeker / waap / lazor
 *      the identity address is fixed - those methods get a single-row scan focused on chain
 *      coverage rather than slot enumeration.
 *   2. **what activity exists on each address?** balance + tx count on sui mainnet + solana
 *      mainnet + solana devnet by default; super-pro mode opens evm L2s + bitcoin + aptos +
 *      anything in `SUPER_PRO_CHAINS`.
 *
 * dwallet count = number of owned `DWalletCap` objects for the candidate's primary sui address
 * (or solana pda for solana-base). v1 shows the count without matching per ika encryption index;
 * the per-index breakdown is a future precision feature - the simple count is what users actually
 * read first ("you have 3 dwallets here").
 */

/** which onboarding method we're scanning for. each has different derivation semantics. */
export type ScanMethod = 'passkey' | 'hd' | 'seeker' | 'waap' | 'lazor';

/** validated bip44 account scan dimensions. ika-encryption-index is a separate post-unlock feature, not part of the activity scan. */
export type ScanGapLimits = {
  /** HD only. account-index gap limit. default 5 (matches bip44 spec). */
  accountIndexGap?: number;
  /** hard ceiling so a misbehaving probe can't trigger an unbounded loop. default 20. */
  maxIndexHardLimit?: number;
};

/** chains to probe for activity. always includes the default trio; super-pro adds opt-ins. */
export type ScanChainSelection = {
  /** sui mainnet + solana mainnet + solana devnet always run when this is true. */
  defaults: boolean;
  /** super-pro chain ids from `scan-chains.ts`. empty = no super-pro probes. */
  superProChainIds?: string[];
};

/**
 * inputs needed to run a scan. shape is method-specific because the underlying secret + derivation
 * rules differ. all variants are passed through tRPC and live in the background only.
 *
 * **note on secrets**: HD passes the mnemonic through, since derivation runs background-side.
 * passkey passes the prf-derived sui address only (no prf needed for activity probing - we just
 * hit the address). seeker passes the base58 pubkey. waap passes the sui address. lazor passes
 * the smart-wallet pda. for activity scans, we never need the wallet's signing capability.
 */
export type ScanInput =
  | {
      method: 'hd';
      mnemonic: string;
      gap?: ScanGapLimits;
    }
  | {
      method: 'passkey';
      /** passkey sui address (sip-9 / 0x06 flag, blake2b of compressed pubkey). */
      suiAddress: string;
    }
  | {
      method: 'seeker';
      /** seeker base58 solana pubkey - the user-facing solana identity. */
      solanaAddress: string;
    }
  | {
      method: 'waap';
      /** waap-returned sui address. */
      suiAddress: string;
    }
  | {
      method: 'lazor';
      /** lazor smart-wallet pda (base58). */
      lazorSmartWalletPubkeyB58: string;
    };

/**
 * one candidate slot in the scan result. for HD, one row per accountIndex 0..N. for everything
 * else, exactly one row with `accountIndex = undefined`.
 */
export type ScanCandidate = {
  /** uniquely identifies this row. used as react key + import selection key. */
  key: string;
  /** HD only. bip44 account index in the derivation path `m/44'/{coinType}'/N'/0'/0'`. */
  accountIndex?: number;
  /** sui address for this candidate (HD: derived per accountIndex; everything else: identity address). undefined for solana-base lazor. */
  suiAddress?: string;
  /** solana address for this candidate (HD: derived per accountIndex; seeker/lazor: fixed). */
  solanaAddress?: string;
  /** evm address for this candidate (HD only). */
  evmAddress?: string;
  /**
   * 33-byte compressed secp256k1 public key (hex, no `0x` prefix). HD candidates populate this
   * from the bip44 evm derivation path so probes that need a raw secp pubkey (currently DeSo
   * + Cosmos) can produce their own address encoding without re-deriving the keypair. dwallet-bound
   * methods leave it undefined - their secp public key lives on chain in the dwallet's
   * `public_output`, not in the local candidate.
   */
  secp256k1CompressedHex?: string;
  /**
   * 32-byte ed25519 public key (hex, no `0x` prefix) derived at the polkadot/substrate
   * standard path `m/44'/354'/N'/0'/0'`. used by the SS58 probe (Polkadot / Kusama / generic
   * Substrate). HD-only; dwallet-bound methods skip it for the same reason as the secp variant.
   *
   * **note**: this is chromatika's own ed25519 derivation. polkadot.js / Talisman / Nova default
   * to sr25519 + substrate's native (non-slip10) derivation, so the chromatika-derived address
   * will NOT match what those wallets produce from the same phrase. recovery only works when
   * the user creates their polkadot account in chromatika directly OR explicitly uses ed25519
   * in another wallet that follows slip10.
   */
  polkadotEd25519PubkeyHex?: string;
};

/** one probe result for a (chain, address) pair. */
export type ScanProbeResult = {
  chainId: string;
  chainName: string;
  address: string;
  /** native balance in smallest units (lamports / wei / mist / sats). undefined on probe error. */
  balanceSmallest?: bigint;
  /** human-friendly balance string (eg "0.123 SUI"). */
  balanceDisplay?: string;
  /** tx count when the chain exposes one cheaply. for chains where this requires a paid api, may be undefined. */
  txCount?: number;
  /** has any transaction touched this address? proxies activity even when balance is 0. */
  hasActivity: boolean;
  error?: string;
};

/** discovered ika dwallet caps owned by the candidate. one row per owned cap. */
export type ScanDiscoveredDwallet = {
  capObjectId: string;
  dwalletId: string;
  /** which on-chain network this cap was found on. */
  baseChain: 'sui' | 'solana';
  /** when baseChain = 'solana', whether discovered on devnet vs mainnet. */
  cluster?: 'devnet' | 'mainnet';
  status?: string;
};

/** complete result for one candidate row in the scan results table. */
export type ScanCandidateRow = {
  candidate: ScanCandidate;
  probes: ScanProbeResult[];
  dwallets: ScanDiscoveredDwallet[];
  dwalletCount: number;
  /** convenience: any probe.hasActivity OR any non-zero balance OR dwalletCount > 0. */
  hasAnyActivity: boolean;
  /** is this row the "default" first slot (account 0)? always shown even when empty. */
  isDefaultSlot: boolean;
};

/** the scan output handed back to tRPC + the UI table component. */
export type ScanResult = {
  method: ScanMethod;
  /** rows ordered by accountIndex asc; for non-HD methods, exactly one row. */
  rows: ScanCandidateRow[];
  /** suggested rows the UI auto-checks for the user (anything with activity + the default slot). */
  suggestedKeys: string[];
  /** total wall-clock ms spent on the scan. */
  elapsedMs: number;
  /** non-fatal errors collected during scanning. */
  warnings: string[];
  /**
   * setup-time notes for the user that explain WHY the scan looks the way it does - distinct
   * from per-probe warnings. used today for the lazor placeholder-PDA case ("smart-wallet PDA
   * not yet resolved; solana probes skipped"). UI surfaces these above the candidate rows.
   */
  notes: string[];
};

/** per-chain probe abstraction. one of these per (chain, network) the scan supports. */
export type ChainProbe = {
  chainId: string;
  chainName: string;
  kind: 'sui' | 'solana' | 'evm' | 'bitcoin' | 'aptos' | 'deso' | 'cosmos' | 'polkadot';
  /** which address shape this probe accepts. used to skip rows that have no matching address. */
  addressFor: (c: ScanCandidate) => string | undefined;
  /** run the probe. timebox + rate-limit are handled by the orchestrator. */
  probe: (address: string) => Promise<Omit<ScanProbeResult, 'chainId' | 'chainName' | 'address'>>;
};
