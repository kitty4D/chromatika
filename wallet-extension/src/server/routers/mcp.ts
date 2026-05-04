import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { getMcpConfig, patchMcpConfig } from '@/background/mcp/mcp-storage';
import { generateMcpTokenHex } from '@/background/mcp/mcp-auth';
import {
  connectNativeHost,
  disconnectNativeHost,
  getNativeHostStatus,
  pushConfigToHost,
  pushDesiredPortToHost,
  type NativeHostStatus,
} from '@/background/mcp/mcp-native-bridge';
import {
  getPendingMcpSignMeta,
  rejectPendingMcpSign,
  resolvePendingMcpSign,
} from '@/background/mcp/mcp-pending-queue';
import {
  getPendingMcpSendSolMeta,
  rejectPendingMcpSendSol,
  resolvePendingMcpSendSol,
} from '@/background/mcp/mcp-pending-sol-queue';
import { signMessageEvm } from '@/background/chains/signing/evm';
import { signMessageSol } from '@/background/chains/signing/ed25519';
import { getEvmAddress } from '@/background/chains/evm';
import { getSolanaAddress } from '@/background/chains/solana';
import { sendSolanaNativeTransfer } from '@/background/chains/solana-send-native';
import type { McpStatusOutput } from '@/background/mcp/mcp-types';

