import { z } from 'zod';
import { Interface, parseUnits } from 'ethers';
import { captureException } from '@/background/analytics/sentry';
import { publicProcedure } from '../trpc';
import { trpcAddressParam } from '../trpc-input-schemas';
import { getSession } from '@/background/session';
import { withFriendlyIkaError } from '@/background/ika/errors';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { fetchEvmTokenBalances } from '@/background/chains/evm-tokens';
import { fetchDwalletHomeGasRows } from '@/background/chains/dwallet-home-gas';
import { fetchPortfolioRailNativeRows } from '@/background/portfolio-rail-balances';
import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import { fetchEvmFeeTiers } from '@/background/fees/evm-fee-tiers';
import { fetchSuiFeeEstimate } from '@/background/fees/sui-fee-estimate';
import { fetchSolanaFeeTiers } from '@/background/fees/solana-fee-tiers';
import { fetchBtcFeeTiers } from '@/background/fees/btc-fee-tiers';
import { estimateEvmGasAcrossRpcs } from '@/background/chains/evm-send';
import { getCustomNetworks } from '@/background/network/custom-networks';
import {
  BUILTIN_BITCOIN,
  findEvmNetwork,
  mergeEvmNetworksWithCustom,
} from '@/config/networks';
import { getPrice } from '@/background/services/price';
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
  resolveName as resolveNameForChain,
  reverseLookupName,
} from '@/background/services/name-resolver';
import { beginOperation } from '@/background/progress/operation-progress';
import {
  evaluateFirstTimeRecipient,
  getCoverage,
  countIndexedRows,
  type ActivityIndexChain,
} from '@/background/services/activity-index';
import {
  cancelIndexJob,
  isIndexJobRunning,
  startIndexJob,
} from '@/background/services/activity-index-orchestrator';
import {
  isIndexingSupported,
  resolveWalker,
} from '@/background/services/activity-index-workers/registry';
import { insertPendingTx } from '@/background/services/pending-tx-tracker';
import { startReconcilerOnDemand } from '@/background/services/pending-tx-reconciler';
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

  /** Gap 5: bump max per-chain limit to 500 so infinite-scroll can grow the merged feed
   * progressively (UI increments by 20 on each scroll-end). The per-chain fetchers are
   * still capped at 4*limit total rows in memory; 500 lets us scroll to ~2000 merged
   * rows which is generous for typical use. */
  getActivity: publicProcedure
    .input(z.object({ limit: z.number().int().min(1).max(500).optional().default(20) }))
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
      try {
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
      } catch (err) {
        captureException(err, { feature: 'send', chain: 'evm' });
        throw err;
      }
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
      try {
        const mist = parseDecimalSuiToMist(input.amountSui);
        if (mist <= 0n) throw new Error('Amount must be positive');
        const digest = await sendNativeSuiTransfer(input.to, mist);
        return { digest };
      } catch (err) {
        captureException(err, { feature: 'send', chain: 'sui' });
        throw err;
      }
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
      try {
        const lamports = parseDecimalSolToLamports(input.amountSol);
        if (lamports <= 0n) throw new Error('Amount must be positive');
        const signature = await sendSolanaNativeTransfer(input.to, lamports);
        return { signature };
      } catch (err) {
        captureException(err, { feature: 'send', chain: 'solana' });
        throw err;
      }
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
      try {
        const sats = parseDecimalBtcToSats(input.amountBtc);
        if (sats <= 0n) throw new Error('Amount must be positive');
        const txid = await sendBtcNativeTransfer(input.to, input.amountBtc);
        return { txid };
      } catch (err) {
        captureException(err, { feature: 'send', chain: 'btc' });
        throw err;
      }
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

  /**
   * tier-aware first-time-recipient check. consults the indexed activity store (when
   * present), unions coverage across all the user's addresses on this chain, and returns
   * a verdict + display copy the UI shows verbatim. NEVER claims "you've never sent here"
   * unless coverage is `'complete-to-genesis'` AND `lastSyncedAt` is recent
   * (`COVERAGE_RECENT_WINDOW_MS = 30 min`). Phase 1: works against an empty index, so
   * today this returns the `chromatika-only` tier for everyone. Phase 2 (per-chain
   * walkers) progressively upgrades the coverage status -> confident tiers light up.
   */
  firstTimeRecipientCheck: publicProcedure
    .input(
      z.object({
        chain: z.enum(['sui', 'evm', 'solana', 'btc', 'aptos']),
        counterparty: z.string().trim().min(1),
        /** perspective addresses to union coverage across. If omitted, we use every address
         * we can derive from the active vault for the chain (vault keypair / fee-payer +
         * every dWallet's derived chain addr). */
        perspectiveAddresses: z.array(z.string().trim().min(1)).optional(),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      // derive perspective addresses if the caller didn't supply them. mirrors the logic
      // in `ownAddressesForChain` so the two stay aligned. (the caller could also just
      // pass `perspectiveAddresses` itself; we accept both shapes.)
      let perspectiveAddresses = input.perspectiveAddresses;
      if (!perspectiveAddresses || perspectiveAddresses.length === 0) {
        const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
        const set = new Set<string>();
        for (const c of caps) {
          const ca = c.chainAddresses ?? {};
          switch (input.chain) {
            case 'evm':
              if (ca.evm) set.add(ca.evm.toLowerCase());
              break;
            case 'sui':
              if (ca.sui) set.add(ca.sui.toLowerCase());
              break;
            case 'solana':
              if (ca.solana) set.add(ca.solana);
              break;
            case 'btc':
              if (ca.btcP2wpkh) set.add(ca.btcP2wpkh);
              if (ca.btcP2tr) set.add(ca.btcP2tr);
              break;
            case 'aptos':
              if (ca.aptos) set.add(ca.aptos.toLowerCase());
              break;
          }
        }
        if (input.chain === 'sui') {
          try {
            set.add(s.suiKeypair.getPublicKey().toSuiAddress().toLowerCase());
          } catch { /* hw vault */ }
        }
        if (input.chain === 'solana') {
          const fpa = s.solanaFeePayer?.publicKey.toBase58();
          if (fpa) set.add(fpa);
          if (s.solanaMwaAccount?.address) set.add(s.solanaMwaAccount.address);
          if (s.solanaWcAccount?.address) set.add(s.solanaWcAccount.address);
        }
        perspectiveAddresses = [...set];
      }
      return evaluateFirstTimeRecipient({
        vaultId: s.activeVaultId,
        chain: input.chain as ActivityIndexChain,
        counterparty: input.counterparty.trim(),
        perspectiveAddresses,
      });
    }),

  /** fetch on-chain details for a single tx (block height, fee, recipient, confirmations).
   * the activity-feed row already has digest + label + counterparty (when known); this
   * adds the deeper info the TxDetailModal renders. all per-chain calls best-effort -
   * we degrade fields to null when fetches fail rather than throwing. */
  getTxDetail: publicProcedure
    .input(
      z.object({
        chain: z.enum(['sui', 'evm', 'solana', 'bitcoin']),
        digest: z.string().trim().min(1),
        /** EVM chainId hint - lets the modal fetch the receipt from the right RPC even
         * if the wallet's currently-active EVM chain differs from the tx's chain.
         * caller should pass this when known (e.g. from the indexed row's source field
         * or a pending row's pendingMeta.chainId). */
        chainId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const out: {
        toAddress: string | null;
        feeFormatted: string | null;
        feeUsd: number | null;
        blockHeight: number | null;
        confirmations: number | null;
      } = {
        toAddress: null,
        feeFormatted: null,
        feeUsd: null,
        blockHeight: null,
        confirmations: null,
      };
      try {
        if (input.chain === 'evm') {
          const { JsonRpcProvider, formatEther } = await import('ethers');
          const active = await getActiveNetworks();
          const chainId = input.chainId ?? active.evmChainId;
          const { evm: customEvm } = await getCustomNetworks();
          const net = findEvmNetwork(chainId, customEvm);
          if (net) {
            const provider = new JsonRpcProvider(net.rpcUrl);
            const [tx, receipt, head] = await Promise.all([
              provider.getTransaction(input.digest),
              provider.getTransactionReceipt(input.digest),
              provider.getBlockNumber(),
            ]);
            if (tx?.to) out.toAddress = tx.to;
            if (receipt) {
              out.blockHeight = receipt.blockNumber;
              out.confirmations = head - receipt.blockNumber + 1;
              if (receipt.gasUsed && receipt.gasPrice) {
                const feeWei = receipt.gasUsed * receipt.gasPrice;
                out.feeFormatted = `${formatEther(feeWei)} ${net.symbol}`;
                const nativeUsd = await getPrice(net.symbol).catch(() => null);
                if (nativeUsd != null && nativeUsd > 0) {
                  out.feeUsd = Number(formatEther(feeWei)) * nativeUsd;
                }
              }
            }
          }
        } else if (input.chain === 'sui') {
          // Gap 4: Sui detail via GraphQL `transaction(digest)`. Returns gasUsed +
          // checkpoint sequence (block height equivalent). Confirmations are computed
          // as `latestCheckpoint - txCheckpoint + 1`.
          const { createSuiGraphQLClientFromRegistryNetworkId } = await import(
            '@/background/sui-client'
          );
          const { getDwalletNetworkSettings } = await import(
            '@/background/network/tier-network-settings'
          );
          const dw = await getDwalletNetworkSettings(s.activeVaultId, {
            network: s.network,
            baseChain: s.activeVaultBaseChain,
          });
          const client = createSuiGraphQLClientFromRegistryNetworkId(dw.suiNetworkId);
          type SuiDetailResp = {
            data?: {
              transaction?: {
                effects?: {
                  status?: string | null;
                  checkpoint?: { sequenceNumber?: number | string | null } | null;
                  gasUsed?: {
                    computationCost?: string | null;
                    storageCost?: string | null;
                    storageRebate?: string | null;
                  } | null;
                  balanceChanges?: {
                    nodes?: Array<{
                      owner?: { address?: string | null } | null;
                      amount?: string | number | null;
                    }> | null;
                  } | null;
                } | null;
                sender?: { address?: string | null } | null;
              } | null;
              checkpoint?: { sequenceNumber?: number | string | null } | null;
            };
          };
          const res = (await (
            client as unknown as {
              query: (opts: { query: string; variables: Record<string, unknown> }) => Promise<SuiDetailResp>;
            }
          ).query({
            query: `query ChromatikaSuiTxDetail($digest: String!) {
              transaction(digest: $digest) {
                sender { address }
                effects {
                  status
                  checkpoint { sequenceNumber }
                  gasUsed { computationCost storageCost storageRebate }
                  balanceChanges(first: 30) { nodes { owner { address } amount } }
                }
              }
              checkpoint { sequenceNumber }
            }`,
            variables: { digest: input.digest },
          })) as SuiDetailResp;
          const node = res.data?.transaction;
          const cp = node?.effects?.checkpoint?.sequenceNumber;
          const tipCp = res.data?.checkpoint?.sequenceNumber;
          if (cp != null) out.blockHeight = Number(cp);
          if (tipCp != null && cp != null) {
            out.confirmations = Math.max(0, Number(tipCp) - Number(cp) + 1);
          }
          // recipient = largest positive balanceChange owner != sender.
          const sender = node?.sender?.address?.toLowerCase() ?? null;
          let bestRecipient: string | null = null;
          let bestAmount = 0n;
          for (const bc of node?.effects?.balanceChanges?.nodes ?? []) {
            const owner = bc.owner?.address;
            if (!owner) continue;
            if (sender && owner.toLowerCase() === sender) continue;
            try {
              const amt = BigInt(typeof bc.amount === 'number' ? Math.trunc(bc.amount) : (bc.amount ?? '0'));
              if (amt > bestAmount) {
                bestAmount = amt;
                bestRecipient = owner;
              }
            } catch {
              /* skip malformed */
            }
          }
          if (bestRecipient) out.toAddress = bestRecipient;
          // gas fee in MIST: computation + storage - rebate (clamped at 0). format SUI.
          const gu = node?.effects?.gasUsed;
          if (gu) {
            try {
              const comp = BigInt(gu.computationCost ?? '0');
              const store = BigInt(gu.storageCost ?? '0');
              const rebate = BigInt(gu.storageRebate ?? '0');
              const net = comp + store - rebate;
              const feeMist = net > 0n ? net : comp;
              const sui = Number(feeMist) / 1e9;
              out.feeFormatted = `${sui.toFixed(6).replace(/\.?0+$/, '')} SUI`;
              const suiUsd = await getPrice('SUI').catch(() => null);
              if (suiUsd != null && suiUsd > 0) out.feeUsd = sui * suiUsd;
            } catch {
              /* malformed gas fields - leave fee null */
            }
          }
        } else if (input.chain === 'solana') {
          // Gap 4: Solana detail via `getTransaction`. Fee is on `meta.fee` (lamports);
          // recipient/balance changes derived from preBalances/postBalances diff.
          const { Connection } = await import('@solana/web3.js');
          const { resolveSolanaRpcUrl, getDwalletNetworkSettings } = await import(
            '@/background/network/tier-network-settings'
          );
          const dw = await getDwalletNetworkSettings(s.activeVaultId, {
            network: s.network,
            baseChain: s.activeVaultBaseChain,
          });
          const conn = new Connection(resolveSolanaRpcUrl(dw.solana), dw.solana.commitment);
          const tx = await conn.getTransaction(input.digest, {
            maxSupportedTransactionVersion: 0,
          });
          if (tx) {
            out.blockHeight = tx.slot ?? null;
            const slotHead = await conn.getSlot().catch(() => null);
            if (slotHead != null && tx.slot != null) {
              out.confirmations = Math.max(0, slotHead - tx.slot + 1);
            }
            const feeLamports = tx.meta?.fee ?? null;
            if (feeLamports != null) {
              const sol = feeLamports / 1e9;
              out.feeFormatted = `${sol.toFixed(7).replace(/\.?0+$/, '')} SOL`;
              const solUsd = await getPrice('SOL').catch(() => null);
              if (solUsd != null && solUsd > 0) out.feeUsd = sol * solUsd;
            }
            // recipient: account key with the largest positive (postBalance - preBalance)
            // delta that isn't the sender (the first writable signer).
            const accountKeys = tx.transaction.message.getAccountKeys();
            const pre = tx.meta?.preBalances ?? [];
            const post = tx.meta?.postBalances ?? [];
            let bestIdx = -1;
            let bestDelta = 0;
            for (let i = 1; i < accountKeys.length; i++) {
              const d = (post[i] ?? 0) - (pre[i] ?? 0);
              if (d > bestDelta) {
                bestDelta = d;
                bestIdx = i;
              }
            }
            if (bestIdx >= 0) {
              try {
                out.toAddress = accountKeys.get(bestIdx)?.toBase58() ?? null;
              } catch {
                /* malformed key set - leave to null */
              }
            }
          }
        } else if (input.chain === 'bitcoin') {
          // Gap 4: BTC detail via Esplora. /tx/:txid returns vin/vout + fee (sats);
          // confirmations from /tx/:txid/status against /blocks/tip/height.
          const { getDwalletNetworkSettings } = await import(
            '@/background/network/tier-network-settings'
          );
          const dw = await getDwalletNetworkSettings(s.activeVaultId, {
            network: s.network,
            baseChain: s.activeVaultBaseChain,
          });
          const btcNet =
            BUILTIN_BITCOIN.find((n) => n.id === dw.btcNetworkId) ?? BUILTIN_BITCOIN[0];
          const esploraBase = btcNet!.esploraUrl.replace(/\/$/, '');
          const [txRes, tipRes] = await Promise.all([
            fetch(`${esploraBase}/tx/${encodeURIComponent(input.digest)}`, {
              signal: AbortSignal.timeout(8000),
            }),
            fetch(`${esploraBase}/blocks/tip/height`, { signal: AbortSignal.timeout(8000) }),
          ]);
          if (txRes.ok) {
            const j = (await txRes.json()) as {
              fee?: number;
              status?: { confirmed?: boolean; block_height?: number };
              vin?: Array<{ prevout?: { scriptpubkey_address?: string | null } | null }>;
              vout?: Array<{ scriptpubkey_address?: string | null; value?: number }>;
            };
            if (j.status?.block_height != null) out.blockHeight = j.status.block_height;
            if (j.fee != null) {
              const btcFee = j.fee / 1e8;
              out.feeFormatted = `${btcFee.toFixed(8).replace(/\.?0+$/, '')} BTC`;
              const btcUsd = await getPrice('BTC').catch(() => null);
              if (btcUsd != null && btcUsd > 0) out.feeUsd = btcFee * btcUsd;
            }
            if (tipRes.ok) {
              const tipText = await tipRes.text();
              const tip = Number(tipText);
              if (Number.isFinite(tip) && out.blockHeight != null) {
                out.confirmations = Math.max(0, tip - out.blockHeight + 1);
              }
            }
            // recipient: largest non-change output (excluded any address that also appears
            // in the inputs - that's the change output).
            const senderSet = new Set<string>();
            for (const v of j.vin ?? []) {
              const a = v.prevout?.scriptpubkey_address;
              if (a) senderSet.add(a);
            }
            let bestAddr: string | null = null;
            let bestSats = 0;
            for (const v of j.vout ?? []) {
              const a = v.scriptpubkey_address;
              if (!a || senderSet.has(a)) continue;
              const sats = v.value ?? 0;
              if (sats > bestSats) {
                bestSats = sats;
                bestAddr = a;
              }
            }
            if (bestAddr) out.toAddress = bestAddr;
          }
        }
      } catch (e) {
        console.warn('[getTxDetail] fetch failed', { chain: input.chain, error: e instanceof Error ? e.message : String(e) });
      }
      return out;
    }),

  /** on-click reclassify for Solana rows that the walker left as kind: 'unknown'. The
   * walker only lazy-fetches `getParsedTransaction` for the top N rows of each page;
   * older rows stay unknown until the user shows interest by opening the detail modal.
   * this procedure does the deferred fetch + writes the classified result back to IDB
   * so the next merge picks it up via the indexed-row overlay. */
  reclassifySolanaTx: publicProcedure
    .input(z.object({ digest: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const { getIndexedTx, recordIndexedTxs, makeTxKey } = await import(
        '@/background/services/activity-index'
      );
      const key = makeTxKey('solana', s.activeVaultId, input.digest);
      const existing = await getIndexedTx(key);
      if (!existing) return { reclassified: false as const, reason: 'row not indexed yet' };
      if (existing.kind && existing.kind !== 'unknown') {
        return { reclassified: false as const, reason: 'already classified' };
      }
      try {
        const { Connection } = await import('@solana/web3.js');
        const { resolveSolanaRpcUrl, getDwalletNetworkSettings } = await import(
          '@/background/network/tier-network-settings'
        );
        const { classifySolanaTx } = await import(
          '@/background/services/activity-classifier/solana-classifier'
        );
        const dw = await getDwalletNetworkSettings(s.activeVaultId, {
          network: s.network,
          baseChain: s.activeVaultBaseChain,
        });
        const conn = new Connection(resolveSolanaRpcUrl(dw.solana), dw.solana.commitment);
        const parsed = await conn.getTransaction(input.digest, {
          maxSupportedTransactionVersion: 0,
        });
        if (!parsed) return { reclassified: false as const, reason: 'tx not found' };
        const { kind, memo } = classifySolanaTx(parsed as unknown as Parameters<typeof classifySolanaTx>[0]);
        await recordIndexedTxs([{ ...existing, kind, memo: memo ?? existing.memo ?? null }]);
        return { reclassified: true as const, kind, memo: memo ?? null };
      } catch (e) {
        return { reclassified: false as const, reason: e instanceof Error ? e.message : String(e) };
      }
    }),

  /** read the coverage state for one (chain, address). The UI uses this on the Activity
   * page to render the "Index history" affordance with accurate status / row counts. */
  activityIndexCoverage: publicProcedure
    .input(
      z.object({
        chain: z.enum(['sui', 'evm', 'solana', 'btc', 'aptos']),
        address: z.string().trim().min(1),
        chainId: z.number().int().positive().optional(),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const coverage = await getCoverage(
        s.activeVaultId,
        input.chain as ActivityIndexChain,
        input.address,
      );
      const rowCount = await countIndexedRows(
        s.activeVaultId,
        input.chain as ActivityIndexChain,
        input.address,
      );
      const indexingSupported = isIndexingSupported({
        chain: input.chain as ActivityIndexChain,
        chainId: input.chainId,
      });
      const isRunning = isIndexJobRunning(
        s.activeVaultId,
        input.chain as ActivityIndexChain,
        input.address,
      );
      return { coverage, rowCount, indexingSupported, isRunning };
    }),

  /** kick off an index job for one (chain, address). idempotent: a second call while a
   * job is already running short-circuits to `'already-running'` instead of spawning a
   * second walker. tRPC returns immediately; the walker runs as a fire-and-forget bg job
   * and reports progress via the operation-progress channel
   * (`OperationProgressBanner` picks it up). UI polls `activityIndexCoverage` for the
   * final status. */
  startActivityIndex: publicProcedure
    .input(
      z.object({
        chain: z.enum(['sui', 'evm', 'solana', 'btc', 'aptos']),
        address: z.string().trim().min(1),
        chainId: z.number().int().positive().optional(),
        /** safety cap on pages walked before forcing a pause. default 200 ~= 10k-100k
         * txs depending on per-page size. user can re-trigger from the UI to resume. */
        maxPages: z.number().int().min(1).max(2000).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const walker = resolveWalker({
        chain: input.chain as ActivityIndexChain,
        chainId: input.chainId,
      });
      if (!walker) {
        throw new Error(
          input.chain === 'evm'
            ? 'EVM indexing requires VITE_ALCHEMY_KEY and a supported chain (mainnet, arbitrum, optimism, base, polygon).'
            : input.chain === 'aptos'
              ? 'Aptos indexing is not implemented in this build.'
              : `No walker for chain ${input.chain}`,
        );
      }
      return startIndexJob({
        walker,
        vaultId: s.activeVaultId,
        address: input.address,
        maxPages: input.maxPages,
      });
    }),

  /** request cancellation of an in-flight index job. workers check between pages, so
   * cancellation lands at the next page boundary (usually within a couple seconds). */
  cancelActivityIndex: publicProcedure
    .input(
      z.object({
        chain: z.enum(['sui', 'evm', 'solana', 'btc', 'aptos']),
        address: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      return cancelIndexJob(
        s.activeVaultId,
        input.chain as ActivityIndexChain,
        input.address,
      );
    }),

  /** list every (chain, address) tuple the user can pick from the "Index history"
   * dropdown on the Activity page. combines:
   *   - vault keypair addresses (Sui base: suiKeypair; Solana base: feePayer + MWA/WC)
   *   - dWallet-derived chain addresses for every cap on the active vault
   * each entry includes the coverage record so the UI can render badges without N
   * follow-up tRPC calls. */
  listVaultIndexTargets: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));

    type Target = {
      chain: ActivityIndexChain;
      address: string;
      label: string;
      chainId?: number;
      indexingSupported: boolean;
    };
    const targets: Target[] = [];

    function add(t: Target) {
      targets.push(t);
    }

    // vault keypair addresses (Sui base + Solana base fee-payer + hardware accounts).
    if (s.activeVaultBaseChain === 'sui') {
      try {
        const suiAddr = s.suiKeypair.getPublicKey().toSuiAddress();
        add({
          chain: 'sui',
          address: suiAddr.toLowerCase(),
          label: 'Vault keypair (Sui)',
          indexingSupported: isIndexingSupported({ chain: 'sui' }),
        });
      } catch {
        /* hw vault may not expose a keypair */
      }
    }
    if (s.solanaFeePayer?.publicKey) {
      add({
        chain: 'solana',
        address: s.solanaFeePayer.publicKey.toBase58(),
        label: 'Vault fee-payer (Solana, gRPC)',
        indexingSupported: isIndexingSupported({ chain: 'solana' }),
      });
    }
    if (s.solanaMwaAccount?.address) {
      add({
        chain: 'solana',
        address: s.solanaMwaAccount.address,
        label: 'Vault (hardware via MWA)',
        indexingSupported: isIndexingSupported({ chain: 'solana' }),
      });
    }
    if (s.solanaWcAccount?.address) {
      add({
        chain: 'solana',
        address: s.solanaWcAccount.address,
        label: 'Vault (hardware via WalletConnect)',
        indexingSupported: isIndexingSupported({ chain: 'solana' }),
      });
    }

    // dWallet derived addresses (per cap, per chain that cap exposes).
    const { evmChainId } = await getActiveNetworks();
    for (const c of caps) {
      const ca = c.chainAddresses ?? {};
      const dwName = c.dwalletId.slice(0, 8);
      const labelSuffix = `dWallet ${dwName}…`;
      if (ca.evm) {
        add({
          chain: 'evm',
          address: ca.evm.toLowerCase(),
          label: `${labelSuffix} (EVM)`,
          chainId: evmChainId,
          indexingSupported: isIndexingSupported({ chain: 'evm', chainId: evmChainId }),
        });
      }
      if (ca.sui) {
        add({
          chain: 'sui',
          address: ca.sui.toLowerCase(),
          label: `${labelSuffix} (Sui)`,
          indexingSupported: isIndexingSupported({ chain: 'sui' }),
        });
      }
      if (ca.solana) {
        add({
          chain: 'solana',
          address: ca.solana,
          label: `${labelSuffix} (Solana)`,
          indexingSupported: isIndexingSupported({ chain: 'solana' }),
        });
      }
      if (ca.btcP2wpkh) {
        add({
          chain: 'btc',
          address: ca.btcP2wpkh,
          label: `${labelSuffix} (BTC segwit)`,
          indexingSupported: isIndexingSupported({ chain: 'btc' }),
        });
      }
      if (ca.btcP2tr) {
        add({
          chain: 'btc',
          address: ca.btcP2tr,
          label: `${labelSuffix} (BTC taproot)`,
          indexingSupported: isIndexingSupported({ chain: 'btc' }),
        });
      }
      if (ca.aptos) {
        add({
          chain: 'aptos',
          address: ca.aptos.toLowerCase(),
          label: `${labelSuffix} (Aptos)`,
          indexingSupported: isIndexingSupported({ chain: 'aptos' }),
        });
      }
    }

    // overlay coverage + running status onto each target.
    const enriched = await Promise.all(
      targets.map(async (t) => {
        const coverage = await getCoverage(s.activeVaultId, t.chain, t.address);
        const rowCount = await countIndexedRows(s.activeVaultId, t.chain, t.address);
        const isRunning = isIndexJobRunning(s.activeVaultId, t.chain, t.address);
        return { ...t, coverage, rowCount, isRunning };
      }),
    );

    return { targets: enriched };
  }),

  /** every "own address" for a chain, used by the Confirm step's self-send detection.
   * combines vault fee-payer addresses + every dWallet's derived chain address. case-
   * insensitive comparison is the caller's job (EVM addresses ship lower-cased here). */
  ownAddressesForChain: publicProcedure
    .input(z.object({ chain: z.enum(['evm', 'sui', 'solana', 'btc', 'aptos']) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
      const out = new Set<string>();
      for (const c of caps) {
        const ca = c.chainAddresses ?? {};
        switch (input.chain) {
          case 'evm':
            if (ca.evm) out.add(ca.evm.toLowerCase());
            break;
          case 'sui':
            if (ca.sui) out.add(ca.sui.toLowerCase());
            break;
          case 'solana':
            if (ca.solana) out.add(ca.solana);
            break;
          case 'btc':
            if (ca.btcP2wpkh) out.add(ca.btcP2wpkh);
            if (ca.btcP2tr) out.add(ca.btcP2tr);
            break;
          case 'aptos':
            if (ca.aptos) out.add(ca.aptos.toLowerCase());
            break;
        }
      }
      // vault-level fee-payer addresses (not dWallet-derived).
      if (input.chain === 'sui') {
        try {
          const vaultSuiAddr = s.suiKeypair.getPublicKey().toSuiAddress();
          out.add(vaultSuiAddr.toLowerCase());
        } catch {
          /* hardware Sui vault may not expose a keypair */
        }
      }
      if (input.chain === 'solana') {
        const fpa = s.solanaFeePayer?.publicKey.toBase58();
        if (fpa) out.add(fpa);
        const mwa = s.solanaMwaAccount?.address;
        if (mwa) out.add(mwa);
        const wc = s.solanaWcAccount?.address;
        if (wc) out.add(wc);
      }
      return { addresses: [...out] };
    }),

  /** forward name resolution for the recipient field. SuiNS / ENS / SNS / Aptos Names.
   * returns null when nothing resolves. caller should debounce keystrokes (~500ms) before
   * invoking, otherwise upstream rate limits kick in fast. cached in-memory for 5 min. */
  resolveName: publicProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(120),
        chain: z.enum(['sui', 'evm', 'sol', 'apt']),
      }),
    )
    .query(async ({ input }) => {
      return resolveNameForChain(input.name, input.chain);
    }),

  /** address -> name reverse lookup. used by TxDetailModal to render verified-name pills
   * next to counterparty addresses. cached 5 min in memory; nulls cached too so we
   * don't repeatedly hit upstreams for known-unresolvable addresses. */
  reverseLookupName: publicProcedure
    .input(
      z.object({
        address: z.string().trim().min(1).max(200),
        chain: z.enum(['sui', 'evm', 'sol', 'apt']),
      }),
    )
    .query(async ({ input }) => {
      return reverseLookupName(input.address, input.chain);
    }),

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
   * read-only fee preview for the Confirm step. dispatches to the per-chain fee helpers and
   * returns the Slow/Normal/Fast triple in a unified shape the FeeTierPicker can render.
   *
   * Sui returns the same value in all three slots (`supportsTiers: false`) because Sui's
   * reference gas price is network-wide for the epoch; there is no real tiering. EVM /
   * Solana / BTC support real tiering via `eth_feeHistory` / `getRecentPrioritizationFees`
   * / Esplora's `/fee-estimates` respectively.
   *
   * does NOT block the send if it fails - the UI shows a small "estimate unavailable" line
   * and the send proceeds using each chain's default fee logic (current behavior).
   */
  estimateSendFee: publicProcedure
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
          ownerAddress: z.string().trim().min(1),
          ownerDwalletId: z.string().optional(),
        }),
        to: z.string().trim().min(1),
        amount: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const { row, to, amount } = input;

      switch (row.chain) {
        case 'evm': {
          const chainId = row.chainId ?? (await getActiveNetworks()).evmChainId;
          const { evm: customEvm } = await getCustomNetworks();
          const merged = mergeEvmNetworksWithCustom(customEvm);
          const net = findEvmNetwork(chainId, customEvm);
          if (!net) throw new Error(`Unknown EVM chainId ${chainId}`);
          // gas units: estimate the actual call (transfer vs ERC-20 transfer calldata).
          let gasLimit = 21_000n;
          try {
            const isErc20 = Boolean(row.contractAddress);
            if (isErc20) {
              const baseUnits = parseUnits(amount, row.decimals);
              const data = new Interface([
                'function transfer(address,uint256)',
              ]).encodeFunctionData('transfer', [to.trim(), baseUnits]);
              const est = await estimateEvmGasAcrossRpcs(chainId, net.rpcUrl, {
                from: row.ownerAddress,
                to: row.contractAddress!,
                value: 0n,
                data,
              });
              if (est.gas != null && est.gas > 0n) gasLimit = est.gas;
              else gasLimit = 80_000n; // sensible ERC-20 transfer fallback
            } else {
              const wei = parseUnits(amount, row.decimals);
              const est = await estimateEvmGasAcrossRpcs(chainId, net.rpcUrl, {
                from: row.ownerAddress,
                to: to.trim(),
                value: wei,
                data: '0x',
              });
              if (est.gas != null && est.gas > 0n) gasLimit = est.gas;
            }
          } catch (e) {
            console.warn('[estimateSendFee] EVM gas estimate failed; falling back', e);
          }
          const nativeUsd = await getPrice(net.symbol).catch(() => null);
          const tiers = await fetchEvmFeeTiers(
            chainId,
            net.rpcUrl,
            gasLimit,
            net.symbol,
            net.decimals,
            nativeUsd,
          );
          void merged; // (kept import live for future per-tier display)
          return { kind: 'evm' as const, supportsTiers: true, ...tiers };
        }
        case 'sui': {
          const suiUsd = await getPrice('SUI').catch(() => null);
          const est = await fetchSuiFeeEstimate(s.suiClient, suiUsd);
          // for parity with the tiered shape, repeat the same value in all three slots and
          // flip `supportsTiers: false` so the UI renders one line.
          const single = {
            tier: 'normal' as const,
            totalFormatted: est.totalFormatted,
            totalUsd: est.totalUsd,
          };
          return {
            kind: 'sui' as const,
            supportsTiers: false,
            fromRealData: true,
            symbol: 'SUI',
            decimals: 9,
            slow: { ...single, tier: 'slow' as const, totalMist: est.totalMist },
            normal: { ...single, tier: 'normal' as const, totalMist: est.totalMist },
            fast: { ...single, tier: 'fast' as const, totalMist: est.totalMist },
          };
        }
        case 'solana': {
          const conn = s.dwalletSolanaConnection ?? s.solanaConnection;
          if (!conn) throw new Error('Solana RPC not configured.');
          const solUsd = await getPrice('SOL').catch(() => null);
          // 200k CU default; SPL transfers + ATA creation can hit 300k+, so use 300k for SPL.
          const cu = row.mint ? 300_000n : 200_000n;
          // SPL ATA creation may add a 2nd signature; assume 1 for vanilla path.
          const tiers = await fetchSolanaFeeTiers(conn, cu, 1, solUsd);
          return { kind: 'solana' as const, supportsTiers: true, symbol: 'SOL', decimals: 9, ...tiers };
        }
        case 'btc': {
          const btcUsd = await getPrice('BTC').catch(() => null);
          const active = await getActiveNetworks();
          const btcNet =
            BUILTIN_BITCOIN.find((n) => n.id === active.btcNetworkId) ?? BUILTIN_BITCOIN[0];
          // conservative vbytes for a 1-input, 2-output P2WPKH send (1 segwit input ~68 vbytes;
          // 2 P2WPKH outputs ~62 vbytes; overhead ~10 vbytes -> ~140 vbytes total).
          const vbytes = 200n;
          const tiers = await fetchBtcFeeTiers(btcNet!.esploraUrl, vbytes, btcUsd);
          return { kind: 'btc' as const, supportsTiers: true, symbol: 'BTC', decimals: 8, ...tiers };
        }
        case 'aptos':
          throw new Error('Aptos send fee estimation not implemented (send is stubbed)');
        default: {
          const _exhaustive: never = row.chain;
          throw new Error(`Unknown chain: ${String(_exhaustive)}`);
        }
      }
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
        /** optional memo / note, only honored on chains with a first-class memo primitive
         * (Solana via Memo Program). hidden on chains without one - this server still accepts
         * the field but ignores it for unsupported chains so the UI doesn't have to branch. */
        memo: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { row, to, amount, memo } = input;
      const trimmed = to.trim();
      // Bucket D: surface live send phases via the operation-progress channel so the
      // StatusStep can show "Preparing -> Signing -> Broadcasting -> Confirmed" instead
      // of a binary spinner. chain-specific helpers (signAndBroadcastEvm, send*FromDwallet)
      // also push their own updates via `setSigningProgress` / `updateCurrentOperationStage`;
      // those finer-grained labels appear inline as the SW progresses.
      const op = await beginOperation(`Send ${row.symbol} on ${row.chain.toUpperCase()}`);
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      let txid: string;
      try {
        await op.updateStage('prepare', 'Preparing transaction…');
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
      await op.succeed(`Sent ${row.symbol} (${txid.slice(0, 12)}…)`);
      // best-effort: record the recipient. failures here don't affect the send.
      try {
        await recordRecentRecipient(trimmed, row.chain as AddressBookChain);
      } catch (e) {
        console.warn('[chromatika recent-recipients] record failed', e);
      }
      // Bucket A: insert an optimistic pending row in the activity index so the user sees
      // the tx immediately at the top of the Activity tab + the reconciler flips it to
      // success/failure when the chain settles. all best-effort - even if this throws,
      // the send already succeeded and the explorer-fetched row will appear eventually.
      try {
        // derive the sender's address for this send. when ownerDwalletId is set, look up
        // that dWallet's chainAddresses; otherwise use the vault-level address
        // (suiKeypair for sui, fee-payer / MWA / WC for solana). EVM + BTC always go
        // through ika MPC from a dWallet, so there's no vault-level fallback for them.
        let perspectiveAddress: string | null = null;
        if (row.ownerDwalletId) {
          const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
          const cap = caps.find((c) => c.dwalletId === row.ownerDwalletId);
          const ca = cap?.chainAddresses ?? null;
          if (ca) {
            if (row.chain === 'evm') perspectiveAddress = ca.evm ?? null;
            else if (row.chain === 'sui') perspectiveAddress = ca.sui ?? null;
            else if (row.chain === 'solana') perspectiveAddress = ca.solana ?? null;
            else if (row.chain === 'btc') perspectiveAddress = ca.btcP2wpkh ?? ca.btcP2tr ?? null;
            else if (row.chain === 'aptos') perspectiveAddress = ca.aptos ?? null;
          }
        }
        if (!perspectiveAddress) {
          if (row.chain === 'sui') {
            try { perspectiveAddress = s.suiKeypair.getPublicKey().toSuiAddress(); } catch { /* hw vault */ }
          } else if (row.chain === 'solana') {
            perspectiveAddress =
              s.solanaFeePayer?.publicKey.toBase58() ??
              s.solanaMwaAccount?.address ??
              s.solanaWcAccount?.address ??
              null;
          }
        }
        if (perspectiveAddress) {
          await insertPendingTx({
            vaultId: s.activeVaultId,
            chain: row.chain as ActivityIndexChain,
            digest: txid,
            perspectiveAddress,
            counterparty: trimmed,
            // sendUnified only handles plain transfers; NFT / swap go through dedicated
            // flows that should insert their own pending rows. classifier reclassifies
            // when the walker picks it up later anyway.
            kind: 'transfer',
            symbol: row.symbol,
            amountRaw: null, // we have the decimal amount; base-units conversion happens per-chain above
            broadcastAtMs: Date.now(),
            memo: memo ?? null,
            // EVM-only field; reconciler uses it to poll the right RPC. derived from
            // `row.chainId` (sendUnified's input) which the SendPage populated from the
            // selected token row. ignored for non-EVM chains.
            chainId: row.chain === 'evm' ? row.chainId : undefined,
            // sendUnified is wallet-UI-initiated; origin stays null. dapp-bridge sends
            // bypass this code path (they use `enqueueTxApproval` -> approval popup ->
            // `signAndBroadcastEvm`), and their origin is captured by `tx-record`.
            origin: null,
          });
          startReconcilerOnDemand(s.activeVaultId);
        }
      } catch (e) {
        console.warn('[pending-tx] optimistic insert failed (non-blocking)', e);
      }
      return { txid };
      } catch (e) {
        await op.fail(e instanceof Error ? e.message : String(e));
        throw e;
      }
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
