import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { trpcAddressParam } from '../trpc-input-schemas';
import { getSession } from '@/background/session';
import { withFriendlyIkaError } from '@/background/ika/errors';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { fetchEvmTokenBalances } from '@/background/chains/evm-tokens';
import { fetchDwalletHomeGasRows } from '@/background/chains/dwallet-home-gas';
import { fetchPortfolioRailNativeRows } from '@/background/portfolio-rail-balances';
import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import {
  parseDecimalSuiToMist,
  sendNativeSuiTransfer,
} from '@/background/chains/sui-send-native';
import {
  parseDecimalSolToLamports,
  sendSolanaNativeTransfer,
} from '@/background/chains/solana-send-native';
import {
  parseDecimalSplToBaseUnits,
  sendSolanaSplTransfer,
} from '@/background/chains/solana-send-spl';
import { listSolanaSplBalances } from '@/background/chains/solana-list-spl';
import { requireVaultFeePayerSession } from '@/background/chains/solana-fee-payer-signer';
import {
  parseDecimalBtcToSats,
  sendBtcNativeTransfer,
} from '@/background/chains/btc-send-native';
import { signAndBroadcastEvm } from '@/background/chains/evm-send';
import { getActiveNetworks } from '@/background/network/active-network';
import { getMultiChainActivity } from '@/background/services/activity';

