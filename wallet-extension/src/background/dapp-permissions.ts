import { STORAGE_KEYS } from '@/background/storage';

const PERMISSIONS_KEY = STORAGE_KEYS.DAPP_PERMISSIONS_V2;
const LEGACY_PERMISSIONS_KEY = STORAGE_KEYS.DAPP_PERMISSIONS_V1_LEGACY;

/** EIP-2255 wallet permission object (MetaMask-compatible shape). */
export type Eip2255Caveat =
  | { type: 'restrictReturnedAccounts'; value: string[] }
  | { type: 'filterResponse'; value: Record<string, string> };

export type Eip2255WalletPermission = {
  id: string;
  parentCapability: string;
  invoker: string;
  date: number;
  caveats: Eip2255Caveat[];
};

export type DappPermissionScope = {
  accounts: boolean;
  chainIds: number[];
  canSignPersonal: boolean;
  canSignTypedData: boolean;
  canSendTransaction: boolean;
  canAddChain: boolean;
  canSwitchChain: boolean;
};

export type DappPermissionRecord = {
  grantedAt: number;
  updatedAt: number;
  selectedAddress?: string;
  selectedCurve?: 'SECP256K1' | 'ED25519';
  /** SECP256K1 dWallet for EVM when connected. */
  selectedDwalletId?: string;
  /** ED25519 dWallet for Sui / Solana / Aptos dApps when connected. */
  selectedEd25519DwalletId?: string;
  /** persisted EIP-2255 objects keyed by parentCapability (e.g. eth_accounts). */
  eip2255ByCapability?: Record<string, Eip2255WalletPermission>;
  scope: DappPermissionScope;
};

type PermissionsStore = Record<string, DappPermissionRecord>;
type LegacyPermissionsStore = Record<string, { grantedAt: number }>;

async function load(): Promise<PermissionsStore> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get([PERMISSIONS_KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[PERMISSIONS_KEY] as PermissionsStore) ?? {});
    });
  });
}

async function save(store: PermissionsStore): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [PERMISSIONS_KEY]: store }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function checkPermission(origin: string): Promise<boolean> {
  const rec = await getPermission(origin);
  return !!rec?.scope.accounts;
}

export async function grantPermission(origin: string): Promise<void> {
  const now = Date.now();
  const store = await loadWithLegacyFallback();
  const existing = store[origin];
  const scope: DappPermissionScope = existing?.scope ?? {
    accounts: true,
    chainIds: [],
    canSignPersonal: true,
    canSignTypedData: true,
    canSendTransaction: true,
    canAddChain: false,
    canSwitchChain: true,
  };
  store[origin] = {
    grantedAt: existing?.grantedAt ?? now,
    updatedAt: now,
    selectedAddress: existing?.selectedAddress,
    selectedCurve: existing?.selectedCurve,
    selectedDwalletId: existing?.selectedDwalletId,
    selectedEd25519DwalletId: existing?.selectedEd25519DwalletId,
    scope: { ...scope, accounts: true },
  };
  await save(store);
}

export async function revokePermission(origin: string): Promise<void> {
  const store = await loadWithLegacyFallback();
  delete store[origin];
  await save(store);
}

export async function getAllPermissions(): Promise<Record<string, DappPermissionRecord>> {
  return loadWithLegacyFallback();
}

export async function getPermission(origin: string): Promise<DappPermissionRecord | null> {
  const store = await loadWithLegacyFallback();
  return store[origin] ?? null;
}

export async function upsertPermission(
  origin: string,
  patch: Partial<Omit<DappPermissionRecord, 'grantedAt' | 'scope'>> & {
    scope?: Partial<DappPermissionScope>;
    eip2255ByCapability?: Record<string, Eip2255WalletPermission>;
  },
): Promise<DappPermissionRecord> {
  const now = Date.now();
  const store = await loadWithLegacyFallback();
  const prev = store[origin];
  const next: DappPermissionRecord = {
    grantedAt: prev?.grantedAt ?? now,
    updatedAt: now,
    selectedAddress: patch.selectedAddress ?? prev?.selectedAddress,
    selectedCurve: patch.selectedCurve ?? prev?.selectedCurve,
    selectedDwalletId: patch.selectedDwalletId ?? prev?.selectedDwalletId,
    selectedEd25519DwalletId: patch.selectedEd25519DwalletId ?? prev?.selectedEd25519DwalletId,
    eip2255ByCapability: patch.eip2255ByCapability ?? prev?.eip2255ByCapability,
    scope: {
      accounts: patch.scope?.accounts ?? prev?.scope.accounts ?? false,
      chainIds: patch.scope?.chainIds ?? prev?.scope.chainIds ?? [],
      canSignPersonal: patch.scope?.canSignPersonal ?? prev?.scope.canSignPersonal ?? false,
      canSignTypedData: patch.scope?.canSignTypedData ?? prev?.scope.canSignTypedData ?? false,
      canSendTransaction: patch.scope?.canSendTransaction ?? prev?.scope.canSendTransaction ?? false,
      canAddChain: patch.scope?.canAddChain ?? prev?.scope.canAddChain ?? false,
      canSwitchChain: patch.scope?.canSwitchChain ?? prev?.scope.canSwitchChain ?? false,
    },
  };
  store[origin] = next;
  await save(store);
  return next;
}

