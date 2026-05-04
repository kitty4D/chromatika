import { TypedDataEncoder, type TypedDataField } from 'ethers';
import type { DappBridgeResponse } from '@/lib/dapp-bridge-result';
import { RPC_USER_REJECTED } from '@/lib/dapp-bridge-result';
import { getSession } from '@/background/session';
import { getEvmAddressForDwalletId, getEvmAddressForOrigin } from '@/background/chains/evm';
import {
  resolveEd25519DwalletIdForConnect,
  resolveEd25519DwalletIdForDapp,
  resolveSecpDwalletIdForConnect,
} from '@/background/dapp-dwallet-resolve';
import type { DappConnectFamily } from '@/background/dapp-approval';
import type { DappConsentMode } from '@/background/dapp-consent-mode';
import {
  getPermission,
  grantPermission,
  upsertPermission,
  recordEthAccountsEip2255,
} from '@/background/dapp-permissions';
import { getActiveNetworks, setActiveNetworks } from '@/background/network/active-network';
import { setDwalletNetworkSettings } from '@/background/network/tier-network-settings';
import { enqueueDappApproval } from '@/background/dapp-approval';
import {
  getActiveVaultId,
  refreshSessionNetworkClients,
} from '@/background/wallet-service';

export type DappPageRequest = {
  id: string;
  method: string;
  params?: unknown[];
};

export type LogFn = (
  ok: boolean,
  reason?: string,
  extra?: { solanaEncryptProgram?: boolean },
) => Promise<void>;

export type BridgeCtx = {
  method: string;
  params: unknown[] | undefined;
  origin: string;
  consentMode: DappConsentMode;
  log: LogFn;
};

export const LEGACY_ETH_SIGN_MSG =
  'Chromatika does not support eth_sign (opaque preimage, high phishing risk). Use personal_sign or eth_signTypedData_v4. If you have a legitimate compatibility need, contact the Chromatika maintainers.';

export const LEGACY_ETH_SIGN_TYPED_DATA_V1_MSG =
  'Chromatika does not support legacy eth_signTypedData (v1). Use eth_signTypedData_v3 or eth_signTypedData_v4. If you need v1, contact the Chromatika maintainers.';

export const ETH_SEND_RAW_UNSUPPORTED_MSG =
  'Chromatika does not expose eth_sendRawTransaction on the injected provider. Use eth_sendTransaction for wallet-mediated sends.';

export const LEGACY_ENC_API_MSG =
  'Chromatika does not support eth_decrypt or eth_getEncryptionPublicKey (legacy encryption RPCs).';

/** never forward these to `sendEvmRpcWithRetry` - they need wallet crypto or must be rejected explicitly. */
export const MUST_NOT_PROXY_ETH = new Set([
  'eth_requestAccounts',
  'eth_accounts',
  'eth_chainId',
  'eth_sendTransaction',
  'eth_sendRawTransaction',
  'eth_sign',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
  'eth_decrypt',
  'eth_getEncryptionPublicKey',
]);

export async function setEvmActiveForDapp(chainId: number): Promise<void> {
  const vid = getActiveVaultId();
  if (vid) {
    await setDwalletNetworkSettings(vid, { evmChainId: chainId });
    await refreshSessionNetworkClients();
  } else {
    await setActiveNetworks({ evmChainId: chainId });
  }
}

export function parseWalletPermissionObjectKeys(params: unknown[] | undefined): string[] {
  const first = params?.[0];
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return Object.keys(first as Record<string, unknown>);
  }
  return [];
}

type Eip712Payload = {
  domain: Parameters<typeof TypedDataEncoder.hashDomain>[0];
  types: Record<string, TypedDataField[]>;
  primaryType?: string;
  message: Record<string, unknown>;
};

export function solanaWireFromBridgeParam(p: unknown): Uint8Array {
  if (p && typeof p === 'object' && Array.isArray((p as { wire?: unknown }).wire)) {
    return Uint8Array.from((p as { wire: number[] }).wire);
  }
  if (Array.isArray(p)) return Uint8Array.from(p);
  throw new Error('expected serialized transaction { wire: number[] }');
}

