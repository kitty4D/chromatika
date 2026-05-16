import { z } from 'zod';
import { Interface, parseUnits } from 'ethers';
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
  parseDecimalCoinToBaseUnits,
  sendSuiCoinTransfer,
} from '@/background/chains/sui-send-coin';
import { sendSuiFromDwallet } from '@/background/chains/sui-send-from-dwallet';
import {
  parseDecimalSolToLamports,
  sendSolanaNativeTransfer,
} from '@/background/chains/solana-send-native';
import {
  parseDecimalSplToBaseUnits,
  sendSolanaSplTransfer,
} from '@/background/chains/solana-send-spl';
import {
  sendSolanaNativeFromDwallet,
  sendSolanaSplFromDwallet,
} from '@/background/chains/solana-send-from-dwallet';
import { listSolanaSplBalances } from '@/background/chains/solana-list-spl';
import { requireVaultFeePayerSession } from '@/background/chains/solana-fee-payer-signer';
import {
  parseDecimalBtcToSats,
  sendBtcNativeTransfer,
} from '@/background/chains/btc-send-native';
import { signAndBroadcastEvm } from '@/background/chains/evm-send';
import { getActiveNetworks } from '@/background/network/active-network';
import { getMultiChainActivity } from '@/background/services/activity';
import {
  addAddressBookEntry,
  listAddressBook,
  removeAddressBookEntry,
  renameAddressBookEntry,
  type AddressBookChain,
} from '@/background/services/address-book';
import {
  listRecentRecipients,
  recordRecentRecipient,
} from '@/background/services/recent-recipients';
import {
  getOrComputeSendTokenList,
} from '@/background/services/send-token-list';
import {
  inspectDwalletForRecovery,
  listInternalSigningKeypairAddresses,
  probeInternalSigningKeyBalances,
  recoverFromInternalSigningKey,
} from '@/background/chains/sui-recover-internal-signing-key';

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

  // -------------------------------------------------------------------------
  // new Send tab: cross-chain token list, address book, recents, unified send.
  // -------------------------------------------------------------------------

  /**
   * cross-chain coin/token list for the Send tab. supports three scopes:
   *  - `'dwallet'`: only the active dwallet's addresses (filtered by `selectedDwalletId`)
   *  - `'vault'`: only the vault keypair / fee-payer addresses
   *  - `'everything'`: vault keypair(s) + every dwallet
   */
  sendTokenList: publicProcedure
    .input(
      z.object({
        scope: z.enum(['dwallet', 'vault', 'everything']),
        selectedDwalletId: z.string().optional(),
        networkFilter: z.enum(['all', 'evm', 'sui', 'solana', 'btc', 'aptos']).optional(),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const r = await getOrComputeSendTokenList(input.scope, s.activeVaultId, {
        selectedDwalletId: input.selectedDwalletId,
        networkFilter: input.networkFilter,
      });
      return r;
    }),

  /** address book CRUD (global; chrome.storage.local). */
  addressBookList: publicProcedure.query(async () => {
    const entries = await listAddressBook();
    return { entries };
  }),
  addressBookAdd: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1),
        address: z.string().trim().min(1),
        chain: z.enum(['evm', 'sui', 'solana', 'btc', 'aptos']),
      }),
    )
    .mutation(async ({ input }) => addAddressBookEntry(input)),
  addressBookRemove: publicProcedure
    .input(z.object({ id: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      await removeAddressBookEntry(input.id);
      return { ok: true };
    }),
  addressBookRename: publicProcedure
    .input(z.object({ id: z.string().trim().min(1), name: z.string().trim().min(1) }))
    .mutation(async ({ input }) => renameAddressBookEntry(input.id, input.name)),

  /** recently sent-to addresses (populated by `sendUnified`). */
  recentRecipients: publicProcedure
    .input(
      z
        .object({
          chain: z.enum(['evm', 'sui', 'solana', 'btc', 'aptos']).optional(),
          limit: z.number().int().min(1).max(50).optional(),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const entries = await listRecentRecipients(input);
      return { entries };
    }),

  /**
   * unified send dispatcher. translates a `SendTokenRow` + amount string into the right
   * per-chain mutation. records the recipient for future "recently sent to" surfacing.
   *
   * accepted shape mirrors `SendTokenRow` but kept narrow (`z.any()` on the row would lose
   * input validation; instead we destructure the fields we actually need).
   */
  sendUnified: publicProcedure
    .input(
      z.object({
        row: z.object({
          chain: z.enum(['evm', 'sui', 'solana', 'btc', 'aptos']),
          chainId: z.number().int().positive().optional(),
          contractAddress: z.string().optional(),
          mint: z.string().optional(),
          coinType: z.string().optional(),
          decimals: z.number().int().min(0).max(36),
          symbol: z.string(),
          /**
           * when set, the asset row is owned by a dWallet's derived address (not the vault
           * keypair). signing routes through ika MPC on the source dWallet instead of the
           * local fee-payer keypair. EVM + BTC always go through ika regardless; this flag
           * specifically switches the Sui + Solana code paths.
           */
          ownerDwalletId: z.string().optional(),
        }),
        to: z.string().trim().min(1),
        amount: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const { row, to, amount } = input;
      const trimmed = to.trim();
      let txid: string;
      switch (row.chain) {
        case 'evm': {
          if (row.contractAddress) {
            // ERC-20 transfer calldata.
            const baseUnits = parseUnits(amount, row.decimals);
            const data = new Interface([
              'function transfer(address,uint256)',
            ]).encodeFunctionData('transfer', [trimmed, baseUnits]);
            txid = await signAndBroadcastEvm({
              to: row.contractAddress,
              value: '0x0',
              data,
              gas: null,
              maxFeePerGas: null,
              maxPriorityFeePerGas: null,
              gasPrice: null,
              nonce: null,
              chainId: row.chainId,
              ikaBenchContext: { source: 'wallet_send_unified_erc20' },
            });
          } else {
            // native EVM send.
            const wei = parseUnits(amount, row.decimals);
            txid = await signAndBroadcastEvm({
              to: trimmed,
              value: '0x' + wei.toString(16),
              data: '0x',
              gas: null,
              maxFeePerGas: null,
              maxPriorityFeePerGas: null,
              gasPrice: null,
              nonce: null,
              chainId: row.chainId,
              ikaBenchContext: { source: 'wallet_send_unified_native' },
            });
          }
          break;
        }
        case 'sui': {
          const isNative =
            !row.coinType || row.coinType === '0x2::sui::SUI' || row.coinType.endsWith('::sui::SUI');
          if (row.ownerDwalletId) {
            // ika MPC sign from the dWallet's Sui address.
            const coinType = isNative ? '0x2::sui::SUI' : row.coinType!;
            const baseUnits = isNative
              ? parseDecimalSuiToMist(amount)
              : parseDecimalCoinToBaseUnits(amount, row.decimals);
            if (baseUnits <= 0n) throw new Error('Amount must be positive');
            txid = await sendSuiFromDwallet(coinType, row.ownerDwalletId, trimmed, baseUnits);
          } else if (isNative) {
            const mist = parseDecimalSuiToMist(amount);
            if (mist <= 0n) throw new Error('Amount must be positive');
            txid = await sendNativeSuiTransfer(trimmed, mist);
          } else {
            const baseUnits = parseDecimalCoinToBaseUnits(amount, row.decimals);
            if (baseUnits <= 0n) throw new Error('Amount must be positive');
            txid = await sendSuiCoinTransfer(row.coinType!, trimmed, baseUnits);
          }
          break;
        }
        case 'solana': {
          if (row.ownerDwalletId) {
            // ika MPC sign from the dWallet's Solana address.
            if (!row.mint) {
              const lamports = parseDecimalSolToLamports(amount);
              if (lamports <= 0n) throw new Error('Amount must be positive');
              txid = await sendSolanaNativeFromDwallet(row.ownerDwalletId, trimmed, lamports);
            } else {
              const baseUnits = parseDecimalSplToBaseUnits(amount, row.decimals);
              if (baseUnits <= 0n) throw new Error('Amount must be positive');
              txid = await sendSolanaSplFromDwallet(row.ownerDwalletId, trimmed, row.mint, baseUnits);
            }
          } else if (!row.mint) {
            const lamports = parseDecimalSolToLamports(amount);
            if (lamports <= 0n) throw new Error('Amount must be positive');
            txid = await sendSolanaNativeTransfer(trimmed, lamports);
          } else {
            const baseUnits = parseDecimalSplToBaseUnits(amount, row.decimals);
            if (baseUnits <= 0n) throw new Error('Amount must be positive');
            txid = await sendSolanaSplTransfer(trimmed, row.mint, baseUnits);
          }
          break;
        }
        case 'btc': {
          const sats = parseDecimalBtcToSats(amount);
          if (sats <= 0n) throw new Error('Amount must be positive');
          txid = await sendBtcNativeTransfer(trimmed, amount);
          break;
        }
        case 'aptos':
          throw new Error('Aptos send coming soon - EVM, Sui, Solana, and BTC are live');
        default: {
          const _exhaustive: never = row.chain;
          throw new Error(`Unknown chain: ${String(_exhaustive)}`);
        }
      }
      // best-effort: record the recipient. failures here don't affect the send.
      try {
        await recordRecentRecipient(trimmed, row.chain as AddressBookChain);
      } catch (e) {
        console.warn('[chromatika recent-recipients] record failed', e);
      }
      return { txid };
    }),

  /**
   * recovery surface for funds the user sent to the wallet's internal user-share signing
   * keypair address (the address chromatika's UI mislabeled as "sui address (dWallet)" -
   * see `wallet-extension/src/background/identity.ts:24`).
   *
   * `inspectInternalSigningKeyAddresses` lists the 16 × {legacy, post-fix} candidate
   * addresses without RPC. cheap, lets you cross-reference against suiscan to see which
   * one(s) hold your funds.
   *
   * `probeInternalSigningKeyBalances` does the same scan but also calls `getAllBalances`
   * on each address. slower but tells you exactly which coin types and amounts are at each
   * candidate; use after `inspect` if multiple addresses look suspicious on suiscan.
   *
   * `recoverFromInternalSigningKey` signs a regular Sui transfer from the chosen candidate
   * with the reconstructed Ed25519 keypair (no ika MPC). pass `sendAll: true` to sweep the
   * coinType (leaving a small gas reserve for native SUI), or `amountBaseUnits` for an
   * explicit amount.
   */
  inspectInternalSigningKeyAddresses: publicProcedure
    .input(z.object({ maxIndex: z.number().int().min(1).max(64).default(16) }).default({ maxIndex: 16 }))
    .query(({ input }) => {
      return { candidates: listInternalSigningKeypairAddresses(input.maxIndex) };
    }),

  probeInternalSigningKeyBalances: publicProcedure
    .input(z.object({ maxIndex: z.number().int().min(1).max(64).default(16) }).default({ maxIndex: 16 }))
    .query(async ({ input }) => {
      const balances = await probeInternalSigningKeyBalances(input.maxIndex);
      return { balances };
    }),

  recoverFromInternalSigningKey: publicProcedure
    .input(
      z.object({
        legacy: z.boolean(),
        encryptionKeyIndex: z.number().int().min(0).max(64),
        to: z.string().trim().min(1),
        coinType: z.string().trim().min(1).optional(),
        amountBaseUnits: z.string().regex(/^\d+$/).optional(),
        sendAll: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await recoverFromInternalSigningKey({
        legacy: input.legacy,
        encryptionKeyIndex: input.encryptionKeyIndex,
        to: input.to,
        coinType: input.coinType,
        amountBaseUnits: input.amountBaseUnits != null ? BigInt(input.amountBaseUnits) : undefined,
        sendAll: input.sendAll,
      });
      return result;
    }),

  /**
   * one-shot diagnostic for stuck ED25519 dWallets: dumps state, derives the MPC Sui address
   * from on-chain `public_output`, reads SUI balance there, enumerates all encrypted user
   * shares on chain for the dWallet, and reports whether any share's `encryption_key_address`
   * matches one of the 32 internal-signing-key candidates we'd otherwise scan. all you need
   * to triage "where is my money / can I sign for this dWallet" in one call.
   */
  inspectDwalletForRecovery: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      return await inspectDwalletForRecovery(input.dwalletId);
    }),
};
