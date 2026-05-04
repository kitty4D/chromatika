/**
 * unlock-screen helper that turns the v4 vault's envelope list into the side panel's
 * `ExtraUnlockMethod` array. each non-password envelope becomes a button with an action that
 * runs the right "re-authenticate to unwrap the master key" flow inline.
 *
 * passkey envelopes run `navigator.credentials.get` with the stored PRF salt + credentialId
 * directly in the side panel (which has user-gesture context, no popup needed). waap /
 * seeker / recovery-words paths are stubbed for v1 with a "not implemented yet" handler.
 */

import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { fromBase64 as fromB64 } from '@mysten/sui/utils';
import { IKA_USK_DERIVATION_MESSAGE } from '@/background/keyring/hd';
import { ensureWaapSuiWallet } from '@/ui/waap/waap-init';
import type { ExtraUnlockMethod } from '@/ui/unlock-screen';

type EnvelopeMeta =
  | {
      id: string;
      kind: 'password';
      label: string;
      addedAtEpochMs: number;
    }
  | {
      id: string;
      kind: 'passkey-prf';
      label: string;
      addedAtEpochMs: number;
      credentialIdB64Url: string;
      rpId: string;
      prfSaltB64: string;
    }
  | {
      id: string;
      kind: 'wallet-signature';
      label: string;
      addedAtEpochMs: number;
      source: 'waap' | 'seeker' | 'walletconnect';
      address: string;
      hint?: string;
    }
  | {
      id: string;
      kind: 'recovery-words';
      label: string;
      addedAtEpochMs: number;
      wordCount: 12 | 24;
    };

export type UnlockMethodsState = {
  envelopes: EnvelopeMeta[];
  passwordEnvelopeAvailable: boolean;
  extraMethods: ExtraUnlockMethod[];
  /** non-fatal load error (e.g. background hiccup); unlock screen falls back to password-only. */
  loadError: string | null;
};

/**
 * returns unlock-screen wiring derived from the wallet's envelopes. re-fetches whenever
 * `vaultExists` flips true so freshly-onboarded wallets show the right buttons.
 *
 * @param vaultExists  true when the wallet probe found a blob.
 * @param onUnlocked   called after a successful non-password unlock so the parent flips state.
 * @param setError     unlock-screen error setter - extra-method failures route here.
 * @param autoLockMinutes  passed through to the unlock trpc procs.
 */
