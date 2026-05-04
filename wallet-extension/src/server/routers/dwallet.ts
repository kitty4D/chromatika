import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  acceptEncryptedUserShareForCurve,
  acceptTransferredDWallet,
  createDWalletForCurve,
  getDWalletState,
  getSenderEncryptionKeyAddress,
  parseTransferTxEncryptedShareHints,
  registerEncryptionKeyOnChain,
  transferDWallet,
} from '@/background/ika/dwallet-lifecycle';
import {
  discoverDWalletsForVault,
  listOwnedDWalletCapsForVault,
} from '@/background/ika/dwallet-discovery';
import {
  getChromaLabRefs,
  getSolanaDwalletDetail,
  getSolanaProgramRecentOverview,
  getSuiDwalletDetail,
  getSuiExplorerOverview,
} from '@/background/ika/explorer';
import { withFriendlyIkaError } from '@/background/ika/errors';
import {
  buildAndExecuteAddStake,
  buildAndExecuteWithdrawStake,
  listIkaValidatorsForSession,
  listStakedIkaForSession,
} from '@/background/ika/ika-staking';
import { getPresignPoolStatus, replenishPool } from '@/background/ika/presign-pool';
import { signMessageBtc, signMessageEvm, signMessageSol } from '@/background/chains/signing';
import { getBitcoinAddresses } from '@/background/chains/bitcoin';
import { getSolanaAddress } from '@/background/chains/solana';
import { getAptosAddress, signMessageAptos } from '@/background/chains/aptos';
import { getEvmAddress } from '@/background/chains/evm';
import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import { getSession } from '@/background/session';
import { getActiveVaultId } from '@/background/wallet-service';
import { saveDwalletMeta } from '@/background/storage-meta';
import {
  loadDwalletCardOrder,
  saveDwalletCardOrder,
} from '@/background/dwallet-card-order-storage';
import {
  getDwalletDisplayNameMap,
  setDwalletDisplayNameForVault,
} from '@/background/dwallet-display-names-storage';

