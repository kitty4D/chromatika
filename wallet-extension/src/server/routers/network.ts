import { z } from 'zod';
import { publicProcedure } from '../trpc';
import {
  BUILTIN_APTOS,
  BUILTIN_BITCOIN,
  BUILTIN_SOLANA,
  BUILTIN_SUI,
  findEvmNetwork,
  mergeEvmNetworksWithCustom,
} from '@/config/networks';
import { FEATURES } from '@/config/features';
import { getActiveNetworks } from '@/background/network/active-network';
import {
  getDwalletNetworkSettings,
  getVaultNetworkSettings,
  setDwalletNetworkSettings,
  setVaultNetworkSettings,
} from '@/background/network/tier-network-settings';
import {
  addCustomEvm,
  getCustomNetworks,
  removeCustomEvm,
} from '@/background/network/custom-networks';
import { verifyEvmRpcForChain } from '@/background/network/evm-rpc-verify';
import { searchChainlist } from '@/background/network/chainlist';
import { getRpcHealthForChain } from '@/background/chains/evm-rpc-health';
import { getActiveVaultId, refreshSessionNetworkClients } from '@/background/wallet-service';
import { getSession } from '@/background/session';
import { broadcastToTabs } from '@/background/broadcast';
import { getMediaSafetyMode, setMediaSafetyMode } from '@/background/services/media-safety';
import { getAdvancedMode, setAdvancedMode } from '@/background/advanced-mode';
import { getUiHelpHints, setUiHelpHints } from '@/background/ui-help-hints';
import { getIkaBaseMode, setIkaBaseMode } from '@/background/ika-base-mode';
import { getAppearance, setAppearance } from '@/background/appearance-mode';
import {
  getExplorerPreferences,
  setExplorerPreferences,
} from '@/background/explorer-preferences';
import { getPricePreferences, setPricePreferences } from '@/background/price-preferences';
import { clearPriceCache } from '@/background/services/price';