export function useUnlockMethods(args: {
  vaultExists: boolean;
  onUnlocked: () => void;
  setError: (msg: string | null) => void;
  autoLockMinutes: number;
}): UnlockMethodsState {
  const { vaultExists, onUnlocked, setError, autoLockMinutes } = args;
  const [envelopes, setEnvelopes] = useState<EnvelopeMeta[]>([]);
  const [busyEnvelopeId, setBusyEnvelopeId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!vaultExists) {
      setEnvelopes([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = (await trpc.listVaultEnvelopes.query()) as EnvelopeMeta[];
        if (!cancelled) setEnvelopes(list);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultExists]);

  const passwordEnvelopeAvailable = envelopes.some((e) => e.kind === 'password');

  const extraMethods = useMemo<ExtraUnlockMethod[]>(() => {
    const out: ExtraUnlockMethod[] = [];
    for (const env of envelopes) {
      if (env.kind === 'password') continue;
      if (env.kind === 'passkey-prf') {
        out.push({
          id: env.id,
          kind: 'passkey-prf',
          label: env.label || 'unlock with passkey',
          hint: 'face id · fingerprint · pin',
          busy: busyEnvelopeId === env.id,
          onClick: () => {
            setBusyEnvelopeId(env.id);
            setError(null);
            void (async () => {
              try {
                await unlockWithPasskeyEnvelope(env, autoLockMinutes);
                onUnlocked();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusyEnvelopeId(null);
              }
            })();
          },
        });
        continue;
      }
      if (env.kind === 'wallet-signature') {
        out.push({
          id: env.id,
          kind: 'wallet-signature',
          label: env.label || `unlock with ${env.source}`,
          hint:
            env.source === 'waap'
              ? 'email · phone · social'
              : env.source === 'seeker'
                ? 'tap your seeker phone'
                : env.source,
          busy: busyEnvelopeId === env.id,
          onClick: () => {
            setBusyEnvelopeId(env.id);
            setError(null);
            void (async () => {
              try {
                await unlockWithWalletSignatureEnvelope(env, autoLockMinutes);
                onUnlocked();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusyEnvelopeId(null);
              }
            })();
          },
        });
        continue;
      }
      if (env.kind === 'recovery-words') {
        out.push({
          id: env.id,
          kind: 'recovery-words',
          label: env.label || `unlock with ${env.wordCount}-word phrase`,
          hint: 'paste your recovery code',
          busy: busyEnvelopeId === env.id,
          onClick: () => {
            // recovery-words requires the user to type the phrase - use a prompt() for v1.
            // a proper modal with mask + paste support is a follow-up; prompt() ships today
            // and round-trips reliably from the side-panel context.
            const words = window.prompt(
              `paste your ${env.wordCount}-word recovery phrase to unlock this wallet:`,
            );
            if (!words || !words.trim()) return;
            setBusyEnvelopeId(env.id);
            setError(null);
            void (async () => {
              try {
                await trpc.unlockVaultRecoveryWords.mutate({
                  envelopeId: env.id,
                  words: words.trim(),
                  autoLockMinutes,
                });
                onUnlocked();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusyEnvelopeId(null);
              }
            })();
          },
        });
        continue;
      }
    }
    return out;
  }, [envelopes, busyEnvelopeId, autoLockMinutes, onUnlocked, setError]);

  return { envelopes, passwordEnvelopeAvailable, extraMethods, loadError };
}

/**
 * run the WebAuthn assertion in-place + post the PRF hmac-secret to background. lives outside
 * the react hook so it's reusable from non-react contexts (e.g. dapp approval auto-unlock).
 */
async function unlockWithPasskeyEnvelope(
  env: { id: string; credentialIdB64Url: string; rpId: string; prfSaltB64: string },
  autoLockMinutes: number,
): Promise<void> {
  const credentialId = base64UrlDecode(env.credentialIdB64Url);
  const prfSalt = fromB64(env.prfSaltB64);
  if (prfSalt.length !== 32) throw new Error('passkey envelope prf salt is not 32 bytes');

  // any non-empty challenge works; the PRF eval is what we actually care about.
  const challenge = new TextEncoder().encode(`chromatika.unlock.${env.id}`);

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: challenge as BufferSource,
      rpId: env.rpId,
      timeout: 60_000,
      userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: credentialId.slice().buffer }],
      // typedom doesn't include PRF in PublicKeyCredentialRequestOptions yet - cast through any.
      ...({ extensions: { prf: { eval: { first: prfSalt as BufferSource } } } } as Record<string, unknown>),
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error('passkey assertion cancelled');

  const ext = (credential.getClientExtensionResults?.() ?? {}) as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const first = ext.prf?.results?.first;
  if (!first || first.byteLength !== 32) {
    throw new Error('passkey assertion returned no prf hmac-secret on this device.');
  }
  const prfSecret = new Uint8Array(first);
  let bin = '';
  for (const b of prfSecret) bin += String.fromCharCode(b);
  const prfSecretB64 = btoa(bin);
  prfSecret.fill(0);

  await trpc.unlockVaultPasskey.mutate({
    envelopeId: env.id,
    prfSecretB64,
    autoLockMinutes,
  });
}