export const dwalletProcedures = {
  registerEncryptionKey: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(({ input }) => withFriendlyIkaError(() => registerEncryptionKeyOnChain(input.curve))),

  createDWallet: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(({ input }) => withFriendlyIkaError(() => createDWalletForCurve(input.curve))),

  completeDWalletZeroTrust: publicProcedure
    .input(
      z.object({
        curve: z.enum(['SECP256K1', 'ED25519']),
        /** pin completion to this dWallet when multiple caps need zero-trust on the same curve. */
        dwalletId: z.string().trim().min(1).optional(),
      }),
    )
    .mutation(({ input }) =>
      withFriendlyIkaError(() =>
        acceptEncryptedUserShareForCurve(input.curve, input.dwalletId ? { dwalletId: input.dwalletId } : undefined),
      ),
    ),

  dWalletState: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .query(({ input }) => withFriendlyIkaError(() => getDWalletState(input.curve))),

  /** same as `dWalletState`, explicit name for "re-fetch from chain". */
  refreshDWalletState: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .query(({ input }) => withFriendlyIkaError(() => getDWalletState(input.curve))),

  discoverDWallets: publicProcedure
    .input(z.object({ curve: z.enum(['SECP256K1', 'ED25519']) }))
    .mutation(async ({ input }) => {
      const vid = getActiveVaultId();
      if (!vid) throw new Error('Wallet locked');
      return withFriendlyIkaError(() => discoverDWalletsForVault(vid, input.curve));
    }),

  listOwnedDWalletCaps: publicProcedure.query(async () => {
    const vid = getActiveVaultId();
    if (!vid) throw new Error('Wallet locked');
    return withFriendlyIkaError(() => listOwnedDWalletCapsForVault(vid));
  }),

  getChromaLabRefs: publicProcedure.query(() => withFriendlyIkaError(() => getChromaLabRefs())),

  getSuiExplorerOverview: publicProcedure
    .input(z.object({ limit: z.number().int().min(10).max(80).default(40) }).optional())
    .query(({ input }) => withFriendlyIkaError(() => getSuiExplorerOverview(input?.limit ?? 40))),

  getSuiExplorerDwalletDetail: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().startsWith('0x').min(10) }))
    .query(({ input }) => withFriendlyIkaError(() => getSuiDwalletDetail(input.dwalletId))),

  getSolanaProgramRecentOverview: publicProcedure
    .input(z.object({ limit: z.number().int().min(5).max(40).default(12) }).optional())
    .query(({ input }) => getSolanaProgramRecentOverview(input?.limit ?? 12)),

  getSolanaExplorerDwalletDetail: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().min(32) }))
    .query(({ input }) => getSolanaDwalletDetail(input.dwalletId)),

  /** set session + persisted meta so signing and address book use this dWallet for its curve. */
  setActiveDwallet: publicProcedure
    .input(z.object({ dwalletId: z.string().trim().min(1) }))
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const vaultId = getActiveVaultId();
      if (!vaultId) throw new Error('Wallet locked');
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(vaultId));
      const cap = caps.find((c) => c.dwalletId === input.dwalletId);
      if (!cap) throw new Error('dWallet not found on this vault');
      const curve = cap.curve;
      if (curve !== 'SECP256K1' && curve !== 'ED25519') {
        throw new Error('dWallet curve not supported for active meta');
      }
      s.dwalletMeta[curve] = {
        baseChain: s.dwalletMeta[curve]?.baseChain ?? 'sui',
        ...s.dwalletMeta[curve],
        dwalletId: input.dwalletId,
      };
      await saveDwalletMeta(vaultId, s.dwalletMeta);
      return { ok: true as const };
    }),

  /** custom display names for dWallet ids in the active vault (chrome.storage). */
  getDwalletDisplayNames: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const names = await getDwalletDisplayNameMap(s.activeVaultId);
    return { names };
  }),

  setDwalletDisplayName: publicProcedure
    .input(
      z.object({
        dwalletId: z.string().trim().min(1),
        name: z.string().max(64),
      }),
    )
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      await setDwalletDisplayNameForVault(s.activeVaultId, input.dwalletId, input.name);
      return { ok: true as const };
    }),

  getDwalletCardOrder: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    return { orderedIds: await loadDwalletCardOrder(s.activeVaultId) };
  }),

  setDwalletCardOrder: publicProcedure
    .input(z.object({ orderedIds: z.array(z.string().trim().min(1)) }))
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const vid = s.activeVaultId;
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(vid));
      const deck = caps.filter(
        (c) =>
          c.dwalletId !== 'unknown' &&
          (c.curve === 'SECP256K1' || c.curve === 'ED25519') &&
          !c.needsZeroTrustCompletion,
      );
      const allowed = new Set(deck.map((c) => c.dwalletId));
      const seen = new Set<string>();
      const next: string[] = [];
      for (const id of input.orderedIds) {
        if (!allowed.has(id) || seen.has(id)) continue;
        next.push(id);
        seen.add(id);
      }
      for (const c of [...deck].sort((a, b) => a.dwalletId.localeCompare(b.dwalletId))) {
        if (!seen.has(c.dwalletId)) next.push(c.dwalletId);
      }
      await saveDwalletCardOrder(vid, next);
      return { ok: true as const, orderedIds: next };
    }),

  /** addresses for the meta-selected dWallet per curve (same ids signing uses). derived from on-chain `public_output` when present (Active or awaiting key holder), not gated on ika status for display. */
  dwalletAddressBook: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const vaultId = getActiveVaultId();
    if (!vaultId) throw new Error('Wallet locked');
    const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(vaultId));
    const secpFallback = caps.find((r) => r.curve === 'SECP256K1' && r.dwalletId !== 'unknown');
    const edFallback = caps.find((r) => r.curve === 'ED25519' && r.dwalletId !== 'unknown');

    const secpId = s.dwalletMeta.SECP256K1?.dwalletId ?? secpFallback?.dwalletId ?? null;
    const edId = s.dwalletMeta.ED25519?.dwalletId ?? edFallback?.dwalletId ?? null;

    const result: {
      SECP256K1: {
        dwalletId: string | null;
        status: string | null;
        supports: string[];
        addresses: { evm?: string; btcP2wpkh?: string; btcP2tr?: string };
      };
      ED25519: {
        dwalletId: string | null;
        status: string | null;
        supports: string[];
        addresses: { sui?: string; solana?: string; aptos?: string };
      };
    } = {
      SECP256K1: {
        dwalletId: secpId,
        status: null,
        supports: ['evm', 'bitcoin'],
        addresses: {},
      },
      ED25519: {
        dwalletId: edId,
        status: null,
        supports: ['sui', 'solana', 'aptos'],
        addresses: {},
      },
    };

    if (secpId) {
      if (!s.dwalletMeta.SECP256K1?.dwalletId) {
        s.dwalletMeta.SECP256K1 = {
          baseChain: s.activeVaultBaseChain,
          ...(s.dwalletMeta.SECP256K1 ?? {}),
          dwalletId: secpId,
        };
      }
      try {
        const pack = await chainAddressesForDwalletId(secpId);
        result.SECP256K1.status = pack.status;
        result.SECP256K1.addresses = {
          evm: pack.addresses.evm,
          btcP2wpkh: pack.addresses.btcP2wpkh,
          btcP2tr: pack.addresses.btcP2tr,
        };
      } catch {
        result.SECP256K1.status = 'unknown';
      }
    }

    if (edId) {
      if (!s.dwalletMeta.ED25519?.dwalletId) {
        s.dwalletMeta.ED25519 = {
          baseChain: s.activeVaultBaseChain,
          ...(s.dwalletMeta.ED25519 ?? {}),
          dwalletId: edId,
        };
      }
      try {
        const pack = await chainAddressesForDwalletId(edId);
        result.ED25519.status = pack.status;
        result.ED25519.addresses = {
          sui: pack.addresses.sui,
          solana: pack.addresses.solana,
          aptos: pack.addresses.aptos,
        };
      } catch {
        result.ED25519.status = 'unknown';
      }
    }

    return result;
  }),

  transferDWallet: publicProcedure
    .input(
      z.object({
        curve: z.enum(['SECP256K1', 'ED25519']),
        recipientSuiAddress: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      withFriendlyIkaError(() => transferDWallet(input.curve, input.recipientSuiAddress.trim())),
    ),

  getSenderEncryptionKeyAddress: publicProcedure.query(() =>
    withFriendlyIkaError(() => getSenderEncryptionKeyAddress()),
  ),

  acceptTransferredDWallet: publicProcedure
    .input(
      z.object({
        curve: z.enum(['SECP256K1', 'ED25519']),
        dwalletId: z.string().min(1),
        senderEncryptionKeyAddress: z.string().min(1),
        sourceEncryptedShareId: z.string().min(1),
        destEncryptedShareId: z.string().min(1),
      }),
    )
    .mutation(({ input }) =>
      withFriendlyIkaError(() =>
        acceptTransferredDWallet(
          input.curve,
          input.dwalletId.trim(),
          input.senderEncryptionKeyAddress.trim(),
          input.sourceEncryptedShareId.trim(),
          input.destEncryptedShareId.trim(),
        ),
      ),
    ),

  parseTransferTxDigest: publicProcedure
    .input(z.object({ digest: z.string().min(1) }))
    .query(({ input }) => withFriendlyIkaError(() => parseTransferTxEncryptedShareHints(input.digest.trim()))),

  presignPool: publicProcedure.query(() => withFriendlyIkaError(() => getPresignPoolStatus())),

  replenishPresign: publicProcedure
    .input(
      z.object({
        count: z.number().min(1).max(20).optional(),
        poolKey: z.enum(['SECP256K1_ECDSA', 'SECP256K1_TAPROOT', 'ED25519_EDDSA']).optional(),
      }),
    )
    .mutation(({ input }) =>
      withFriendlyIkaError(() => replenishPool(input.poolKey ?? 'SECP256K1_ECDSA', input.count ?? 3)),
    ),

  signEvm: publicProcedure
    .input(
      z.object({
        message: z.string(),
        chainId: z.number(),
      }),
    )
    .mutation(({ input }) => signMessageEvm(input.message, input.chainId)),

  signBtc: publicProcedure
    .input(z.object({ messageHex: z.string() }))
    .mutation(({ input }) => signMessageBtc(input.messageHex)),

  signSol: publicProcedure
    .input(z.object({ messageB64: z.string() }))
    .mutation(({ input }) => {
      const message = Uint8Array.from(atob(input.messageB64), (c) => c.charCodeAt(0));
      return signMessageSol(message);
    }),

  getBtcAddresses: publicProcedure
    .input(z.object({ network: z.enum(['mainnet', 'testnet']).optional() }))
    .query(({ input }) => getBitcoinAddresses(input.network ?? 'mainnet')),

  getSolanaAddress: publicProcedure.query(() => getSolanaAddress()),

  /** EIP-55 EVM address for the active SECP256K1 dWallet (collectibles / NFTs). */
  getEvmAddress: publicProcedure.query(() => getEvmAddress()),

  getAptosAddress: publicProcedure.query(() => getAptosAddress()),

  signAptos: publicProcedure
    .input(z.object({ messageB64: z.string() }))
    .mutation(({ input }) => {
      const message = Uint8Array.from(atob(input.messageB64), (c) => c.charCodeAt(0));
      return signMessageAptos(message);
    }),

  ikaStakingValidators: publicProcedure.query(() =>
    withFriendlyIkaError(() => listIkaValidatorsForSession()),
  ),

  ikaStakingPositions: publicProcedure.query(() =>
    withFriendlyIkaError(() => listStakedIkaForSession()),
  ),

  ikaStake: publicProcedure
    .input(
      z.object({
        validatorId: z.string().trim().min(1),
        amountBaseUnits: z.string().regex(/^\d+$/),
      }),
    )
    .mutation(({ input }) =>
      withFriendlyIkaError(() =>
        buildAndExecuteAddStake({
          validatorId: input.validatorId,
          amountBaseUnits: BigInt(input.amountBaseUnits),
        }),
      ),
    ),

  ikaWithdrawStake: publicProcedure
    .input(z.object({ stakedIkaObjectId: z.string().trim().min(1) }))
    .mutation(({ input }) =>
      withFriendlyIkaError(() => buildAndExecuteWithdrawStake(input.stakedIkaObjectId)),
    ),
};