export const networkProcedures = {
  getNetworks: publicProcedure.query(async () => {
    const { evm: customEvm } = await getCustomNetworks();
    const active = await getActiveNetworks();
    const vid = getActiveVaultId();
    const s = getSession();
    let vaultTier = null as Awaited<ReturnType<typeof getVaultNetworkSettings>> | null;
    let dwalletTier = null as Awaited<ReturnType<typeof getDwalletNetworkSettings>> | null;
    if (s && vid) {
      const seed = { network: s.network, baseChain: s.activeVaultBaseChain };
      vaultTier = await getVaultNetworkSettings(vid, seed);
      dwalletTier = await getDwalletNetworkSettings(vid, seed);
    }
    return {
      evm: mergeEvmNetworksWithCustom(customEvm),
      solana: BUILTIN_SOLANA,
      sui: BUILTIN_SUI,
      aptos: BUILTIN_APTOS,
      bitcoin: BUILTIN_BITCOIN,
      active,
      vaultTier,
      dwalletTier,
    };
  }),

  getEvmRpcHealth: publicProcedure.query(async () => {
    const { evmChainId } = await getActiveNetworks();
    return getRpcHealthForChain(evmChainId);
  }),

  setActiveEvm: publicProcedure
    .input(z.object({ chainId: z.number() }))
    .mutation(async ({ input }) => {
      const vid = getActiveVaultId();
      if (!vid) throw new Error('Wallet locked');
      const { evm: customEvm } = await getCustomNetworks();
      const found = findEvmNetwork(input.chainId, customEvm);
      if (!found) throw new Error(`Unknown chainId ${input.chainId}`);
      await setDwalletNetworkSettings(vid, { evmChainId: input.chainId });
      await refreshSessionNetworkClients();
      broadcastToTabs('chainChanged', `0x${input.chainId.toString(16)}`);
      return { ok: true as const, network: found };
    }),

  setActiveSuiNetwork: publicProcedure
    .input(
      z.object({
        networkId: z.string(),
        tier: z.enum(['vault', 'dwallet']).default('dwallet'),
      }),
    )
    .mutation(async ({ input }) => {
      const v = getSession();
      const vid = getActiveVaultId();
      if (!v || !vid) throw new Error('Wallet locked');
      const found = BUILTIN_SUI.find((n) => n.id === input.networkId);
      if (!found) throw new Error(`Unknown Sui network ${input.networkId}`);
      if (input.tier === 'vault') {
        await setVaultNetworkSettings(vid, { suiNetworkId: input.networkId });
      } else {
        await setDwalletNetworkSettings(vid, { suiNetworkId: input.networkId });
      }
      await refreshSessionNetworkClients();
      return { ok: true as const, network: found };
    }),

  setActiveSolanaNetwork: publicProcedure
    .input(
      z.object({
        networkId: z.string(),
        tier: z.enum(['vault', 'dwallet']).default('dwallet'),
      }),
    )
    .mutation(async ({ input }) => {
      const v = getSession();
      const vid = getActiveVaultId();
      if (!v || !vid) throw new Error('Wallet locked');
      const found = BUILTIN_SOLANA.find((n) => n.id === input.networkId);
      if (!found) throw new Error(`Unknown Solana network ${input.networkId}`);
      if (input.tier === 'vault') {
        await setVaultNetworkSettings(vid, { solana: { solNetworkId: input.networkId } });
      } else {
        await setDwalletNetworkSettings(vid, { solana: { solNetworkId: input.networkId } });
      }
      await refreshSessionNetworkClients();
      return { ok: true as const, network: found };
    }),

  setActiveAptosNetwork: publicProcedure
    .input(z.object({ networkId: z.string() }))
    .mutation(async ({ input }) => {
      const vid = getActiveVaultId();
      if (!vid) throw new Error('Wallet locked');
      const found = BUILTIN_APTOS.find((n) => n.id === input.networkId);
      if (!found) throw new Error(`Unknown Aptos network ${input.networkId}`);
      await setDwalletNetworkSettings(vid, { aptNetworkId: input.networkId });
      await refreshSessionNetworkClients();
      return { ok: true as const, network: found };
    }),

  setActiveBitcoinNetwork: publicProcedure
    .input(z.object({ networkId: z.string() }))
    .mutation(async ({ input }) => {
      const vid = getActiveVaultId();
      if (!vid) throw new Error('Wallet locked');
      const found = BUILTIN_BITCOIN.find((n) => n.id === input.networkId);
      if (!found) throw new Error(`Unknown Bitcoin network ${input.networkId}`);
      await setDwalletNetworkSettings(vid, { btcNetworkId: input.networkId });
      await refreshSessionNetworkClients();
      return { ok: true as const, network: found };
    }),

  addCustomNetwork: publicProcedure
    .input(
      z.object({
        name: z.string().min(1),
        chainId: z.number().int().positive(),
        rpcUrl: z.string().url(),
        symbol: z.string().min(1).max(10),
        decimals: z.number().int().min(0).max(18).default(18),
        explorerUrl: z.string().url().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const v = await verifyEvmRpcForChain(input.chainId, input.rpcUrl);
      if (!v.ok) throw new Error(v.error);
      const network = await addCustomEvm(input);
      return { ok: true as const, network, warnings: v.warnings };
    }),

  removeCustomNetwork: publicProcedure
    .input(z.object({ chainId: z.number() }))
    .mutation(async ({ input }) => {
      await removeCustomEvm(input.chainId);
      return { ok: true as const };
    }),

  importFromChainlist: publicProcedure
    .input(z.object({ query: z.union([z.string(), z.number()]) }))
    .query(({ input }) => searchChainlist(input.query)),

  // --- ui preferences ---

  getMediaSafetyMode: publicProcedure.query(() => getMediaSafetyMode()),

  setMediaSafetyMode: publicProcedure
    .input(z.object({ mode: z.enum(['all', 'ipfs_arweave', 'none']) }))
    .mutation(async ({ input }) => {
      await setMediaSafetyMode(input.mode);
      return { ok: true as const };
    }),

  getAdvancedMode: publicProcedure.query(() => getAdvancedMode()),

  setAdvancedMode: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setAdvancedMode(input.enabled);
      return { ok: true as const };
    }),

  getUiHelpHints: publicProcedure.query(() => getUiHelpHints()),

  setUiHelpHints: publicProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      await setUiHelpHints(input.enabled);
      return { ok: true as const };
    }),

  getIkaBaseMode: publicProcedure.query(() => getIkaBaseMode()),

  setIkaBaseMode: publicProcedure
    .input(z.object({ mode: z.enum(['sui', 'solana']) }))
    .mutation(async ({ input }) => {
      if (input.mode === 'solana' && !FEATURES.SOLANA_IKA_BASE_IN_UI) {
        throw new Error('Solana ika base is disabled in this build, set VITE_SOLANA_IKA_BASE=true or use a dev build.');
      }
      await setIkaBaseMode(input.mode);
      return { ok: true as const, mode: input.mode };
    }),

  getAppearance: publicProcedure.query(() => getAppearance()),

  setAppearance: publicProcedure
    .input(z.object({ appearance: z.enum(['light', 'dark']) }))
    .mutation(async ({ input }) => {
      await setAppearance(input.appearance);
      return { ok: true as const };
    }),

  getExplorerPreferences: publicProcedure.query(() => getExplorerPreferences()),

  setExplorerPreferences: publicProcedure
    .input(
      z.object({
        sui: z.object({
          preset: z.enum(['suiscan', 'suivision', 'custom']),
          customTemplate: z.string().trim().optional(),
        }),
        solana: z.object({
          preset: z.enum(['solscan', 'solanaExplorer', 'orb', 'custom']),
          customTemplate: z.string().trim().optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      await setExplorerPreferences(input);
      return { ok: true as const };
    }),

  getPricePreferences: publicProcedure.query(() => getPricePreferences()),

  setPricePreferences: publicProcedure
    .input(
      z.object({
        order: z
          .array(z.enum(['coingecko', 'defillama', 'coinmarketcap', 'pyth', 'chainlink', 'dextwap']))
          .min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await setPricePreferences({ order: input.order });
      clearPriceCache();
      return { ok: true as const };
    }),
};
