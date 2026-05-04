import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { isPhishingDomain } from '@/background/phishing';
import {
  getAllPermissions,
  getPermission,
  revokePermission,
} from '@/background/dapp-permissions';
import {
  getDappApprovalMeta,
  rejectDappApproval,
  resolveDappApproval,
} from '@/background/dapp-approval';
import {
  getTxApprovalMeta,
  rejectTxApproval,
  resolveTxApproval,
} from '@/background/tx-approval';
import {
  getRpcProviderForChain,
  resolveGasLimitWithFallback,
  signAndBroadcastEvm,
  signEvmTxOnly,
} from '@/background/chains/evm-send';
import { simulateEvmTxStaticCall } from '@/background/chains/evm-tx-simulation';
import { getEvmAddressForOrigin } from '@/background/chains/evm';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { findEvmNetwork } from '@/config/networks';
import { getPrice } from '@/background/services/price';
import { getSession } from '@/background/session';
import { withFriendlyIkaError } from '@/background/ika/errors';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { ed25519DappWalletStyleLabel, evmWalletStyleLabel } from '@/lib/dwallet-ui-labels';
import { getSigningProgress, stepLabel } from '@/background/signing-progress';
import { getBridgeTelemetry } from '@/background/dapp-telemetry';
import { getDappConsentMode, setDappConsentMode } from '@/background/dapp-consent-mode';

