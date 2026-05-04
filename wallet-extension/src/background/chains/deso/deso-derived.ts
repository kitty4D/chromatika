/**
 * DeSo derived-key delegation. lets an existing DeSo user authorize chromatika's dWallet pubkey
 * as a derived key on their account, so chromatika sends + posts on their behalf without ever
 * holding the owner key. built directly on the in-tree primitives:
 *
 *   - dWallet SECP pubkey  (`getDwalletSecpPublicKey()` -> `encodeDeSoAddress()`)  = derived key
 *   - existing DoubleSHA256 + SEQUENCE-tag-mutation signing path = produces wire-form derived
 *     signatures with zero plumbing changes (per `wallet-extension/docs/DESO_DERIVED_KEY_SPIKE.md`)
 *
 * two-step user flow (path A in the spike):
 *   1. Identity `/derive` window - owner consents, we get back `accessSignature + expirationBlock
 *      + transactionSpendingLimitHex`.
 *   2. Identity `/approve` window - owner signs the AuthorizeDerivedKey tx we construct from (1).
 *
 * UI side opens both windows via `window.open` from the side panel + listens for the
 * `'message'` event (deso-js convention). this module is pure data + node calls, no DOM, no
 * chrome.windows. fully unit-testable.
 *
 * storage: `chromatika_deso_owner_link_v1_<vaultId>` chrome.storage.local. one link per vault
 * (each vault has its own dWallet -> own DeSo identity). switching vaults = different link
 * picture.
 *
 * v0 ships **unlimited** spending limit ("god-mode-with-expiry"). tighter scoping
 * (TransactionCountLimitMap, GlobalDESOLimit) is v1 alongside the per-action UI, the wire
 * format already supports it via the JSON shape we hand to Identity.
 */

import { getSession } from '@/background/session';
import { getDwalletSecpPublicKey } from '@/background/chains/bitcoin';
import { encodeDeSoAddress } from '@/background/chains/deso/deso-address';
import { bytesToHex } from '@/background/chains/deso/deso-signature';
import {
  constructAuthorizeDerivedKey,
  getTransactionSpendingLimitHex,
  getUserDerivedKeys,
  submitTransaction,
} from '@/background/chains/deso/deso-node-client';

/** default Identity service. override for testing only. */
export const DESO_IDENTITY_ORIGIN_DEFAULT = 'https://identity.deso.org';

/** v0 default expiration window (days from now). UI may override. */
export const DESO_DEFAULT_EXPIRATION_DAYS = 30;

/** memo + AppName surfaced on-chain so the owner sees who they delegated to. */
export const DESO_DELEGATION_MEMO = 'chromatika delegation';
export const DESO_DELEGATION_APP_NAME = 'chromatika';

import { VAULT_SCOPED_KEYS } from '@/background/storage';

function storageKey(vaultId: string): string {
  return VAULT_SCOPED_KEYS.desoOwnerLink(vaultId);
}

/**
 * spending-limit shape for v0. matches the relevant subset of upstream
 * `TransactionSpendingLimitResponseOptions`. we expose `kind:'unlimited'` as the only v0 variant
 * for the link UI, but the actual JSON we send Identity is the upstream shape `{ IsUnlimited: true }`.
 */
export type DeSoSpendingLimitV0 = { kind: 'unlimited' };

/** persisted link record. */
export interface DeSoOwnerLink {
  ownerPubkeyBase58Check: string;
  /** chromatika's dWallet pubkey base58check (the derived key). */
  derivedPubkeyBase58Check: string;
  /** chromatika's dWallet pubkey 33-byte compressed, hex-encoded. */
  derivedPubkeyHexCompressed: string;
  spendingLimit: DeSoSpendingLimitV0;
  /** hex bytes the AccessSignature was made over (Identity-echoed, falls back to our own encode). */
  spendingLimitHex: string;
  /** block height after which this delegation no longer signs. */
  expirationBlock: number;
  /** wall-clock at storage write. */
  authorizedAtMs: number;
  /** AuthorizeDerivedKey tx hash on chain. */
  txnHashHex: string;
  /** first time we polled `/get-user-derived-keys` and saw `IsValid: true`. null = unverified. */
  verifiedAtMs: number | null;
  /** Identity service origin used. audit trail in case of rotation. */
  identityServiceOrigin: string;
}

