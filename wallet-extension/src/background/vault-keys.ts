/**
 * pure key + seed helpers extracted from `wallet-service.ts`. concerns this module owns:
 *
 *   - tiny base64 / Solana keypair coercions
 *   - the `buildIkaShareKeys` driver that turns a stored-bytes record + a seed factory into
 *     two `UserShareEncryptionKeys` (one per ika curve)
 *   - the `makeSeedFrom*` factory family - one per onboarding method (Sui keypair, Solana
 *     keypair, MWA signature, passkey PRF, recovery words, HD mnemonic). each returns a
 *     thunk so the caller decides when the seed actually materializes (the seed is wiped
 *     immediately after use in `buildIkaShareKeys`).
 *   - `nextIkaEncryptionIndex`: BIP44-style index allocator for sibling vaults that share
 *     the same root identity (passkey credential, hardware signature, recovery phrase).
 *
 * none of these depend on session / vault-store state - pure transforms. `wallet-service`
 * imports them and feeds them through `sessionStateFromRecord` / per-method onboarding.
 */

import { Curve, UserShareEncryptionKeys } from '@ika.xyz/sdk';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Keypair } from '@solana/web3.js';
import {
  deriveSolanaKeypair,
  deriveSuiKeypair,
  ikaRootSeedFromFeeKeypair,
  ikaRootSeedFromMwaSignature,
  ikaRootSeedFromPasskeyPRF,
  ikaRootSeedFromRecoveryWords,
  ikaRootSeedFromSolanaKeypair,
} from '@/background/keyring/hd';
import { type CurveKey, type SessionState } from '@/background/session';
import type { BaseChain } from '@/background/ika/ika-adapter';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';

export function toB64(u8: Uint8Array): string {
  return btoa(String.fromCharCode(...u8));
}

export function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export function solanaKeypairFromB64(b64: string): Keypair {
  const secret = Uint8Array.from(atob(b64.trim()), (c) => c.charCodeAt(0));
  if (secret.length < 64) throw new Error('Invalid Solana secret key length');
  return Keypair.fromSecretKey(secret);
}

/**
 * builds the in-memory `UserShareEncryptionKeys` for both curves, deriving any missing curves
 * from a freshly produced seed. the caller decides the seed source by passing a `makeSeed`
 * factory: that's where the Sui-vs-Solana base-chain split lives. pass `null` if both curves
 * are already in `stored` (no derivation needed).
 */
export async function buildIkaShareKeys(
  makeSeed: (() => Uint8Array) | null,
  stored: Partial<Record<CurveKey, string>>,
): Promise<{ ikaShareKeys: SessionState['ikaShareKeys']; ikaShareKeysB64: SessionState['ikaShareKeysB64'] }> {
  const ikaShareKeys = {} as SessionState['ikaShareKeys'];
  const ikaShareKeysB64: SessionState['ikaShareKeysB64'] = { ...stored };
  const needNewCurve = !stored.SECP256K1 || !stored.ED25519;
  let seed: Uint8Array | null = null;
  try {
    if (needNewCurve) {
      if (!makeSeed) {
        throw new Error(
          'Missing ika encryption key material for one or more curves - add a fee payer secret or restore ika keys from backup',
        );
      }
      seed = makeSeed();
    }

    for (const curveKey of ['SECP256K1', 'ED25519'] as const) {
      const curve = curveKey === 'SECP256K1' ? Curve.SECP256K1 : Curve.ED25519;
      if (stored[curveKey]) {
        ikaShareKeys[curveKey] = UserShareEncryptionKeys.fromShareEncryptionKeysBytes(fromB64(stored[curveKey]!));
      } else {
        if (!seed) {
          throw new Error('Internal error: ika seed missing while deriving new curve keys');
        }
        const k = await UserShareEncryptionKeys.fromRootSeedKey(seed, curve);
        ikaShareKeys[curveKey] = k;
        ikaShareKeysB64[curveKey] = toB64(k.toShareEncryptionKeysBytes());
      }
    }
    return { ikaShareKeys, ikaShareKeysB64 };
  } finally {
    if (seed) seed.fill(0);
  }
}

