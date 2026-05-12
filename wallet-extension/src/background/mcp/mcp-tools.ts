/**
 * mcp read-tier tools (v1).
 *
 * thin wrappers around existing wallet-service / network surfaces. exposed to external mcp
 * clients via the chrome native messaging host. no signing or sending in this tier, the
 * approve tier (popup-gated) is a follow-up slice.
 *
 * mcp wire shape used here is the standard `{ name, description, inputSchema }` triple. the
 * native host translates between this and the JSON-RPC 2.0 `tools/list` / `tools/call`
 * envelope mcp clients speak.
 */

import { listVaultSummaries, getActiveVaultId, getLockState } from '@/background/wallet-service';
import { getActiveNetworks } from '@/background/network/active-network';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { findEvmNetwork } from '@/config/networks';
import { getEvmAddress } from '@/background/chains/evm';
import { decodeTx } from '@/background/tx-decode';
import { enqueueTxApproval } from '@/background/tx-approval';
import { enqueueMcpSign, type McpSignChain } from './mcp-pending-queue';

export type McpToolDescriptor = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
};

export type McpToolErrorCode =
  | -32601 // method not found
  | -32602 // invalid params
  | -32603 // internal error
  | -32001 // wallet locked (custom)
  | -32002; // not enabled (custom)

export type McpToolResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: McpToolErrorCode; message: string } };

/**
 * static definitions returned by `tools/list`. read-tier tools take no arguments and return
 * directly. approve-tier tools (signMessage today; signTransaction / sendTx in future slices)
 * open a popup the user must approve before the call resolves.
 */
export const MCP_READ_TOOLS: McpToolDescriptor[] = [
  {
    name: 'listVaults',
    description:
      "List the wallet's available vaults (id, label, base chain, account kind, creation timestamp). Returns no mnemonic, private keys, or other secret material.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getActiveVault',
    description:
      'Get the id of the currently-active vault. Returns null when the wallet is locked.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getActiveNetworks',
    description:
      "Get the user's active network selection across chains (EVM chainId, Sui network id, Solana network id, Aptos network id, Bitcoin network id).",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'getLockState',
    description: 'Read the wallet lock state. Returns whether the wallet is unlocked.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'listActiveAlerts',
    description:
      "List active chromatika safety-broadcast alerts (non-expired, non-dismissed). Authenticity is verified at fetch time via ed25519 against the bundled publisher allowlist. Use this before recommending a swap / dapp connect / approve to surface flagged platforms (filter by `domain` to scope the check). Returns alerts with severity, affected domains, title, body, publisher, and the wallet's last-poll status.",
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description:
            'Optional hostname filter. When set, returns only alerts whose `affectedDomains` includes this hostname (case-insensitive). Useful before recommending a dapp.',
        },
        severity: {
          type: 'string',
          enum: ['critical', 'warning', 'info'],
          description: 'Optional severity filter. When set, returns only alerts at or above this level.',
        },
      },
      required: [],
    },
  },
];