export const dappProcedures = {
  checkPhishing: publicProcedure
    .input(z.object({ host: z.string() }))
    .query(({ input }) => ({ phishing: isPhishingDomain(input.host) })),

  getDappPermissions: publicProcedure.query(() => getAllPermissions()),

  revokeDappPermission: publicProcedure
    .input(z.object({ origin: z.string() }))
    .mutation(async ({ input }) => {
      await revokePermission(input.origin);
      return { ok: true as const };
    }),

  getDappApprovalRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const meta = getDappApprovalMeta(input.id);
      if (!meta) throw new Error(`No pending dapp approval: ${input.id}`);
      if (meta.payload.kind !== 'connect') {
        return { ...meta, connectOptions: undefined as undefined };
      }
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const caps = await withFriendlyIkaError(() => listOwnedDWalletCapsForVault(s.activeVaultId));
      const family = meta.payload.connectFamily ?? 'evm';

      if (family !== 'evm') {
        const activeEd = caps.filter(
          (c) => c.curve === 'ED25519' && c.dwalletId !== 'unknown' && c.status === 'Active',
        );
        const choices = activeEd.map((c) => ({
          dwalletId: c.dwalletId,
          label: ed25519DappWalletStyleLabel(c.dwalletId, c.chainAddresses?.sui),
        }));
        const perm = await getPermission(meta.payload.origin);
        const metaEd = s.dwalletMeta.ED25519?.dwalletId;
        let defaultEd25519DwalletId: string | undefined;
        if (perm?.selectedEd25519DwalletId && choices.some((x) => x.dwalletId === perm.selectedEd25519DwalletId)) {
          defaultEd25519DwalletId = perm.selectedEd25519DwalletId;
        } else if (metaEd && choices.some((x) => x.dwalletId === metaEd)) {
          defaultEd25519DwalletId = metaEd;
        } else {
          defaultEd25519DwalletId = choices[0]?.dwalletId;
        }
        return {
          ...meta,
          connectOptions: {
            mode: 'nonEvm' as const,
            connectFamily: family,
            choices,
            defaultEd25519DwalletId,
            hasNoActiveEd25519: choices.length === 0,
          },
        };
      }

      const activeSecp = caps.filter(
        (c) => c.curve === 'SECP256K1' && c.dwalletId !== 'unknown' && c.status === 'Active',
      );
      const choices = activeSecp.map((c) => ({
        dwalletId: c.dwalletId,
        label: evmWalletStyleLabel(c.dwalletId, c.chainAddresses?.evm),
      }));
      const perm = await getPermission(meta.payload.origin);
      const metaSecp = s.dwalletMeta.SECP256K1?.dwalletId;
      let defaultSecpDwalletId: string | undefined;
      if (perm?.selectedDwalletId && choices.some((x) => x.dwalletId === perm.selectedDwalletId)) {
        defaultSecpDwalletId = perm.selectedDwalletId;
      } else if (metaSecp && choices.some((x) => x.dwalletId === metaSecp)) {
        defaultSecpDwalletId = metaSecp;
      } else {
        defaultSecpDwalletId = choices[0]?.dwalletId;
      }
      return {
        ...meta,
        connectOptions: {
          mode: 'evm' as const,
          choices,
          defaultSecpDwalletId,
          hasNoActiveSecp: choices.length === 0,
        },
      };
    }),

  approveDappConnection: publicProcedure
    .input(
      z.object({
        id: z.string(),
        approved: z.boolean(),
        secpDwalletId: z.string().trim().min(1).optional(),
        ed25519DwalletId: z.string().trim().min(1).optional(),
      }),
    )
    .mutation(({ input }) => {
      resolveDappApproval(input.id, {
        approved: input.approved,
        secpDwalletId: input.secpDwalletId,
        ed25519DwalletId: input.ed25519DwalletId,
      });
      return { ok: true as const };
    }),

  rejectDappConnection: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectDappApproval(input.id, input.reason);
      return { ok: true as const };
    }),

  dappBridgeDebug: publicProcedure.query(async () => {
    const items = await getBridgeTelemetry();
    return items.slice(-50).reverse();
  }),

  getDappConsentMode: publicProcedure.query(() => getDappConsentMode()),

  setDappConsentMode: publicProcedure
    .input(z.object({ mode: z.enum(['compat', 'strict']) }))
    .mutation(async ({ input }) => {
      await setDappConsentMode(input.mode);
      return { ok: true as const };
    }),

  // --- eth_sendTransaction approval ---

  getTxApprovalRequest: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const meta = getTxApprovalMeta(input.id);
      if (!meta) throw new Error(`No pending tx approval: ${input.id}`);
      return meta;
    }),

  /** eth_call at latest block before user approves eth_sendTransaction (no third-party API). */
  getTxSimulationPreview: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const meta = getTxApprovalMeta(input.id);
      if (!meta) throw new Error(`No pending tx approval: ${input.id}`);
      const from = meta.from || (await getEvmAddressForOrigin(meta.origin));
      return await simulateEvmTxStaticCall({
        chainId: meta.chainId,
        from,
        to: meta.to,
        value: meta.value,
        data: meta.data,
      });
    }),

  getTxGasOptions: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ input }) => {
      const meta = getTxApprovalMeta(input.id);
      if (!meta) throw new Error(`No pending tx approval: ${input.id}`);
      const { provider, rpcUrl } = await getRpcProviderForChain(meta.chainId);
      const feeData = await provider.getFeeData();
      const { evm: customEvm } = await getCustomNetworks();
      const net = findEvmNetwork(meta.chainId, customEvm);
      const nativeSymbol = net?.symbol ?? 'ETH';
      const nativeDecimals = net?.decimals ?? 18;
      let nativeUsd: number | null = null;
      try {
        nativeUsd = await getPrice(nativeSymbol);
      } catch {
        nativeUsd = null;
      }
      const from = meta.from || (await getEvmAddressForOrigin(meta.origin));
      const value = BigInt(meta.value || '0x0');
      const data = meta.data || '0x';
      const resolvedGas = await resolveGasLimitWithFallback(
        meta.chainId,
        rpcUrl,
        from,
        meta.to,
        value,
        data,
        meta.gas,
      );
      const gasLimit = resolvedGas.gasLimit;
      const gasEstimateNote = resolvedGas.note ?? resolvedGas.estimateErr;

      const block = await provider.getBlock('latest');
      const networkSupports1559 = block?.baseFeePerGas != null && block.baseFeePerGas > 0n;

      const dappLegacy =
        meta.gasPrice != null &&
        meta.gasPrice !== '' &&
        meta.gasPrice !== '0x0' &&
        BigInt(meta.gasPrice) > 0n &&
        !meta.maxFeePerGas &&
        !meta.maxPriorityFeePerGas;

      const useLegacy = !networkSupports1559 || dappLegacy;

      const gasHex = `0x${gasLimit.toString(16)}`;
      const estNativeFromWei = (wei: bigint) => Number(wei) / 10 ** nativeDecimals;

      if (useLegacy) {
        const baseGasPrice = dappLegacy
          ? BigInt(meta.gasPrice!)
          : (feeData.gasPrice ?? feeData.maxFeePerGas ?? 20_000_000_000n);
        const mk = (name: 'slow' | 'normal' | 'fast', priceMul: bigint) => {
          const gasPrice = (baseGasPrice * priceMul) / 100n;
          const totalWei = gasLimit * gasPrice;
          const estimatedNative = estNativeFromWei(totalWei);
          return {
            name,
            gas: gasHex,
            gasPrice: `0x${gasPrice.toString(16)}`,
            maxFeePerGas: null as string | null,
            maxPriorityFeePerGas: null as string | null,
            gasPriceGwei: Number(gasPrice) / 1e9,
            estimatedNative,
            estimatedUsd: nativeUsd == null ? null : estimatedNative * nativeUsd,
          };
        };
        return {
          feeMode: 'legacy' as const,
          chainId: meta.chainId,
          nativeSymbol,
          gasLimit: gasHex,
          gasEstimateNote: gasEstimateNote ?? null,
          presets: [mk('slow', 90n), mk('normal', 100n), mk('fast', 120n)],
        };
      }

      const baseMaxFee = meta.maxFeePerGas
        ? BigInt(meta.maxFeePerGas)
        : (feeData.maxFeePerGas ?? feeData.gasPrice ?? 20_000_000_000n);
      const basePriority = meta.maxPriorityFeePerGas
        ? BigInt(meta.maxPriorityFeePerGas)
        : (feeData.maxPriorityFeePerGas ?? 1_000_000_000n);
      const mk = (name: 'slow' | 'normal' | 'fast', feeMul: bigint, prioMul: bigint) => {
        const maxFeePerGas = (baseMaxFee * feeMul) / 100n;
        const maxPriorityFeePerGas = (basePriority * prioMul) / 100n;
        const totalWei = gasLimit * maxFeePerGas;
        const estimatedNative = estNativeFromWei(totalWei);
        return {
          name,
          maxFeePerGas: `0x${maxFeePerGas.toString(16)}`,
          maxPriorityFeePerGas: `0x${maxPriorityFeePerGas.toString(16)}`,
          gas: gasHex,
          gasPrice: null as string | null,
          maxFeePerGasGwei: Number(maxFeePerGas) / 1e9,
          estimatedNative,
          estimatedUsd: nativeUsd == null ? null : estimatedNative * nativeUsd,
        };
      };
      return {
        feeMode: 'eip1559' as const,
        chainId: meta.chainId,
        nativeSymbol,
        gasLimit: gasHex,
        gasEstimateNote: gasEstimateNote ?? null,
        presets: [
          mk('slow', 90n, 90n),
          mk('normal', 100n, 100n),
          mk('fast', 120n, 120n),
        ],
      };
    }),

  /** poll signing progress from the background. */
  signingProgress: publicProcedure.query(() => {
    const p = getSigningProgress();
    if (!p) return null;
    return { step: p.step, label: stepLabel(p.step), detail: p.detail, elapsedMs: Date.now() - p.startedAt };
  }),

  /** sign + broadcast + resolve the pending dapp request. */
  approveTxRequest: publicProcedure
    .input(
      z.object({
        id: z.string(),
        overrides: z.object({
          gas: z.string().nullable().optional(),
          maxFeePerGas: z.string().nullable().optional(),
          maxPriorityFeePerGas: z.string().nullable().optional(),
          gasPrice: z.string().nullable().optional(),
        }).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const meta = getTxApprovalMeta(input.id);
      if (!meta) throw new Error(`No pending tx approval: ${input.id}`);
      const baseParams = {
        to: meta.to,
        value: meta.value,
        data: meta.data,
        gas: input.overrides?.gas ?? meta.gas,
        maxFeePerGas: input.overrides?.maxFeePerGas ?? meta.maxFeePerGas,
        maxPriorityFeePerGas: input.overrides?.maxPriorityFeePerGas ?? meta.maxPriorityFeePerGas,
        gasPrice: input.overrides?.gasPrice ?? meta.gasPrice,
        nonce: meta.nonce,
        chainId: meta.chainId,
        dappOrigin: meta.origin,
      };
      try {
        if (meta.signOnly) {
          // sign-only path: produce signed RLP + tx hash, do NOT broadcast. used by the MCP
          // signTransaction tool / relayer / bundler / abstract-wallet flows where the caller
          // submits through their own infrastructure.
          const signed = await withFriendlyIkaError(() => signEvmTxOnly(baseParams));
          resolveTxApproval(input.id, {
            kind: 'sign-only',
            signedRawTx: signed.signedRawTx,
            txHash: signed.txHash,
          });
          return {
            ok: true as const,
            kind: 'sign-only' as const,
            signedRawTx: signed.signedRawTx,
            txHash: signed.txHash,
          };
        }
        const txHash = await withFriendlyIkaError(() =>
          signAndBroadcastEvm({
            ...baseParams,
            ikaBenchContext: {
              source: 'dapp_eth_sendTransaction',
              approvalId: input.id,
            },
          }),
        );
        resolveTxApproval(input.id, { kind: 'broadcast', txHash });
        return { ok: true as const, kind: 'broadcast' as const, txHash };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rejectTxApproval(input.id, msg);
        throw e;
      }
    }),

  rejectTxRequest: publicProcedure
    .input(z.object({ id: z.string(), reason: z.string() }))
    .mutation(({ input }) => {
      rejectTxApproval(input.id, input.reason);
      return { ok: true as const };
    }),
};
