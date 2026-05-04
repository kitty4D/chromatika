/**
 * thin HTTP client for the DeSo node API. we hit construct + read endpoints directly with
 * `fetch`, no SDK dependency. endpoints documented in `wallet-extension/docs/DESO_SPIKE.md`.
 *
 * the node URL is read at call time from chrome.storage so user overrides take effect without
 * a SW restart.
 */

import {
  DESO_DEFAULT_NODE_MAINNET,
  DESO_DEFAULT_MIN_FEE_RATE_NANOS_PER_KB,
  DESO_ENDPOINTS,
  DESO_NODE_STORAGE_KEY,
} from '@/background/chains/deso/deso-constants';

const FETCH_TIMEOUT_MS = 25_000;

async function readNodeUrl(): Promise<string> {
  return new Promise((resolve) => {
    chrome.storage.local.get([DESO_NODE_STORAGE_KEY], (r) => {
      const v = r[DESO_NODE_STORAGE_KEY];
      if (typeof v === 'string' && v.trim().length > 0) resolve(v.trim());
      else resolve(DESO_DEFAULT_NODE_MAINNET);
    });
  });
}

export async function setDeSoNodeUrl(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [DESO_NODE_STORAGE_KEY]: url }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

export async function getDeSoNodeUrl(): Promise<string> {
  return readNodeUrl();
}