export function parseEip712Payload(raw: unknown): {
  domain: Parameters<typeof TypedDataEncoder.hashDomain>[0];
  cleanTypes: Record<string, TypedDataField[]>;
  value: Record<string, unknown>;
} {
  const typedData =
    typeof raw === 'string' ? (JSON.parse(raw) as Eip712Payload) : (raw as Eip712Payload);
  const { domain, types, message: value } = typedData;
  if (!domain || !types || value === undefined) throw new Error('Invalid EIP-712 payload');
  const { EIP712Domain: _removed, ...cleanTypes } = types;
  void _removed;
  return { domain, cleanTypes, value };
}

export async function ensureEthAccountsForOrigin(
  origin: string,
  methodLabel: string,
  log: LogFn,
): Promise<{ ok: true; address: string } | { ok: false; error: string; code?: number }> {
  const s = getSession();
  if (!s) return { ok: false, error: 'Wallet locked' };
  const permission = await getPermission(origin);
  const { evmChainId } = await getActiveNetworks();
  if (!permission?.scope.accounts) {
    const approval = await enqueueDappApproval({
      kind: 'connect',
      origin,
      method: methodLabel,
      chainId: evmChainId,
    });
    if (!approval.approved) {
      await log(false, 'user_rejected_connect');
      return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
    }
    const chosenId = await resolveSecpDwalletIdForConnect(s.activeVaultId, approval.secpDwalletId);
    const address = await getEvmAddressForDwalletId(chosenId);
    await grantPermission(origin);
    await upsertPermission(origin, {
      selectedAddress: address,
      selectedCurve: 'SECP256K1',
      selectedDwalletId: chosenId,
      scope: { accounts: true, chainIds: [evmChainId] },
    });
    await recordEthAccountsEip2255(origin, address);
    return { ok: true, address };
  }
  const address = await getEvmAddressForOrigin(origin);
  await upsertPermission(origin, {
    selectedAddress: address,
    selectedCurve: 'SECP256K1',
    scope: { accounts: true, chainIds: [evmChainId] },
  });
  await recordEthAccountsEip2255(origin, address);
  return { ok: true, address };
}

/** Sui / Solana / Aptos: same permission `scope.accounts` as EVM; stores active vault ED25519 dWallet id for the site. */
export async function ensureNonEvmConnectedForOrigin(
  origin: string,
  connectFamily: DappConnectFamily,
  methodLabel: string,
  log: LogFn,
): Promise<{ ok: true } | { ok: false; error: string; code?: number }> {
  const s = getSession();
  if (!s) return { ok: false, error: 'Wallet locked' };
  const permission = await getPermission(origin);
  if (permission?.scope.accounts) {
    const edId = await resolveEd25519DwalletIdForDapp(origin);
    await upsertPermission(origin, {
      selectedEd25519DwalletId: edId,
      scope: {
        accounts: true,
        chainIds: permission.scope.chainIds,
        canSignPersonal: permission.scope.canSignPersonal,
        canSignTypedData: permission.scope.canSignTypedData,
        canSendTransaction: permission.scope.canSendTransaction,
        canAddChain: permission.scope.canAddChain,
        canSwitchChain: permission.scope.canSwitchChain,
      },
    });
    return { ok: true };
  }
  const { evmChainId } = await getActiveNetworks();
  const approval = await enqueueDappApproval({
    kind: 'connect',
    origin,
    method: methodLabel,
    connectFamily,
    chainId: evmChainId,
  });
  if (!approval.approved) {
    await log(false, 'user_rejected_non_evm_connect');
    return { ok: false, error: 'User rejected the request', code: RPC_USER_REJECTED };
  }
  const ed25519DwalletId = await resolveEd25519DwalletIdForConnect(
    s.activeVaultId,
    approval.ed25519DwalletId,
  );
  await grantPermission(origin);
  const prev = await getPermission(origin);
  await upsertPermission(origin, {
    selectedEd25519DwalletId: ed25519DwalletId,
    scope: {
      accounts: true,
      chainIds:
        prev?.scope.chainIds && prev.scope.chainIds.length > 0 ? prev.scope.chainIds : [evmChainId],
      canSignPersonal: prev?.scope.canSignPersonal ?? true,
      canSignTypedData: prev?.scope.canSignTypedData ?? true,
      canSendTransaction: prev?.scope.canSendTransaction ?? true,
      canAddChain: prev?.scope.canAddChain ?? false,
      canSwitchChain: prev?.scope.canSwitchChain ?? true,
    },
  });
  return { ok: true };
}

export type HandlerResult = DappBridgeResponse | null;