function base64UrlDecode(s: string): Uint8Array {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * dispatch wallet-signature envelope unlock by `source`. each branch re-runs the wallet's
 * deterministic-signature dance so the same bytes that were captured at vault create produce
 * the same HKDF KEK that unwraps the master key.
 */
async function unlockWithWalletSignatureEnvelope(
  env: { id: string; source: 'waap' | 'seeker' | 'walletconnect'; address: string },
  autoLockMinutes: number,
): Promise<void> {
  if (env.source === 'waap') {
    return unlockWithWaapSignature(env.id, env.address, autoLockMinutes);
  }
  if (env.source === 'seeker') {
    return unlockWithSeekerSignature(env.id, env.address, autoLockMinutes);
  }
  if (env.source === 'walletconnect') {
    throw new Error(
      'unlock with walletconnect is shipping in a follow-up slice. for now, use your password.',
    );
  }
  throw new Error(`unknown wallet-signature source: ${(env as { source: string }).source}`);
}

/**
 * waap unlock: open the waap modal, connect, sign `IKA_USK_DERIVATION_MESSAGE`, post the
 * signature to background. background runs `ikaRootSeedFromMwaSignature` (alias for the
 * wallet-signature HKDF) on the same bytes that were captured at vault create, unwraps the
 * master key, decrypts the payload.
 */
async function unlockWithWaapSignature(
  envelopeId: string,
  expectedAddress: string,
  autoLockMinutes: number,
): Promise<void> {
  const wallet = await ensureWaapSuiWallet({ darkMode: true });
  const conn = await wallet.connect();
  const account =
    conn.accounts.find((a: { address: string }) => a.address === expectedAddress)
    ?? conn.accounts[0];
  if (!account) throw new Error('waap returned no account on connect');
  if (account.address !== expectedAddress) {
    throw new Error(
      `waap returned a different account (${account.address.slice(0, 10)}…) than the one bound to this vault. log into the same waap account that owns this vault.`,
    );
  }
  const sig = await wallet.signPersonalMessage({
    message: IKA_USK_DERIVATION_MESSAGE,
    account,
  });
  await trpc.unlockVaultWalletSignature.mutate({
    envelopeId,
    signatureB64: sig.signature,
    autoLockMinutes,
  });
}

/**
 * seeker unlock: re-run MWA `transact()` and ask the wallet to re-sign `IKA_USK_DERIVATION_MESSAGE`.
 * Ed25519 deterministic signatures (RFC 8032) mean the same seeker on any device produces the
 * exact same bytes - that's what makes seeker-only unlock work without a password fallback.
 */
async function unlockWithSeekerSignature(
  envelopeId: string,
  expectedAddress: string,
  autoLockMinutes: number,
): Promise<void> {
  // dynamic import keeps the MWA polyfill chain off bundles that never touch seeker.
  const { transact } = await import('@solana-mobile/mobile-wallet-adapter-protocol-web3js');
  const { MWA_APP_IDENTITY } = await import('@/config/mwa');

  let signatureB64: string | null = null;
  await transact(async (wallet) => {
    const auth = await wallet.authorize({
      chain: 'solana:mainnet',
      identity: MWA_APP_IDENTITY,
    });
    const acct =
      auth.accounts.find((a) => a.address === expectedAddress) ?? auth.accounts[0];
    if (!acct) throw new Error('seeker returned no account on authorize');
    if (acct.address !== expectedAddress) {
      throw new Error(
        'seeker returned a different account than the one bound to this vault. unlock with the same seeker that paired this wallet.',
      );
    }
    const sigs = await wallet.signMessages({
      addresses: [acct.address],
      payloads: [IKA_USK_DERIVATION_MESSAGE],
    });
    if (!sigs.length || !(sigs[0] instanceof Uint8Array)) {
      throw new Error('seeker did not return a signature for IKA_USK_DERIVATION_MESSAGE');
    }
    // MWA returns the signature concatenated with the original payload - strip the suffix.
    const sigBytes = sigs[0];
    const sigOnly =
      sigBytes.length > IKA_USK_DERIVATION_MESSAGE.length
        ? sigBytes.subarray(0, sigBytes.length - IKA_USK_DERIVATION_MESSAGE.length)
        : sigBytes;
    let bin = '';
    for (const b of sigOnly) bin += String.fromCharCode(b);
    signatureB64 = btoa(bin);
  });
  if (!signatureB64) throw new Error('seeker unlock did not capture a signature');
  await trpc.unlockVaultWalletSignature.mutate({
    envelopeId,
    signatureB64,
    autoLockMinutes,
  });
}