async function postJson<T = unknown>(path: string, body: unknown): Promise<T> {
  const base = (await readNodeUrl()).replace(/\/$/, '');
  const url = `${base}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DeSo ${path} returned ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!text || text.trim().length === 0) {
    return {} as T;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`DeSo ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

export interface ConstructSendDeSoResponse {
  /** hex-encoded unsigned transaction bytes ending in `00` (empty signature placeholder). */
  TransactionHex: string;
  TransactionIDBase58Check?: string;
  TotalInputNanos?: number;
  SpendAmountNanos?: number;
  ChangeAmountNanos?: number;
  FeeNanos?: number;
}

export async function constructSendDeSo(args: {
  senderPublicKeyBase58Check: string;
  recipientPublicKeyOrUsername: string;
  amountNanos: bigint;
  minFeeRateNanosPerKB?: number;
}): Promise<ConstructSendDeSoResponse> {
  return postJson(DESO_ENDPOINTS.sendDeso, {
    SenderPublicKeyBase58Check: args.senderPublicKeyBase58Check,
    RecipientPublicKeyOrUsername: args.recipientPublicKeyOrUsername,
    AmountNanos: Number(args.amountNanos),
    MinFeeRateNanosPerKB: args.minFeeRateNanosPerKB ?? DESO_DEFAULT_MIN_FEE_RATE_NANOS_PER_KB,
    TransactionFees: [],
  });
}

export interface SubmitTransactionResponse {
  Transaction?: unknown;
  TxnHashHex?: string;
  PostEntryResponse?: unknown;
}

export async function submitTransaction(signedHex: string): Promise<SubmitTransactionResponse> {
  return postJson(DESO_ENDPOINTS.submitTransaction, { TransactionHex: signedHex });
}

export interface ConstructSubmitPostResponse {
  TransactionHex: string;
  PostHashHex?: string;
}

export async function constructSubmitPost(args: {
  updaterPublicKeyBase58Check: string;
  body: string;
  imageUrls?: string[];
  videoUrls?: string[];
  minFeeRateNanosPerKB?: number;
}): Promise<ConstructSubmitPostResponse> {
  return postJson(DESO_ENDPOINTS.submitPost, {
    UpdaterPublicKeyBase58Check: args.updaterPublicKeyBase58Check,
    BodyObj: {
      Body: args.body,
      ImageURLs: args.imageUrls ?? [],
      VideoURLs: args.videoUrls ?? [],
    },
    MinFeeRateNanosPerKB: args.minFeeRateNanosPerKB ?? DESO_DEFAULT_MIN_FEE_RATE_NANOS_PER_KB,
  });
}

export interface DeSoUserStateless {
  PublicKeyBase58Check: string;
  BalanceNanos: number;
  ProfileEntryResponse?: { Username?: string; Description?: string } | null;
}

export interface GetUsersStatelessResponse {
  UserList?: DeSoUserStateless[];
  DefaultFeeRateNanosPerKB?: number;
}

export async function getUsersStateless(
  publicKeysBase58Check: string[],
): Promise<GetUsersStatelessResponse> {
  return postJson(DESO_ENDPOINTS.getUsersStateless, {
    PublicKeysBase58Check: publicKeysBase58Check,
    SkipForLeaderBoard: true,
  });
}

/**
 * `/api/v0/authorize-derived-key`: construct an unsigned AuthorizeDerivedKey tx (`TxnType=22`)
 * from the (owner, derived, spendingLimitHex, accessSignature, expirationBlock) tuple. owner
 * signs the returned `TransactionHex` via Identity `/approve` before we splice + submit.
 *
 * reference: `wallet-extension/docs/DESO_DERIVED_KEY_SPIKE.md` section 1.
 */
export interface ConstructAuthorizeDerivedKeyResponse {
  TransactionHex: string;
  Transaction?: unknown;
  FeeNanos?: number;
  SpendAmountNanos?: number;
}

export async function constructAuthorizeDerivedKey(args: {
  ownerPublicKeyBase58Check: string;
  derivedPublicKeyBase58Check: string;
  expirationBlock: number;
  accessSignatureHex: string;
  transactionSpendingLimitHex: string;
  deleteKey?: boolean;
  derivedKeySignature?: boolean;
  memo?: string;
  appName?: string;
  minFeeRateNanosPerKB?: number;
}): Promise<ConstructAuthorizeDerivedKeyResponse> {
  return postJson('/api/v0/authorize-derived-key', {
    OwnerPublicKeyBase58Check: args.ownerPublicKeyBase58Check,
    DerivedPublicKeyBase58Check: args.derivedPublicKeyBase58Check,
    ExpirationBlock: args.expirationBlock,
    AccessSignature: args.accessSignatureHex,
    DeleteKey: args.deleteKey ?? false,
    DerivedKeySignature: args.derivedKeySignature ?? false,
    TransactionSpendingLimitHex: args.transactionSpendingLimitHex,
    Memo: args.memo,
    AppName: args.appName,
    MinFeeRateNanosPerKB: args.minFeeRateNanosPerKB ?? DESO_DEFAULT_MIN_FEE_RATE_NANOS_PER_KB,
    TransactionFees: [],
    ExtraData: {},
  });
}

/**
 * `/api/v0/get-transaction-spending-limit-hex-string`: server-side serialization of the spending
 * limit JSON. same bytes are what AccessSignature signs over, so we feed the response back into
 * the AuthorizeDerivedKey tx to keep the digest aligned.
 *
 * generic input shape: caller passes the same JSON the upstream `TransactionSpendingLimitResponseOptions`
 * accepts. v0 chromatika ships only `{ IsUnlimited: true }`, v1 will add scoped variants.
 */
export async function getTransactionSpendingLimitHex(
  spendingLimit: Record<string, unknown>,
): Promise<string> {
  const res = await postJson<{ HexString?: string }>(
    '/api/v0/get-transaction-spending-limit-hex-string',
    { TransactionSpendingLimit: spendingLimit },
  );
  if (!res.HexString) {
    throw new Error('get-transaction-spending-limit-hex-string returned no HexString');
  }
  return res.HexString;
}

/**
 * `/api/v0/get-user-derived-keys`: owner-side lookup of all derived keys + their validity.
 * used by chromatika to verify the AuthorizeDerivedKey tx landed before claiming "linked".
 */
export interface UserDerivedKeyEntry {
  OwnerPublicKeyBase58Check: string;
  DerivedPublicKeyBase58Check: string;
  ExpirationBlock: number;
  IsValid: boolean;
  /** some node deployments include this, chromatika doesn't depend on it. */
  TransactionSpendingLimitTotal?: number;
}

export interface GetUserDerivedKeysResponse {
  /** keyed by `DerivedPublicKeyBase58Check`. empty object when the owner has no derived keys. */
  DerivedKeys: Record<string, UserDerivedKeyEntry>;
}

export async function getUserDerivedKeys(
  ownerPublicKeyBase58Check: string,
): Promise<GetUserDerivedKeysResponse> {
  const res = await postJson<{ DerivedKeys?: Record<string, UserDerivedKeyEntry> }>(
    '/api/v0/get-user-derived-keys',
    { PublicKeyBase58Check: ownerPublicKeyBase58Check },
  );
  return { DerivedKeys: res.DerivedKeys ?? {} };
}