const NON_EVM_SIGN_METHODS = new Set([
  'sui_signPersonalMessage',
  'sui_signTransaction',
  'sui_signAndExecuteTransaction',
  'solana_signMessage',
  'solana_signTransaction',
  'solana_signAllTransactions',
  'aptos_signMessage',
  'aptos_signAndSubmitTransaction',
]);

export function canUseMethod(permission: DappPermissionRecord | null, method: string): boolean {
  if (!permission) return false;
  if (!permission.scope.accounts) return false;
  if (method === 'eth_sendTransaction') return permission.scope.canSendTransaction;
  if (method === 'personal_sign') return permission.scope.canSignPersonal;
  if (method === 'eth_signTypedData_v4' || method === 'eth_signTypedData_v3') {
    return permission.scope.canSignTypedData;
  }
  if (NON_EVM_SIGN_METHODS.has(method)) return permission.scope.canSendTransaction;
  if (method === 'wallet_addEthereumChain') return true;
  if (method === 'wallet_switchEthereumChain') return true;
  if (method === 'wallet_watchAsset') return true;
  if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return true;
  return true;
}

function newEthAccountsPermission(origin: string, address: string): Eip2255WalletPermission {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `perm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id,
    parentCapability: 'eth_accounts',
    invoker: origin,
    date: Date.now(),
    caveats: [
      { type: 'restrictReturnedAccounts', value: [address] },
      {
        type: 'filterResponse',
        value: { authorizedEvmAddress: address },
      },
    ],
  };
}

/** call after eth_accounts is granted / address is known so wallet_getPermissions stays consistent. */
export async function recordEthAccountsEip2255(origin: string, evmAddress: string): Promise<Eip2255WalletPermission> {
  const prev = await getPermission(origin);
  const existing = prev?.eip2255ByCapability?.eth_accounts;
  const addrLower = evmAddress.toLowerCase();
  const stillValid =
    existing?.invoker === origin &&
    existing.caveats.some(
      (c) => c.type === 'restrictReturnedAccounts' && c.value.some((a) => a.toLowerCase() === addrLower),
    );
  if (existing && stillValid) return existing;

  const perm = newEthAccountsPermission(origin, evmAddress);
  const eip2255ByCapability = { ...(prev?.eip2255ByCapability ?? {}), eth_accounts: perm };
  await upsertPermission(origin, { eip2255ByCapability });
  return perm;
}

/** return stored EIP-2255 permission objects for this origin (optionally filter by capability names). */
export async function getEip2255PermissionsFiltered(
  origin: string,
  requestedCapabilities?: string[],
): Promise<Eip2255WalletPermission[]> {
  const rec = await getPermission(origin);
  const map = rec?.eip2255ByCapability ?? {};
  const values = Object.values(map);
  if (!requestedCapabilities?.length) return values;
  const want = new Set(requestedCapabilities);
  return values.filter((p) => want.has(p.parentCapability));
}

export function canAccessChain(permission: DappPermissionRecord | null, chainId: number): boolean {
  if (!permission) return false;
  if (permission.scope.chainIds.length === 0) return true;
  return permission.scope.chainIds.includes(chainId);
}

async function loadWithLegacyFallback(): Promise<PermissionsStore> {
  const current = await load();
  if (Object.keys(current).length > 0) return current;

  const legacy = await new Promise<LegacyPermissionsStore>((resolve, reject) => {
    chrome.storage.local.get([LEGACY_PERMISSIONS_KEY], (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve((r[LEGACY_PERMISSIONS_KEY] as LegacyPermissionsStore) ?? {});
    });
  });
  if (Object.keys(legacy).length === 0) return {};

  const migrated: PermissionsStore = {};
  for (const [origin, rec] of Object.entries(legacy)) {
    const grantedAt = rec?.grantedAt ?? Date.now();
    migrated[origin] = {
      grantedAt,
      updatedAt: grantedAt,
      scope: {
        accounts: true,
        chainIds: [],
        canSignPersonal: true,
        canSignTypedData: true,
        canSendTransaction: true,
        canAddChain: false,
        canSwitchChain: true,
      },
    };
  }
  await save(migrated);
  return migrated;
}
