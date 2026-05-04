/**
 * PC-Token program constants. mirrors the upstream pinocchio program at
 * `chains/solana/examples/pc-token/pinocchio/src/lib.rs` in the dwallet-labs/encrypt-pre-alpha repo.
 *
 * program ID handling now flows through the **market registry** (`pc-token-markets.ts`). this file
 * keeps `getPcTokenProgramId()` / `isPcTokenConfigured()` as compatibility shims that read the
 * **active market**, so older call sites that don't yet thread an explicit `marketId` keep working.
 *
 * pre-release: legacy `chromatika_pc_token_program_v1` storage is ignored - users re-add their
 * program ID once via the new Settings markets panel when this ships.
 */

import { PublicKey } from '@solana/web3.js';
import {
  bootPcTokenMarkets,
  getActiveMarket,
  __setPcTokenMarketsRuntimeForTests,
  __resetPcTokenMarketsRuntimeForTests,
  type PcTokenMarket,
} from '@/background/encrypt-pc/pc-token-markets';

/** sentinel value (all-1s base58 = the System Program) - used by callers that need a "no market configured" placeholder. */
export const PC_TOKEN_PROGRAM_ID_UNCONFIGURED_SENTINEL = '11111111111111111111111111111112';

/**
 * hydrate the runtime market registry from chrome.storage. idempotent. call from SW startup AND
 * defensively at the top of every PC-Token tRPC procedure.
 *
 * kept as `bootPcTokenProgramId` for any external callers (legacy name); internally just delegates
 * to `bootPcTokenMarkets`.
 */
export async function bootPcTokenProgramId(): Promise<string> {
  await bootPcTokenMarkets();
  return getPcTokenProgramIdB58();
}

/**
 * active market's program ID, or the unconfigured sentinel when no market is configured. sync -
 * callers must `bootPcTokenMarkets()` once at SW startup or tRPC entry to populate the runtime
 * cache; without that, this returns the sentinel.
 */
export function getPcTokenProgramIdB58(): string {
  const m = getActiveMarket();
  return m?.programId ?? PC_TOKEN_PROGRAM_ID_UNCONFIGURED_SENTINEL;
}

/** active market's program ID as a `PublicKey`. convenience for the ix builders + PDA derivers. */
export function getPcTokenProgramId(): PublicKey {
  return new PublicKey(getPcTokenProgramIdB58());
}

/** true when the active market resolves to a real program ID (i.e. user has added at least one market). */
export function isPcTokenConfigured(): boolean {
  return getPcTokenProgramIdB58() !== PC_TOKEN_PROGRAM_ID_UNCONFIGURED_SENTINEL;
}

/**
 * PC-Token instruction discriminators. verbatim from the upstream pinocchio program; see the
 * spike doc (`PC_TOKEN_SPIKE.md` section 3) for per-ix wire formats.
 */
export const PC_TOKEN_IX = {
  InitializeMint: 0,
  InitializeAccount: 1,
  Transfer: 3,
  Approve: 4,
  Revoke: 5,
  MintTo: 7,
  FreezeAccount: 10,
  ThawAccount: 11,
  TransferFrom: 20,
  TransferWithReceipt: 22,
  InitializeVault: 23,
  Wrap: 30,
  UnwrapBurn: 31,
  UnwrapDecrypt: 32,
  UnwrapComplete: 33,
} as const;

/** PDA seed strings (utf-8 bytes). match upstream exactly. */
export const PC_TOKEN_SEEDS = {
  mint: 'pc_mint',
  vault: 'pc_vault',
  account: 'pc_account',
  receipt: 'pc_receipt',
  /** anchor-style CPI authority on the PC-Token program. */
  cpiAuthority: '__encrypt_cpi_authority',
} as const;

/**
 * Encrypt program PDAs the PC-Token CPI bundle references. lives on the Encrypt program
 * (`ENCRYPT_SOLANA_PROGRAM_ID`), not on PC-Token. matches `_shared/encrypt-setup.ts` upstream.
 */
export const ENCRYPT_PROGRAM_SEEDS = {
  config: 'encrypt_config',
  deposit: 'encrypt_deposit',
  networkKey: 'network_encryption_key',
  eventAuthority: '__event_authority',
} as const;

/**
 * Encrypt FHE type tags. PC-Token amounts are EUint64 (u64) per the wrap / transfer / unwrap
 * ix data layouts. `encryptValue(value, fheType)` from
 * `@encrypt.xyz/pre-alpha-solana-client/grpc-web` emits the 17-byte format with the type tag
 * prefix.
 */
export const ENCRYPT_FHE_TYPE = {
  EUint8: 1,
  EUint16: 2,
  EUint32: 3,
  EUint64: 4,
  EUint128: 5,
} as const;

/**
 * Solana devnet Circle USDC mint - the demo asset for v0. adding more pcSPLs is a config-table
 * extension (just add a market entry pointing to another mint). no protocol changes needed.
 *
 * faucet: https://faucet.circle.com/ (USDC dropdown, Solana network).
 */
export const DEMO_SPL_USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** USDC has 6 decimals on Solana. */
export const DEMO_SPL_USDC_DECIMALS = 6;

/**
 * default mint authority hint. until we coordinate a community-shared pcUSDC mint, each chromatika
 * install's mint authority defaults to the active dWallet ed25519 address; pcUSDC mints are
 * per-install. future: a canonical chromatika mint authority shared across installs.
 */
export const DEMO_PC_USDC_MINT_AUTHORITY_HINT = 'active-dwallet-ed25519';

/** SPL Token program (classic, not Token-2022). */
export const SPL_TOKEN_PROGRAM_ID_B58 = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** standard System Program. */
export const SYSTEM_PROGRAM_ID_B58 = '11111111111111111111111111111111';

// -----------------------------------------------------------------------------
// test-only shims. existing tests (`pc-token-pda.test.ts`, `pc-token-instructions.test.ts`) inject
// a fake program ID via these helpers. we map them onto the markets registry runtime cache so
// the tests keep working without rewriting; the production path runs through `getActiveMarket()`.
// -----------------------------------------------------------------------------

const TEST_MOCK_MARKET_ID = '__test_mock_market__';

function makeTestMarket(programIdB58: string): PcTokenMarket {
  return {
    id: TEST_MOCK_MARKET_ID,
    label: 'test mock market',
    splMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    splSymbol: 'USDC',
    splDecimals: 6,
    programId: programIdB58,
    network: 'sol-devnet',
    builtin: false,
    createdAtMs: 0,
  };
}

/** test-only: inject a fake program ID into the runtime market registry. */
export function __setPcTokenProgramIdRuntimeForTests(programIdB58: string | null): void {
  if (programIdB58 === null) {
    __resetPcTokenMarketsRuntimeForTests();
    return;
  }
  __setPcTokenMarketsRuntimeForTests({
    markets: [makeTestMarket(programIdB58)],
    activeMarketId: TEST_MOCK_MARKET_ID,
  });
}

/** test-only: reset the runtime market cache so unit tests get a clean slate. */
export function __resetPcTokenProgramIdRuntimeForTests(): void {
  __resetPcTokenMarketsRuntimeForTests();
}