/** read the persisted link for a vault. */
export async function getDeSoOwnerLinkForVault(vaultId: string): Promise<DeSoOwnerLink | null> {
  const key = storageKey(vaultId);
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (r) => {
      const v = r[key];
      if (v && typeof v === 'object') resolve(v as DeSoOwnerLink);
      else resolve(null);
    });
  });
}

/** read the link for the active vault (or null if locked / no active vault / no link). */
export async function getActiveDeSoOwnerLink(): Promise<DeSoOwnerLink | null> {
  const s = getSession();
  if (!s?.activeVaultId) return null;
  return getDeSoOwnerLinkForVault(s.activeVaultId);
}

/** write the link for a vault. */
async function writeDeSoOwnerLink(vaultId: string, link: DeSoOwnerLink): Promise<void> {
  const key = storageKey(vaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: link }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** clear the link for the active vault. local only, on-chain key stays valid until expiry. */
export async function clearActiveDeSoOwnerLink(): Promise<void> {
  const s = getSession();
  if (!s?.activeVaultId) return;
  const key = storageKey(s.activeVaultId);
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove([key], () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

/** patch the verifiedAtMs field. idempotent. no-op if no link exists. */
async function markActiveDeSoOwnerLinkVerified(): Promise<void> {
  const s = getSession();
  if (!s?.activeVaultId) return;
  const link = await getDeSoOwnerLinkForVault(s.activeVaultId);
  if (!link || link.verifiedAtMs) return;
  await writeDeSoOwnerLink(s.activeVaultId, { ...link, verifiedAtMs: Date.now() });
}

/**
 * resolve the active vault's effective DeSo "send identity":
 * - when delegation is active and verified: the OWNER pubkey is what goes in the
 *   `SenderPublicKeyBase58Check` field of the construct request, while signing still uses our
 *   dWallet MPC key. chain detects derived signing via the SEQUENCE-tag mutation we already emit.
 * - otherwise: dWallet pubkey is the on-chain identity (the v0 default).
 */
export async function getEffectiveDeSoSendIdentity(): Promise<{
  sendAsPubkeyBase58Check: string;
  signingCompressedPubkey: Uint8Array;
  signingPubkeyBase58Check: string;
  isDelegated: boolean;
  ownerPubkeyBase58Check?: string;
  expirationBlock?: number;
}> {
  const compressed = await getDwalletSecpPublicKey();
  const dwalletAddr = encodeDeSoAddress(compressed, 'mainnet');
  const link = await getActiveDeSoOwnerLink();
  if (link) {
    return {
      sendAsPubkeyBase58Check: link.ownerPubkeyBase58Check,
      signingCompressedPubkey: compressed,
      signingPubkeyBase58Check: dwalletAddr,
      isDelegated: true,
      ownerPubkeyBase58Check: link.ownerPubkeyBase58Check,
      expirationBlock: link.expirationBlock,
    };
  }
  return {
    sendAsPubkeyBase58Check: dwalletAddr,
    signingCompressedPubkey: compressed,
    signingPubkeyBase58Check: dwalletAddr,
    isDelegated: false,
  };
}

/**
 * pre-compute the spending-limit hex via the node so we know the exact bytes the AccessSignature
 * will need to verify against. Identity *should* echo the same hex back, but we keep our own copy
 * as a fallback / source of truth.
 *
 * v0 only emits `{ IsUnlimited: true }`. the function is shaped so v1 scoped variants drop in.
 */
export async function getSpendingLimitHexForV0Unlimited(): Promise<string> {
  return getTransactionSpendingLimitHex({ IsUnlimited: true });
}

/**
 * build the `https://identity.deso.org/derive?...` URL the side panel opens for owner consent.
 *
 * uses Identity's "v=2 + postMessage" form (default, no `webview=true`). the side panel's
 * `window.addEventListener('message', ...)` listener captures the response payload.
 *
 * `ownerPubkeyBase58Check` is OPTIONAL. if omitted, Identity asks the owner to log in / pick an
 * account first. pre-filling tightens UX when the user knows their own address, leaving it blank
 * is the simplest "hand them off and let Identity drive" path.
 */
export function buildDeSoIdentityDeriveUrl(args: {
  derivedPubkeyBase58Check: string;
  spendingLimit: DeSoSpendingLimitV0;
  ownerPubkeyBase58Check?: string;
  expirationDays?: number;
  identityOrigin?: string;
  testnet?: boolean;
}): string {
  const origin = args.identityOrigin ?? DESO_IDENTITY_ORIGIN_DEFAULT;
  const expirationDays = args.expirationDays ?? DESO_DEFAULT_EXPIRATION_DAYS;
  const params = new URLSearchParams();
  params.set('v', '2');
  params.set('DerivedPublicKey', args.derivedPubkeyBase58Check);
  params.set(
    'TransactionSpendingLimitResponse',
    encodeSpendingLimitForUrl(args.spendingLimit),
  );
  // ExpirationDays is honored by Identity to compute the actual block. the responding payload
  // returns the resolved `expirationBlock` integer.
  params.set('ExpirationDays', String(expirationDays));
  if (args.ownerPubkeyBase58Check) params.set('PublicKey', args.ownerPubkeyBase58Check);
  if (args.testnet) params.set('testnet', 'true');
  // app-name surfaces in Identity's consent page so the owner sees who they're delegating to.
  params.set('AppName', DESO_DELEGATION_APP_NAME);
  return `${origin.replace(/\/$/, '')}/derive?${params.toString()}`;
}

/**
 * build the `https://identity.deso.org/approve?...` URL for the owner-sign step.
 *
 * Identity reads `tx` (the unsigned `TransactionHex`), shows the user a human-readable summary,
 * asks them to sign, then postMessages the signed `transactionHex` back.
 */
export function buildDeSoIdentityApproveUrl(args: {
  unsignedTransactionHex: string;
  identityOrigin?: string;
  testnet?: boolean;
}): string {
  const origin = args.identityOrigin ?? DESO_IDENTITY_ORIGIN_DEFAULT;
  const params = new URLSearchParams();
  params.set('tx', args.unsignedTransactionHex);
  if (args.testnet) params.set('testnet', 'true');
  return `${origin.replace(/\/$/, '')}/approve?${params.toString()}`;
}

function encodeSpendingLimitForUrl(limit: DeSoSpendingLimitV0): string {
  // v0 only: { IsUnlimited: true }. future variants build a richer object before encoding.
  // we return RAW JSON, URLSearchParams handles percent-encoding once during `toString()`,
  // so double-encoding (encodeURIComponent here too) would corrupt the value.
  if (limit.kind === 'unlimited') {
    return JSON.stringify({ IsUnlimited: true });
  }
  // exhaustive guard - ts will yell when we add a new kind
  const _never: never = limit.kind;
  throw new Error(`unknown DeSoSpendingLimit kind: ${String(_never)}`);
}

/**
 * phase-1 of the link flow: side panel got the derive payload back from Identity. we construct
 * the unsigned AuthorizeDerivedKey tx via `/api/v0/authorize-derived-key`, ready to feed back to
 * the same side panel for the `/approve` window.
 *
 * sanity-checks:
 *   - `derivedPublicKeyBase58Check` MUST match this dWallet's address (else Identity gave us a
 *     payload for a different derived key).
 *   - `accessSignatureHex` is non-empty.
 */
export async function constructDeSoAuthorizeDerivedKey(args: {
  ownerPubkeyBase58Check: string;
  derivedPubkeyBase58Check: string;
  accessSignatureHex: string;
  expirationBlock: number;
  spendingLimitHex: string;
  memo?: string;
  appName?: string;
  minFeeRateNanosPerKB?: number;
}): Promise<{ unsignedTransactionHex: string }> {
  if (!args.ownerPubkeyBase58Check || !args.ownerPubkeyBase58Check.startsWith('BC1')) {
    throw new Error('ownerPubkeyBase58Check is required and must look like a DeSo address');
  }
  const compressed = await getDwalletSecpPublicKey();
  const expectedDerived = encodeDeSoAddress(compressed, 'mainnet');
  if (args.derivedPubkeyBase58Check !== expectedDerived) {
    throw new Error(
      `derivedPubkeyBase58Check ${args.derivedPubkeyBase58Check} does not match active dWallet ${expectedDerived}, aborting to avoid linking the wrong key`,
    );
  }
  if (!args.accessSignatureHex || args.accessSignatureHex.replace(/^0x/, '').length < 8) {
    throw new Error('accessSignatureHex is required and must be a non-trivial DER hex');
  }
  if (!args.spendingLimitHex || args.spendingLimitHex.length < 2) {
    throw new Error('spendingLimitHex is required (use getSpendingLimitHexForV0Unlimited())');
  }
  if (!Number.isFinite(args.expirationBlock) || args.expirationBlock <= 0) {
    throw new Error('expirationBlock must be a positive integer');
  }

  const res = await constructAuthorizeDerivedKey({
    ownerPublicKeyBase58Check: args.ownerPubkeyBase58Check,
    derivedPublicKeyBase58Check: args.derivedPubkeyBase58Check,
    expirationBlock: args.expirationBlock,
    accessSignatureHex: args.accessSignatureHex.replace(/^0x/, ''),
    transactionSpendingLimitHex: args.spendingLimitHex.replace(/^0x/, ''),
    memo: args.memo ?? DESO_DELEGATION_MEMO,
    appName: args.appName ?? DESO_DELEGATION_APP_NAME,
    minFeeRateNanosPerKB: args.minFeeRateNanosPerKB,
  });
  if (!res.TransactionHex) {
    throw new Error('authorize-derived-key returned no TransactionHex');
  }
  return { unsignedTransactionHex: res.TransactionHex };
}

/**
 * phase-2 of the link flow: side panel got the OWNER-signed transaction hex back from Identity's
 * `/approve` window. we submit it via `/api/v0/submit-transaction` and persist the link record.
 *
 * returns the on-chain tx hash + the persisted link. verification (poll `/get-user-derived-keys`
 * for `IsValid: true`) is a separate call so the UI can show in-flight feedback while the tx
 * confirms (Proof-of-Stake mainnet, ~2-3s).
 */
export async function submitAndPersistDeSoOwnerLink(args: {
  signedTransactionHex: string;
  ownerPubkeyBase58Check: string;
  spendingLimit: DeSoSpendingLimitV0;
  spendingLimitHex: string;
  expirationBlock: number;
  identityServiceOrigin?: string;
}): Promise<{ txnHashHex: string; link: DeSoOwnerLink }> {
  const s = getSession();
  if (!s?.activeVaultId) {
    throw new Error('active vault required to persist DeSo owner link');
  }
  const submit = await submitTransaction(args.signedTransactionHex);
  const txnHashHex = submit.TxnHashHex;
  if (!txnHashHex) {
    throw new Error(
      `submit-transaction returned no TxnHashHex (raw=${JSON.stringify(submit).slice(0, 200)})`,
    );
  }

  const compressed = await getDwalletSecpPublicKey();
  const link: DeSoOwnerLink = {
    ownerPubkeyBase58Check: args.ownerPubkeyBase58Check,
    derivedPubkeyBase58Check: encodeDeSoAddress(compressed, 'mainnet'),
    derivedPubkeyHexCompressed: bytesToHex(compressed),
    spendingLimit: args.spendingLimit,
    spendingLimitHex: args.spendingLimitHex.replace(/^0x/, ''),
    expirationBlock: args.expirationBlock,
    authorizedAtMs: Date.now(),
    txnHashHex,
    verifiedAtMs: null,
    identityServiceOrigin: args.identityServiceOrigin ?? DESO_IDENTITY_ORIGIN_DEFAULT,
  };
  await writeDeSoOwnerLink(s.activeVaultId, link);
  return { txnHashHex, link };
}

/**
 * poll `/api/v0/get-user-derived-keys` for the active link. returns `verified: true` once the
 * owner's derived-key index contains the dWallet pubkey with `IsValid: true`. side panel can call
 * this on a +3s/+10s/+exp-backoff cadence, we don't run our own loop here so the UI keeps full
 * control over abort + retry semantics.
 */
export async function checkDeSoDerivedKeyVerification(): Promise<{
  verified: boolean;
  link: DeSoOwnerLink | null;
}> {
  const s = getSession();
  if (!s?.activeVaultId) return { verified: false, link: null };
  const link = await getDeSoOwnerLinkForVault(s.activeVaultId);
  if (!link) return { verified: false, link: null };
  if (link.verifiedAtMs) return { verified: true, link };

  const res = await getUserDerivedKeys(link.ownerPubkeyBase58Check);
  const entry = res.DerivedKeys?.[link.derivedPubkeyBase58Check];
  if (entry?.IsValid) {
    await markActiveDeSoOwnerLinkVerified();
    const updated = await getDeSoOwnerLinkForVault(s.activeVaultId);
    return { verified: true, link: updated ?? link };
  }
  return { verified: false, link };
}

/** test-only hook: make a verified link from outside the DSL. bypasses Identity entirely. */
export async function __setDeSoOwnerLinkForTests(
  vaultId: string,
  link: DeSoOwnerLink,
): Promise<void> {
  await writeDeSoOwnerLink(vaultId, link);
}
