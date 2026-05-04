/**
 * tRPC procedures for PC-Token hidden transfers.
 *
 * markets (one per deployed PC-Token program) live in the `pc-token-markets` registry. procedures
 * accept an optional `marketId`; when omitted the active market is used. before invoking the flow,
 * the router sets the requested market as active so PDA / ix builders that source from the
 * active-market accessor stay correct.
 *
 * mint authority defaults to the active dWallet ed25519 address per chromatika install. a market
 * may override this via `mintAuthorityB58` (for e.g. participating in a community-shared market
 * with a fixed authority). when two installs want to exchange pcTokens, they must agree on BOTH
 * the program ID AND the mint authority, i.e. they share a market entry.
 */

import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { publicProcedure } from '../trpc';
import { getSession } from '@/background/session';
import { getSolanaAddress, getDwalletEd25519PublicKey } from '@/background/chains/solana';
import {
  pcTokenWrap,
  pcTokenTransferHidden,
  pcTokenUnwrap,
  pcTokenAccountStatus,
} from '@/background/encrypt-pc/pc-token-flows';
import { readPcBalance } from '@/background/encrypt-pc/pc-token-balance';
import {
  derivePcMintPda,
  derivePcAccountPda,
} from '@/background/encrypt-pc/pc-token-pda';
import { isPcTokenConfigured } from '@/background/encrypt-pc/pc-token-program';
import {
  addMarket,
  bootPcTokenMarkets,
  getActiveMarket,
  getActiveMarketId,
  getMarketById,
  listMarkets,
  removeMarket,
  setActiveMarketId,
  updateMarket,
  type PcTokenMarket,
} from '@/background/encrypt-pc/pc-token-markets';
import { PcTokenError } from '@/background/encrypt-pc/pc-token-types';
import { STORAGE_KEYS } from '@/background/storage';

const PC_DISCLAIMER_KEY = STORAGE_KEYS.PC_DISCLAIMER_V1;

interface PcDisclaimerStore {
  /** vault id -> ms-since-epoch ack timestamp */
  [vaultId: string]: number;
}

async function loadDisclaimerStore(): Promise<PcDisclaimerStore> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PC_DISCLAIMER_KEY], (r) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      const v = r[PC_DISCLAIMER_KEY];
      resolve(v && typeof v === 'object' ? (v as PcDisclaimerStore) : {});
    });
  });
}

async function saveDisclaimerStore(store: PcDisclaimerStore): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PC_DISCLAIMER_KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function requireActiveVaultId(): string {
  const s = getSession();
  if (!s?.activeVaultId) {
    throw new PcTokenError('wallet-locked', 'unlock the wallet to use PC-Token');
  }
  return s.activeVaultId;
}

/**
 * resolve the requested market (or active when omitted) and ensure it's the active one before the
 * flow runs. PDA / ix builders source from the active-market accessor, so this guarantees
 * multi-market correctness.
 */
async function requireMarket(marketId?: string): Promise<PcTokenMarket> {
  await bootPcTokenMarkets();
  const m = marketId ? getMarketById(marketId) : getActiveMarket();
  if (!m) {
    throw new PcTokenError(
      'not-configured',
      marketId
        ? `unknown PC-Token market "${marketId}"`
        : 'No PC-Token market is configured. Add one in Settings -> PC-Token markets.',
    );
  }
  if (m.id !== getActiveMarketId()) {
    await setActiveMarketId(m.id);
  }
  return m;
}

/**
 * resolve the mint authority for a market. falls back to the active dWallet ed25519 pubkey when
 * the market has no explicit override, matching v0 single-install behavior.
 */
async function resolveMintAuthority(market: PcTokenMarket): Promise<PublicKey> {
  if (market.mintAuthorityB58) {
    return new PublicKey(market.mintAuthorityB58);
  }
  const ed = await getDwalletEd25519PublicKey();
  return new PublicKey(ed);
}

const optionalMarketId = z
  .object({ marketId: z.string().min(1).max(64).optional() })
  .partial()
  .optional()
  .default({});