/** Sui-base seed: matches ika CLI `resolve_seed`. */
export function makeSeedFromSuiKeypair(suiKp: Ed25519Keypair): () => Uint8Array {
  return () => ikaRootSeedFromFeeKeypair(suiKp, 0);
}

/** Solana-base seed: KECCAK256(secretKey64 || index_le); no Sui dependency. */
export function makeSeedFromSolanaKeypair(solanaKp: Keypair): () => Uint8Array {
  return () => ikaRootSeedFromSolanaKeypair(solanaKp, 0);
}

/**
 * MWA / hardware-wallet signature -> ika seed factory. `encryptionKeyIndex` selects BIP44-style
 * derivation slots for sibling vaults from the same hardware identity (same signature). default 0.
 *
 * for Seeker, the signature is deterministic (RFC 8032 ED25519) so the same Seeker on a
 * different device re-derives the same seed -> same dWallet. that's how Seeker-only restore
 * works without an HD seed phrase.
 */
export function makeSeedFromMwaSignature(signature: Uint8Array, encryptionKeyIndex = 0): () => Uint8Array {
  return () => ikaRootSeedFromMwaSignature(signature, encryptionKeyIndex);
}

/**
 * Sui passkey ika seed factory: KECCAK256(prfHmacSecret || index_le). PRF is WebAuthn's
 * hmac-secret extension, a deterministic 32-byte secret per (credential, salt). same passkey
 * + same chromatika constant salt = same PRF output across reinstalls and synced devices.
 *
 * `encryptionKeyIndex` is BIP44-style: index 0 is the default first-vault slot, index 1 is the
 * second sibling vault from the SAME passkey credential, etc. different credentials produce
 * different PRF outputs even at the same index (different per-credential authenticator secrets),
 * so cross-credential collision is impossible.
 */
export function makeSeedFromPasskeyPRF(prfSecret: Uint8Array, encryptionKeyIndex = 0): () => Uint8Array {
  return () => ikaRootSeedFromPasskeyPRF(prfSecret, encryptionKeyIndex);
}

/**
 * opt-in 24-word phrase fallback. universal across passkey / waap / lazor recovery flows.
 * `encryptionKeyIndex` selects BIP44-style sibling vaults derived from the same phrase.
 */
export function makeSeedFromRecoveryWords(words: string, encryptionKeyIndex = 0): () => Uint8Array {
  return () => ikaRootSeedFromRecoveryWords(words, encryptionKeyIndex);
}

/**
 * convenience for HD vaults: pick the seed source based on baseChain. `accountIndex` selects the
 * BIP44 account-level slot - 0 = first account (default), 1 = second, etc. each index produces
 * different Sui / Solana keypairs so the derived ika seed (and therefore the dWallet) differs
 * per account, just like Phantom / MetaMask account discovery.
 */
export function makeSeedForHdVault(mnemonic: string, baseChain: BaseChain, accountIndex = 0): () => Uint8Array {
  if (baseChain === 'solana') {
    return makeSeedFromSolanaKeypair(deriveSolanaKeypair(mnemonic, accountIndex));
  }
  return makeSeedFromSuiKeypair(deriveSuiKeypair(mnemonic, accountIndex));
}

/**
 * pick the next BIP44-style ika encryption index for a sibling vault from the same identity.
 * scans the payload for records the predicate matches, returns `max(ikaEncryptionIndex ?? 0) + 1`,
 * or 0 when no matches exist (i.e. this is the first vault for that identity).
 *
 * shared by `addHardwareVault` / `addWaapVault` / `addLazorVault`. mirrors the inline logic in
 * `addPasskeyVault` for its `passkeyEncryptionIndex` field, kept as a separate helper here so the
 * three non-passkey methods don't have to copy-paste the same filter+max pattern.
 */
export function nextIkaEncryptionIndex(
  payload: VaultPayloadV3,
  predicate: (v: VaultRecord) => boolean,
): number {
  const indices: number[] = [];
  for (const v of payload.vaults) {
    if (!predicate(v)) continue;
    const idx = (v as { ikaEncryptionIndex?: number }).ikaEncryptionIndex ?? 0;
    if (Number.isFinite(idx) && idx >= 0) indices.push(idx);
  }
  return indices.length > 0 ? Math.max(...indices) + 1 : 0;
}