export const MCP_APPROVE_TOOLS: McpToolDescriptor[] = [
  {
    name: 'signMessage',
    description:
      "Sign an arbitrary message with the user's active dWallet on the given chain. Opens an approval popup the user must accept; rejects if the user cancels. Returns hex signature + signer address.",
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', enum: ['evm', 'solana'] },
        messageHex: { type: 'string', description: 'Hex-encoded message bytes (with or without 0x prefix). Cap: 8 KiB raw / 16 KiB hex.' },
        evmChainId: { type: 'number', description: 'Required when chain=evm; the chainId the signature should bind to.' },
        callerHint: { type: 'string', description: 'Optional human-readable caller name shown to the user (e.g. mcp client identifier).' },
      },
      required: ['chain', 'messageHex'],
    },
  },
  {
    name: 'sendSolanaTx',
    description:
      "Send a native SOL or SPL token transfer. Pass either `lamports` (native) OR `mint` + `amountRaw` (SPL). Opens an MCP approval popup the user must accept; rejects if the user cancels. Returns the Solana tx signature (base58).",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient Solana address (base58).' },
        lamports: {
          type: 'string',
          description: 'Native SOL amount in lamports as a decimal string (1 SOL = 1_000_000_000 lamports). Omit for SPL transfers.',
        },
        mint: {
          type: 'string',
          description: 'SPL token mint (base58). Required for SPL transfers; omit for native.',
        },
        amountRaw: {
          type: 'string',
          description: 'SPL amount in token base-units (decimal string, depends on mint decimals). Required when `mint` is set.',
        },
        callerHint: { type: 'string', description: 'Optional caller identifier shown to the user.' },
      },
      required: ['to'],
    },
  },
  {
    name: 'sendEvmTx',
    description:
      "Send an EVM transaction. Opens the wallet's existing transaction approval popup with gas options + decoded params; rejects if the user cancels. Returns the broadcast txHash.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address (0x-prefixed hex). Use null for contract deployments.' },
        value: { type: 'string', description: "Amount in wei as a hex or decimal string. Defaults to '0x0'." },
        data: { type: 'string', description: "Calldata as a 0x-prefixed hex string. Defaults to '0x'." },
        chainId: { type: 'number', description: "EVM chainId. Defaults to the wallet's active EVM network." },
        gas: { type: 'string', description: 'Gas limit (hex). Wallet auto-estimates if omitted.' },
        maxFeePerGas: { type: 'string', description: 'EIP-1559 max fee per gas (hex). Wallet provides default if omitted.' },
        maxPriorityFeePerGas: { type: 'string', description: 'EIP-1559 max priority fee (hex). Wallet provides default if omitted.' },
        gasPrice: { type: 'string', description: 'Legacy gas price (hex). Mutually exclusive with EIP-1559 fields.' },
        nonce: { type: 'string', description: 'Transaction nonce (hex). Wallet auto-fills if omitted.' },
        callerHint: { type: 'string', description: "Optional caller identifier shown to the user (e.g. mcp client name)." },
      },
      required: ['to'],
    },
  },
  {
    name: 'signTransaction',
    description:
      "Sign an EVM transaction WITHOUT broadcasting. Opens the same approval popup as sendEvmTx (with gas options + decoded params); on approve returns the signed serialized tx hex + computed txHash so the caller can broadcast through their own infrastructure (relayer / bundler / abstract-wallet flows). The wallet does not touch the network from here - the nonce is reserved at sign time, but no submission happens, so a slow caller can race with another tx and find the nonce already used.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address (0x-prefixed hex). Use null for contract deployments.' },
        value: { type: 'string', description: "Amount in wei as a hex or decimal string. Defaults to '0x0'." },
        data: { type: 'string', description: "Calldata as a 0x-prefixed hex string. Defaults to '0x'." },
        chainId: { type: 'number', description: "EVM chainId. Defaults to the wallet's active EVM network." },
        gas: { type: 'string', description: 'Gas limit (hex). Wallet auto-estimates if omitted.' },
        maxFeePerGas: { type: 'string', description: 'EIP-1559 max fee per gas (hex). Wallet provides default if omitted.' },
        maxPriorityFeePerGas: { type: 'string', description: 'EIP-1559 max priority fee (hex). Wallet provides default if omitted.' },
        gasPrice: { type: 'string', description: 'Legacy gas price (hex). Mutually exclusive with EIP-1559 fields.' },
        nonce: { type: 'string', description: 'Transaction nonce (hex). Wallet auto-fills if omitted.' },
        callerHint: { type: 'string', description: "Optional caller identifier shown to the user (e.g. mcp client name)." },
      },
      required: ['to'],
    },
  },
];

export const MCP_TOOLS: McpToolDescriptor[] = [...MCP_READ_TOOLS, ...MCP_APPROVE_TOOLS];

const TOOL_NAMES = new Set(MCP_TOOLS.map((t) => t.name));

/**
 * dispatch a tool call. caller (the bridge) has already validated auth + framing; this just
 * routes by name and shapes errors into the json-rpc-friendly envelope.
 */