export const pcTokenProcedures = {
  /** list all configured PC-Token markets + the currently active one. */
  listPcTokenMarkets: publicProcedure.query(async () => {
    await bootPcTokenMarkets();
    return {
      markets: listMarkets(),
      activeMarketId: getActiveMarketId(),
    };
  }),

  /** add a new market. first add becomes active automatically. */
  addPcTokenMarket: publicProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        label: z.string().min(1).max(80),
        splMint: z.string().min(32).max(48),
        splSymbol: z.string().min(1).max(16),
        splDecimals: z.number().int().min(0).max(18),
        programId: z.string().min(32).max(48),
        mintAuthorityB58: z.string().min(32).max(48).optional(),
        network: z.enum(['sol-devnet', 'sol-mainnet']),
      }),
    )
    .mutation(async ({ input }) => {
      await bootPcTokenMarkets();
      const m = await addMarket(input);
      return { ok: true as const, market: m, activeMarketId: getActiveMarketId() };
    }),

  /** remove a market by id. removing the active market rolls activeMarketId to the next entry. */
  removePcTokenMarket: publicProcedure
    .input(z.object({ marketId: z.string().min(1).max(64) }))
    .mutation(async ({ input }) => {
      await bootPcTokenMarkets();
      await removeMarket(input.marketId);
      return { ok: true as const, activeMarketId: getActiveMarketId() };
    }),

  /** update a market's mutable fields (label, symbol, decimals, mint authority). */
  updatePcTokenMarket: publicProcedure
    .input(
      z.object({
        marketId: z.string().min(1).max(64),
        patch: z.object({
          label: z.string().min(1).max(80).optional(),
          splSymbol: z.string().min(1).max(16).optional(),
          splDecimals: z.number().int().min(0).max(18).optional(),
          // null clears the override; undefined leaves untouched.
          mintAuthorityB58: z.union([z.string().min(32).max(48), z.null()]).optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      await bootPcTokenMarkets();
      const m = await updateMarket(input.marketId, input.patch);
      return { ok: true as const, market: m };
    }),

  /** set the active market. pass `null` to clear (rare). */
  setActivePcTokenMarket: publicProcedure
    .input(z.object({ marketId: z.string().min(1).max(64).nullable() }))
    .mutation(async ({ input }) => {
      await bootPcTokenMarkets();
      await setActiveMarketId(input.marketId);
      return { ok: true as const, activeMarketId: getActiveMarketId() };
    }),

  /** whether the current vault has acknowledged the honesty disclaimer modal. */
  getPcDisclaimerState: publicProcedure.query(async () => {
    const vaultId = requireActiveVaultId();
    const store = await loadDisclaimerStore();
    return { acknowledged: typeof store[vaultId] === 'number', ackAtMs: store[vaultId] ?? null };
  }),

  /** record the disclaimer ack for the active vault. called after the user checks all 3 boxes. */
  ackPcDisclaimer: publicProcedure.mutation(async () => {
    const vaultId = requireActiveVaultId();
    const store = await loadDisclaimerStore();
    store[vaultId] = Date.now();
    await saveDisclaimerStore(store);
    return { ok: true as const };
  }),

  /** reset the disclaimer ack for the active vault. used by the settings page. */
  resetPcDisclaimer: publicProcedure.mutation(async () => {
    const vaultId = requireActiveVaultId();
    const store = await loadDisclaimerStore();
    delete store[vaultId];
    await saveDisclaimerStore(store);
    return { ok: true as const };
  }),

  /**
   * whether a pcToken account is initialized for a given (market, owner). defaults owner to the
   * active vault's solana address; pass `ownerSolAddress` to check a recipient pre-send.
   */
  pcTokenAccountStatus: publicProcedure
    .input(
      z
        .object({
          marketId: z.string().min(1).max(64).optional(),
          ownerSolAddress: z.string().min(32).max(48).optional(),
        })
        .partial()
        .optional()
        .default({}),
    )
    .query(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const mintAuthority = await resolveMintAuthority(market);
      return pcTokenAccountStatus({
        splMint: market.splMint,
        mintAuthority,
        programId: new PublicKey(market.programId),
        ownerB58Override: input.ownerSolAddress,
      });
    }),

  /** read the active vault's decrypted pcToken balance for the given market. */
  getPcBalance: publicProcedure
    .input(optionalMarketId)
    .query(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const s = getSession();
      if (!s) throw new PcTokenError('wallet-locked', 'unlock to read pcToken balance');
      const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
      if (!conn) throw new PcTokenError('protocol-error', 'no solana RPC configured');
      const mintAuthority = await resolveMintAuthority(market);
      const programId = new PublicKey(market.programId);
      const { pda: pcMint } = derivePcMintPda(mintAuthority, programId);
      const owner = new PublicKey(await getSolanaAddress());
      const balance = await readPcBalance({ connection: conn, pcMint, owner, splMintB58: market.splMint });
      return { ...balance, marketId: market.id, splDecimals: market.splDecimals };
    }),

  /** wrap SPL -> pcSPL for the given market. auto-initializes the pcToken account on first call. */
  pcTokenWrap: publicProcedure
    .input(
      z.object({
        marketId: z.string().min(1).max(64).optional(),
        amountBaseUnits: z.string().min(1).max(20).regex(/^\d+$/, 'amount must be a base-units decimal string'),
      }),
    )
    .mutation(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const mintAuthority = await resolveMintAuthority(market);
      return pcTokenWrap(
        { splMint: market.splMint, amountBaseUnits: input.amountBaseUnits },
        { mintAuthority, programId: new PublicKey(market.programId) },
      );
    }),

  /** hidden transfer pcToken to another solana address within the given market. */
  pcTokenTransferHidden: publicProcedure
    .input(
      z.object({
        marketId: z.string().min(1).max(64).optional(),
        recipientSolAddress: z.string().min(32).max(48),
        amountBaseUnits: z.string().min(1).max(20).regex(/^\d+$/),
      }),
    )
    .mutation(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const mintAuthority = await resolveMintAuthority(market);
      return pcTokenTransferHidden(
        {
          splMint: market.splMint,
          recipientSolAddress: input.recipientSolAddress,
          amountBaseUnits: input.amountBaseUnits,
        },
        { mintAuthority, programId: new PublicKey(market.programId) },
      );
    }),

  /**
   * 3-step unwrap. caller invokes:
   *   1. `pcTokenUnwrapStep({ phase: 'burn', amountBaseUnits })` -> returns burn signature + decryptRequest pubkey
   *   2. `pcTokenUnwrapStep({ phase: 'decrypt-wait', burnedCt, requestAcct })` -> blocks until executor commits
   *   3. `pcTokenUnwrapStep({ phase: 'complete', burnedCt, requestAcct })` -> returns release signature
   */
  pcTokenUnwrapStep: publicProcedure
    .input(
      z.union([
        z.object({
          phase: z.literal('burn'),
          marketId: z.string().min(1).max(64).optional(),
          amountBaseUnits: z.string().min(1).max(20).regex(/^\d+$/),
        }),
        z.object({
          phase: z.literal('decrypt-wait'),
          marketId: z.string().min(1).max(64).optional(),
          burnedCt: z.string().min(32).max(48),
          requestAcct: z.string().min(32).max(48),
        }),
        z.object({
          phase: z.literal('complete'),
          marketId: z.string().min(1).max(64).optional(),
          burnedCt: z.string().min(32).max(48),
          requestAcct: z.string().min(32).max(48),
          amountBaseUnits: z.string().min(1).max(20).regex(/^\d+$/),
        }),
      ]),
    )
    .mutation(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const mintAuthority = await resolveMintAuthority(market);
      const programId = new PublicKey(market.programId);
      if (input.phase === 'burn') {
        return pcTokenUnwrap(
          { splMint: market.splMint, amountBaseUnits: input.amountBaseUnits },
          { mintAuthority, programId },
        );
      }
      if (input.phase === 'decrypt-wait') {
        return pcTokenUnwrap(
          { splMint: market.splMint, amountBaseUnits: 'POLL_DECRYPT' },
          {
            mintAuthority,
            programId,
            receiptCtxFromBurn: { burnedCt: input.burnedCt, requestAcct: input.requestAcct },
          },
        );
      }
      // complete
      return pcTokenUnwrap(
        { splMint: market.splMint, amountBaseUnits: input.amountBaseUnits },
        {
          mintAuthority,
          programId,
          receiptCtxFromBurn: { burnedCt: input.burnedCt, requestAcct: input.requestAcct },
        },
      );
    }),

  /** diagnostic: derive the user's TokenAccount PDA for an arbitrary recipient solana address. */
  pcTokenDeriveAccount: publicProcedure
    .input(
      z.object({
        marketId: z.string().min(1).max(64).optional(),
        ownerSolAddress: z.string().min(32).max(48),
      }),
    )
    .query(async ({ input }) => {
      const market = await requireMarket(input.marketId);
      const mintAuthority = await resolveMintAuthority(market);
      const programId = new PublicKey(market.programId);
      const { pda: pcMint } = derivePcMintPda(mintAuthority, programId);
      const owner = new PublicKey(input.ownerSolAddress);
      const { pda: tokenAccount } = derivePcAccountPda(pcMint, owner, programId);
      return {
        pcMintB58: pcMint.toBase58(),
        tokenAccountB58: tokenAccount.toBase58(),
      };
    }),

  /** lightweight gate so the UI can hide pcToken affordances when no market is configured. */
  isPcTokenConfigured: publicProcedure.query(async () => {
    await bootPcTokenMarkets();
    return { configured: isPcTokenConfigured(), activeMarketId: getActiveMarketId() };
  }),
};