function hexToBytes(s: string): Uint8Array {
  const t = s.trim().replace(/^0x/i, '');
  if (t.length % 2 !== 0) throw new Error('messageHex length must be even');
  const out = new Uint8Array(t.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(t.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * MCP tRPC surface. MV3 cannot host a listening socket, so the chrome native-messaging host
 * binary (`wallet-extension/native-host/`) bridges to external MCP clients. these procedures
 * own the on/off toggle + per-install auth token, and drive the bridge's connectNative
 * lifecycle. readonly tool wrappers land in the next slice.
 */

type McpStatusWithNative = McpStatusOutput & { native: NativeHostStatus };

export const mcpProcedures = {
  /** read-only status. tokenHex is intentionally returned (settings ui shows it as a copy field). */
  mcpStatus: publicProcedure.query(async (): Promise<McpStatusWithNative> => {
    const c = await getMcpConfig();
    return {
      enabled: c.enabled,
      tokenHex: c.tokenHex,
      listenHost: c.listenHost,
      listenPort: c.listenPort,
      nativeHostName: c.nativeHostName,
      configVersion: c.v,
      desiredListenPort: c.desiredListenPort,
      native: getNativeHostStatus(),
    };
  }),

  /**
   * turn agent surface on. token persists across toggles so existing agent configs don't break.
   * spawns the native host in the background; the mutation returns once persisted - the actual
   * connection state shows up via mcpStatus polling.
   */
  mcpEnable: publicProcedure.mutation(async () => {
    const current = await getMcpConfig();
    const tokenHex = current.tokenHex || generateMcpTokenHex();
    const next = await patchMcpConfig({ enabled: true, tokenHex });
    void connectNativeHost();
    return { ok: true as const, tokenHex: next.tokenHex };
  }),

  /** turn agent surface off. tears down the native port immediately + clears stale listen port. */
  mcpDisable: publicProcedure.mutation(async () => {
    disconnectNativeHost();
    await patchMcpConfig({ enabled: false, listenPort: null });
    return { ok: true as const };
  }),

  /** rotate token. live host gets the new token immediately so existing connection stays usable. */
  mcpRotateToken: publicProcedure.mutation(async () => {
    const tokenHex = generateMcpTokenHex();
    await patchMcpConfig({ tokenHex });
    pushConfigToHost();
    return { ok: true as const, tokenHex };
  }),

  /**
   * set / clear the desired listen port. `null` = host picks a random port (default).
   * number 1024-65535 = host tries to bind that port; falls back to random if it can't
   * (port collision / permissions). live host re-binds immediately; a fresh chrome
   * spawn picks up the saved value via the bridge's connect-time push.
   */
  mcpSetDesiredPort: publicProcedure
    .input(z.object({ port: z.number().int().min(1024).max(65535).nullable() }))
    .mutation(async ({ input }) => {
      const next = await patchMcpConfig({ desiredListenPort: input.port });
      pushDesiredPortToHost();
      return { ok: true as const, desiredListenPort: next.desiredListenPort };
    }),

  // approve-tier (popup-mediated) - the popup at `?mcpapprove=<id>` calls these.

  getPendingMcpSignRequest: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => {
      const meta = getPendingMcpSignMeta(input.id);
      if (!meta) throw new Error(`No pending mcp sign request: ${input.id}`);
      return meta;
    }),

  approvePendingMcpSign: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const meta = getPendingMcpSignMeta(input.id);
      if (!meta) throw new Error(`No pending mcp sign request: ${input.id}`);

      try {
        if (meta.chain === 'evm') {
          const chainId = meta.evmChainId ?? 1;
          const sig = await signMessageEvm(meta.messageHex, chainId);
          const signerAddress = await getEvmAddress();
          resolvePendingMcpSign(input.id, {
            chain: 'evm',
            signatureHex: sig.signature,
            signerAddress,
          });
          return { ok: true as const, signatureHex: sig.signature, signerAddress };
        }

        // solana
        const bytes = hexToBytes(meta.messageHex);
        const sig = await signMessageSol(bytes);
        const signerAddress = await getSolanaAddress();
        resolvePendingMcpSign(input.id, {
          chain: 'solana',
          signatureHex: sig.signature,
          signerAddress,
        });
        return { ok: true as const, signatureHex: sig.signature, signerAddress };
      } catch (e) {
        // signing threw - reject the queued promise so the mcp client gets a real error too.
        const message = e instanceof Error ? e.message : String(e);
        try {
          rejectPendingMcpSign(input.id, message);
        } catch {
          /* already removed */
        }
        throw e;
      }
    }),

  rejectPendingMcpSign: publicProcedure
    .input(z.object({ id: z.string().min(1), reason: z.string().default('user_canceled') }))
    .mutation(({ input }) => {
      try {
        rejectPendingMcpSign(input.id, input.reason);
      } catch {
        // already resolved/rejected/expired - swallow so the popup can close cleanly.
      }
      return { ok: true as const };
    }),

  // ---- mcp sendSolanaTx (native SOL transfer, popup-gated) ----

  getPendingMcpSendSolRequest: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ input }) => {
      const meta = getPendingMcpSendSolMeta(input.id);
      if (!meta) throw new Error(`No pending mcp sendSol request: ${input.id}`);
      return meta;
    }),

  approvePendingMcpSendSol: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const meta = getPendingMcpSendSolMeta(input.id);
      if (!meta) throw new Error(`No pending mcp sendSol request: ${input.id}`);
      try {
        let signature: string;
        if (meta.kind === 'spl') {
          if (!meta.mint || !meta.amountRaw) {
            throw new Error('SPL request missing mint or amountRaw');
          }
          const { sendSolanaSplTransfer } = await import('@/background/chains/solana-send-spl');
          signature = await sendSolanaSplTransfer(meta.to, meta.mint, BigInt(meta.amountRaw));
        } else {
          if (!meta.lamports) throw new Error('native request missing lamports');
          signature = await sendSolanaNativeTransfer(meta.to, BigInt(meta.lamports));
        }
        const signerAddress = await getSolanaAddress();
        resolvePendingMcpSendSol(input.id, { signature, signerAddress });
        return { ok: true as const, signature, signerAddress };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        try {
          rejectPendingMcpSendSol(input.id, message);
        } catch {
          /* already removed */
        }
        throw e;
      }
    }),

  rejectPendingMcpSendSol: publicProcedure
    .input(z.object({ id: z.string().min(1), reason: z.string().default('user_canceled') }))
    .mutation(({ input }) => {
      try {
        rejectPendingMcpSendSol(input.id, input.reason);
      } catch {
        /* already resolved */
      }
      return { ok: true as const };
    }),
};