export async function dispatchMcpToolCall(name: string, _params: unknown): Promise<McpToolResult> {
  if (!TOOL_NAMES.has(name)) {
    return {
      ok: false,
      error: { code: -32601, message: `unknown tool: ${name}` },
    };
  }

  try {
    switch (name) {
      case 'listVaults': {
        // listVaultSummaries throws when the wallet is locked: surface that as the "locked"
        // custom code so clients can tell apart "tool failed" from "wallet not unlocked".
        const lock = getLockState();
        if (!lock.unlocked) {
          return {
            ok: false,
            error: { code: -32001, message: 'wallet is locked' },
          };
        }
        const summaries = await listVaultSummaries();
        return { ok: true, result: summaries };
      }

      case 'getActiveVault': {
        const vid = getActiveVaultId();
        // surface per-dwallet policy-vault state for every wrapped dwallet. lets agents
        // pre-check cap remaining + panicked state BEFORE asking the user to approve a sign
        // request, and route around panicked/over-cap with a friendly message instead of a
        // chain abort. Empty array = no opted-in dwallets yet.
        type PolicyVaultStateForAgent = {
          dwalletId: string;
          vaultObjectId: string;
          curve: number;
          panicked: boolean;
          dailyCapMicros: string;
          spentTodayMicros: string;
          remainingMicros: string;
          coolDownMs: number;
          unfreezeUnlocksAtMs: number;
        };
        let policyVaults: PolicyVaultStateForAgent[] = [];
        if (vid) {
          try {
            const { listPolicyVaultLinks } = await import('@/background/policy-vault/policy-vault-storage');
            const links = await listPolicyVaultLinks(vid);
            policyVaults = links
              .filter((l) => l.cachedSnapshot)
              .map((l) => {
                const snap = l.cachedSnapshot!;
                const cap = BigInt(snap.dailyCapMicros);
                const spent = BigInt(snap.spentTodayMicros);
                const remaining = cap > spent ? cap - spent : 0n;
                return {
                  dwalletId: l.dwalletId,
                  vaultObjectId: l.vaultObjectId,
                  curve: l.curve,
                  panicked: snap.panicked,
                  dailyCapMicros: snap.dailyCapMicros,
                  spentTodayMicros: snap.spentTodayMicros,
                  remainingMicros: remaining.toString(),
                  coolDownMs: snap.coolDownMs,
                  unfreezeUnlocksAtMs: snap.unfreezeUnlocksAtMs,
                };
              });
          } catch (e) {
            // best-effort surface; never block getActiveVault on policy lookup failures.
            console.warn('[chromatika mcp] policy lookup failed for getActiveVault:', e);
          }
        }
        return { ok: true, result: { activeVaultId: vid, policyVaults } };
      }

      case 'getActiveNetworks': {
        const networks = await getActiveNetworks();
        return { ok: true, result: networks };
      }

      case 'getLockState': {
        const lock = getLockState();
        return { ok: true, result: { unlocked: lock.unlocked } };
      }

      case 'listActiveAlerts': {
        const args = (_params ?? {}) as { domain?: unknown; severity?: unknown };
        const { getAlertsState, activeAlertsFromState } = await import('@/background/alerts/alerts-store');
        const state = await getAlertsState();
        const all = activeAlertsFromState(state);
        const domainFilter = typeof args.domain === 'string' ? args.domain.toLowerCase().replace(/^www\./, '') : null;
        const severityFilter =
          args.severity === 'critical' ? 3 : args.severity === 'warning' ? 2 : args.severity === 'info' ? 1 : 0;
        const severityRank = (s: string) => (s === 'critical' ? 3 : s === 'warning' ? 2 : 1);
        const filtered = all.filter((a) => {
          if (severityFilter && severityRank(a.severity) < severityFilter) return false;
          if (domainFilter) {
            const hit = a.affectedDomains.some((d) => d.toLowerCase().replace(/^www\./, '') === domainFilter);
            if (!hit) return false;
          }
          return true;
        });
        return {
          ok: true,
          result: {
            alerts: filtered.map((a) => ({
              id: a.id,
              severity: a.severity,
              timestampMs: a.timestampMs,
              expiresAtMs: a.expiresAtMs,
              affectedDomains: a.affectedDomains,
              affectedChains: a.affectedChains ?? [],
              titleShort: a.titleShort,
              bodyLong: a.bodyLong,
              publisherKeyB64: a.publisherKeyB64,
            })),
            lastPolledAtMs: state.lastPolledAtMs,
            lastPollError: state.lastPollError,
            muted: state.settings.muted,
            optedOut: state.settings.optedOut,
          },
        };
      }

      case 'signMessage': {
        const args = (_params ?? {}) as {
          chain?: string;
          messageHex?: string;
          evmChainId?: number;
          callerHint?: string;
        };
        if (args.chain !== 'evm' && args.chain !== 'solana') {
          return {
            ok: false,
            error: { code: -32602, message: "signMessage requires chain in ['evm', 'solana']" },
          };
        }
        if (typeof args.messageHex !== 'string' || args.messageHex.length === 0) {
          return {
            ok: false,
            error: { code: -32602, message: 'signMessage requires messageHex (hex string)' },
          };
        }
        if (args.chain === 'evm') {
          if (typeof args.evmChainId !== 'number' || !Number.isFinite(args.evmChainId)) {
            return {
              ok: false,
              error: { code: -32602, message: 'signMessage(evm) requires evmChainId (number)' },
            };
          }
        }

        const lock = getLockState();
        if (!lock.unlocked) {
          return {
            ok: false,
            error: { code: -32001, message: 'wallet is locked' },
          };
        }

        const result = await enqueueMcpSign({
          chain: args.chain as McpSignChain,
          messageHex: args.messageHex,
          evmChainId: args.chain === 'evm' ? args.evmChainId : undefined,
          callerHint: typeof args.callerHint === 'string' ? args.callerHint : undefined,
        });
        return { ok: true, result };
      }

      case 'sendSolanaTx': {
        const args = (_params ?? {}) as {
          to?: string;
          lamports?: string;
          mint?: string;
          amountRaw?: string;
          callerHint?: string;
        };
        if (typeof args.to !== 'string' || args.to.length === 0) {
          return {
            ok: false,
            error: { code: -32602, message: 'sendSolanaTx requires `to` (recipient solana address)' },
          };
        }
        const isSpl = typeof args.mint === 'string' && args.mint.length > 0;
        if (isSpl) {
          if (typeof args.amountRaw !== 'string' || !/^\d+$/.test(args.amountRaw)) {
            return {
              ok: false,
              error: { code: -32602, message: 'SPL `sendSolanaTx` requires `amountRaw` (positive decimal string in token base-units)' },
            };
          }
          if (args.lamports != null) {
            return {
              ok: false,
              error: { code: -32602, message: 'sendSolanaTx: cannot pass both `lamports` and `mint`/`amountRaw`; pick one' },
            };
          }
        } else {
          if (typeof args.lamports !== 'string' || !/^\d+$/.test(args.lamports)) {
            return {
              ok: false,
              error: { code: -32602, message: 'sendSolanaTx requires `lamports` (positive decimal string) for native transfers' },
            };
          }
          if (args.amountRaw != null) {
            return {
              ok: false,
              error: { code: -32602, message: 'sendSolanaTx: `amountRaw` requires `mint`. for native transfers pass `lamports` only.' },
            };
          }
        }
        const lock = getLockState();
        if (!lock.unlocked) {
          return { ok: false, error: { code: -32001, message: 'wallet is locked' } };
        }
        try {
          // policy gate: when the active vault is policy-gated AND the request fits within
          // the on-chain cap, skip the popup and call the underlying transfer directly.
          // above-cap, panicked, or cool-down -> existing popup path.
          const { maybeSkipPopupForPolicy } = await import('@/background/mcp/mcp-policy-gate');
          const { resolveSolDeclaredValueMicros, resolveSplDeclaredValueMicros } = await import(
            '@/background/policy-vault/policy-vault-sol-value'
          );
          const declaredValueMicros = isSpl
            ? await resolveSplDeclaredValueMicros(args.mint!, BigInt(args.amountRaw!))
            : await resolveSolDeclaredValueMicros(BigInt(args.lamports!));
          const gate = await maybeSkipPopupForPolicy({ declaredValueMicros });
          const { getSolanaAddress: getFrom } = await import('@/background/chains/solana');
          const fromAddress = await getFrom();

          if (gate.skipPopup) {
            // no popup: sign + broadcast directly. the on-chain `sign_with_policy` enforces
            // the cap (when SECP-via-Sui base; Solana ika base policy module ships in v2).
            let signature: string;
            if (isSpl) {
              const { sendSolanaSplTransfer } = await import('@/background/chains/solana-send-spl');
              signature = await sendSolanaSplTransfer(args.to, args.mint!, BigInt(args.amountRaw!));
            } else {
              const { sendSolanaNativeTransfer } = await import(
                '@/background/chains/solana-send-native'
              );
              signature = await sendSolanaNativeTransfer(args.to, BigInt(args.lamports!));
            }
            return {
              ok: true,
              result: {
                chain: 'solana',
                kind: isSpl ? 'spl' : 'native',
                from: fromAddress,
                to: args.to,
                ...(isSpl
                  ? { mint: args.mint, amountRaw: args.amountRaw }
                  : { lamports: args.lamports }),
                signature,
                policyGate: { skippedPopup: true, remainingMicros: gate.remainingMicros.toString() },
              },
            };
          }

          // fall back to popup-gated approval path.
          const { enqueueMcpSendSol } = await import('@/background/mcp/mcp-pending-sol-queue');
          const result = await enqueueMcpSendSol({
            to: args.to,
            lamports: isSpl ? undefined : args.lamports,
            mint: isSpl ? args.mint : undefined,
            amountRaw: isSpl ? args.amountRaw : undefined,
            callerHint: args.callerHint,
            fromAddress,
          });
          return {
            ok: true,
            result: {
              chain: 'solana',
              kind: isSpl ? 'spl' : 'native',
              from: result.signerAddress,
              to: args.to,
              ...(isSpl
                ? { mint: args.mint, amountRaw: args.amountRaw }
                : { lamports: args.lamports }),
              signature: result.signature,
              policyGate: { skippedPopup: false, reason: gate.reason },
            },
          };
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return { ok: false, error: { code: -32603, message: reason } };
        }
      }

      case 'sendEvmTx': {
        const args = (_params ?? {}) as {
          to?: string | null;
          value?: string;
          data?: string;
          chainId?: number;
          gas?: string;
          maxFeePerGas?: string;
          maxPriorityFeePerGas?: string;
          gasPrice?: string;
          nonce?: string;
          callerHint?: string;
        };
        if (typeof args.to !== 'string' || args.to.length === 0) {
          return {
            ok: false,
            error: { code: -32602, message: 'sendEvmTx requires `to` (recipient address)' },
          };
        }
        const lock = getLockState();
        if (!lock.unlocked) {
          return {
            ok: false,
            error: { code: -32001, message: 'wallet is locked' },
          };
        }

        // resolve chainId, network metadata, from address, and decoded preview before queueing.
        const active = await getActiveNetworks();
        const chainId = typeof args.chainId === 'number' ? args.chainId : active.evmChainId;
        const { evm: customEvm } = await getCustomNetworks();
        const evmNet = findEvmNetwork(chainId, customEvm);
        const from = await getEvmAddress();

        const value = args.value ?? '0x0';
        const data = args.data ?? '0x';
        const decoded = decodeTx(args.to, value, data, evmNet?.symbol ?? 'ETH', evmNet?.decimals ?? 18);

        // origin shown in the popup; prefix with `mcp:` so the user always sees the request did
        // not come from a website. callerHint (untrusted) tagged as a hint, not authority.
        const origin = `mcp:${args.callerHint?.replace(/[^\x20-\x7E]/g, '').slice(0, 64) ?? 'agent'}`;

        // policy gate: under-cap + non-panicked + non-cool-down -> skip popup; sign + broadcast
        // directly. above-cap / panicked / cool-down -> existing popup flow. declared value =
        // ETH wei * eth_price (resolved client-side; chain side enforces cap on hard-decoded
        // value when EVM hard-policy mode is active in `signBytesEvm`).
        try {
          const { maybeSkipPopupForPolicy } = await import('@/background/mcp/mcp-policy-gate');
          const valueWei = (() => {
            try {
              return value.startsWith('0x') ? BigInt(value) : BigInt(value);
            } catch {
              return 0n;
            }
          })();
          const { getPrice } = await import('@/background/services/price');
          const ethPrice = await getPrice('eth').catch(() => 0);
          const declaredValueMicros =
            valueWei > 0n && ethPrice > 0
              ? (valueWei * BigInt(Math.round(ethPrice * 1_000_000))) / 10n ** 18n
              : 0n;
          const gate = await maybeSkipPopupForPolicy({ declaredValueMicros });
          if (gate.skipPopup) {
            const { signAndBroadcastEvm } = await import('@/background/chains/evm-send');
            const txHash = await signAndBroadcastEvm({
              to: args.to,
              value,
              data,
              chainId,
              gas: typeof args.gas === 'string' ? args.gas : null,
              maxFeePerGas: typeof args.maxFeePerGas === 'string' ? args.maxFeePerGas : null,
              maxPriorityFeePerGas: typeof args.maxPriorityFeePerGas === 'string' ? args.maxPriorityFeePerGas : null,
              gasPrice: typeof args.gasPrice === 'string' ? args.gasPrice : null,
              nonce: typeof args.nonce === 'string' ? args.nonce : null,
              dappOrigin: origin,
            });
            return {
              ok: true,
              result: {
                chain: 'evm',
                chainId,
                from,
                to: args.to,
                txHash,
                policyGate: { skippedPopup: true, remainingMicros: gate.remainingMicros.toString() },
              },
            };
          }

          const result = await enqueueTxApproval({
            origin,
            chainId,
            from,
            to: args.to,
            value,
            data,
            gas: typeof args.gas === 'string' ? args.gas : null,
            maxFeePerGas: typeof args.maxFeePerGas === 'string' ? args.maxFeePerGas : null,
            maxPriorityFeePerGas: typeof args.maxPriorityFeePerGas === 'string' ? args.maxPriorityFeePerGas : null,
            gasPrice: typeof args.gasPrice === 'string' ? args.gasPrice : null,
            nonce: typeof args.nonce === 'string' ? args.nonce : null,
            decoded,
          });
          if (result.kind !== 'broadcast') {
            return {
              ok: false,
              error: { code: -32603, message: `expected broadcast result on sendEvmTx, got '${result.kind}'` },
            };
          }
          return {
            ok: true,
            result: {
              chain: 'evm',
              chainId,
              from,
              to: args.to,
              txHash: result.txHash,
              policyGate: { skippedPopup: false, reason: gate.reason },
            },
          };
        } catch (e) {
          const reason = e instanceof Error ? e.message : String(e);
          return { ok: false, error: { code: -32603, message: reason } };
        }
      }

      case 'signTransaction': {
        const args = (_params ?? {}) as {
          to?: string | null;
          value?: string;
          data?: string;
          chainId?: number;
          gas?: string;
          maxFeePerGas?: string;
          maxPriorityFeePerGas?: string;
          gasPrice?: string;
          nonce?: string;
          callerHint?: string;
        };
        if (typeof args.to !== 'string' || args.to.length === 0) {
          return {
            ok: false,
            error: { code: -32602, message: 'signTransaction requires `to` (recipient address)' },
          };
        }
        const lock = getLockState();
        if (!lock.unlocked) {
          return {
            ok: false,
            error: { code: -32001, message: 'wallet is locked' },
          };
        }

        const active = await getActiveNetworks();
        const chainId = typeof args.chainId === 'number' ? args.chainId : active.evmChainId;
        const { evm: customEvm } = await getCustomNetworks();
        const evmNet = findEvmNetwork(chainId, customEvm);
        const from = await getEvmAddress();

        const value = args.value ?? '0x0';
        const data = args.data ?? '0x';
        const decoded = decodeTx(args.to, value, data, evmNet?.symbol ?? 'ETH', evmNet?.decimals ?? 18);

        const origin = `mcp:${args.callerHint?.replace(/[^\x20-\x7E]/g, '').slice(0, 64) ?? 'agent'}`;

        const result = await enqueueTxApproval({
          origin,
          chainId,
          from,
          to: args.to,
          value,
          data,
          gas: typeof args.gas === 'string' ? args.gas : null,
          maxFeePerGas: typeof args.maxFeePerGas === 'string' ? args.maxFeePerGas : null,
          maxPriorityFeePerGas: typeof args.maxPriorityFeePerGas === 'string' ? args.maxPriorityFeePerGas : null,
          gasPrice: typeof args.gasPrice === 'string' ? args.gasPrice : null,
          nonce: typeof args.nonce === 'string' ? args.nonce : null,
          decoded,
          signOnly: true,
        });
        if (result.kind !== 'sign-only') {
          return {
            ok: false,
            error: { code: -32603, message: `expected sign-only result on signTransaction, got '${result.kind}'` },
          };
        }
        return {
          ok: true,
          result: {
            chain: 'evm',
            chainId,
            from,
            to: args.to,
            signedRawTx: result.signedRawTx,
            txHash: result.txHash,
          },
        };
      }

      default:
        return {
          ok: false,
          error: { code: -32601, message: `unknown tool: ${name}` },
        };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { code: -32603, message } };
  }
}