export const sendProcedures = {
  getEvmTokenBalances: publicProcedure
    .input(z.object({ address: trpcAddressParam, chainId: z.number().int().positive() }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const tokens = await fetchEvmTokenBalances(input.address, input.chainId);
      return { tokens };
    }),

  /** on-chain derivation for BTC/EVM/SOL/SUI/APT deposit addresses (same as list caps); use when ui row lagged empty. */
  getDwalletChainAddresses: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const { btcNetworkId } = await getActiveNetworks();
      const btcNet = btcNetworkId.startsWith('btc-testnet') ? ('testnet' as const) : ('mainnet' as const);
      return withFriendlyIkaError(() => chainAddressesForDwalletId(input.dwalletId, btcNet));
    }),

  /** native gas balances for dWallet home cards (multi-rpc eth_getBalance for EVM; active chain row kept at zero). */
  getDwalletHomeGas: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
      const cap = caps.find((c) => c.dwalletId === input.dwalletId);
      if (!cap) throw new Error('dWallet not found');
      const rows = await fetchDwalletHomeGasRows(cap);
      return { rows };
    }),

  /**
   * wallet home: one round-trip for all active dWallet cards. sequential per dWallet so we do not
   * stack N x Promise.all(evm networks) inside a single MV3 worker tick (that pattern was bricking the sw).
   */
  getDwalletHomeGasMany: publicProcedure
    .input(z.object({ dwalletIds: z.array(z.string().trim().min(1)).max(48) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
      const byDwalletId: Record<string, Awaited<ReturnType<typeof fetchDwalletHomeGasRows>>> = {};
      const seen = new Set<string>();
      for (const id of input.dwalletIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const cap = caps.find((c) => c.dwalletId === id);
        if (!cap) continue;
        if (cap.curve !== 'SECP256K1' && cap.curve !== 'ED25519') continue;
        byDwalletId[id] = await fetchDwalletHomeGasRows(cap);
      }
      return { byDwalletId };
    }),

  getActivity: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).optional().default(20) }))
    .query(({ input }) => getMultiChainActivity(input.limit)),

  /**
   * user-initiated EVM send from the side panel, bypasses the approval popup
   * because the user is already in the wallet UI making an intentional action.
   */
  sendEvmTx: publicProcedure
    .input(
      z.object({
        to: z.string(),
        value: z.string().default('0x0'),
        data: z.string().default('0x'),
        /** when set, sign and broadcast on this chain instead of the active evm network. */
        chainId: z.number().int().positive().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const txHash = await signAndBroadcastEvm({
        to: input.to,
        value: input.value,
        data: input.data,
        gas: null,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        gasPrice: null,
        nonce: null,
        chainId: input.chainId,
        ikaBenchContext: { source: 'wallet_send_evm' },
      });
      return { txHash };
    }),

  /** native balances for one address on a portfolio rail (DWallet tab). */
  portfolioRailBalances: publicProcedure
    .input(
      z.object({
        rail: z.enum(['sui', 'solana', 'aptos', 'btcP2wpkh', 'btcP2tr']),
        address: trpcAddressParam,
      }),
    )
    .query(async ({ input }) => fetchPortfolioRailNativeRows(input.rail, input.address)),

  /** HD fee-payer native SUI transfer (gas coin); not ika MPC. */
  sendSuiNative: publicProcedure
    .input(
      z.object({
        to: z.string().trim().min(1),
        amountSui: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const mist = parseDecimalSuiToMist(input.amountSui);
      if (mist <= 0n) throw new Error('Amount must be positive');
      const digest = await sendNativeSuiTransfer(input.to, mist);
      return { digest };
    }),

  /** native SOL from ED25519 dWallet (ika Ed25519 sign on serialized tx message). */
  sendSolanaNative: publicProcedure
    .input(
      z.object({
        to: z.string().trim().min(1),
        amountSol: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const lamports = parseDecimalSolToLamports(input.amountSol);
      if (lamports <= 0n) throw new Error('Amount must be positive');
      const signature = await sendSolanaNativeTransfer(input.to, lamports);
      return { signature };
    }),

  /**
   * classic SPL holdings at the **dWallet Vault's fee-payer address** (the address shown
   * on the VaultBaseCard). used by the Send UI to populate an asset picker so any token
   * sitting at the vault address (e.g. devnet USDC sent by mistake) can be moved out.
   * Token-2022 not included. throws when no local Solana fee-payer is available
   * (locked / non-Solana-base / hardware-only fee-payer).
   */
  listSolanaSplBalances: publicProcedure.query(async () => {
    const { payer, connection } = requireVaultFeePayerSession();
    const owner = payer.publicKey.toBase58();
    const tokens = await listSolanaSplBalances(owner, connection);
    return { owner, tokens };
  }),

  /**
   * classic SPL holdings at any Solana `address` on the **dWallet-tier** Solana connection.
   * used by the dWallet portfolio so devnet / testnet tokens with no metadata service
   * ("unknown assets", surface symbol from mint short-code, no USD) still show up.
   * Token-2022 not included. throws when locked.
   */
  listSolanaSplBalancesForDwallet: publicProcedure
    .input(z.object({ address: trpcAddressParam }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      if (!s.dwalletSolanaConnection) {
        throw new Error('Solana RPC not configured for the dWallet tier.');
      }
      const tokens = await listSolanaSplBalances(input.address, s.dwalletSolanaConnection);
      return { tokens };
    }),

  /** SPL token transfer from ED25519 dWallet (auto-creates recipient ATA if needed). */
  sendSplToken: publicProcedure
    .input(
      z.object({
        to: z.string().trim().min(1),
        mint: z.string().trim().min(1),
        amount: z.string().trim().min(1),
        decimals: z.number().int().min(0).max(18),
      }),
    )
    .mutation(async ({ input }) => {
      const baseUnits = parseDecimalSplToBaseUnits(input.amount, input.decimals);
      if (baseUnits <= 0n) throw new Error('Amount must be positive');
      const signature = await sendSolanaSplTransfer(input.to, input.mint, baseUnits);
      return { signature };
    }),

  /** native BTC from P2WPKH dWallet (Esplora UTXOs + ika SECP256K1 on BIP143 preimage). */
  sendBtcNative: publicProcedure
    .input(
      z.object({
        to: z.string().trim().min(1),
        amountBtc: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const sats = parseDecimalBtcToSats(input.amountBtc);
      if (sats <= 0n) throw new Error('Amount must be positive');
      const txid = await sendBtcNativeTransfer(input.to, input.amountBtc);
      return { txid };
    }),
};
