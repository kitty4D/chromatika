import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PasskeyKeypair } from '@mysten/sui/keypairs/passkey';
import { fromBase64 as fromB64, toBase64 as toB64 } from '@mysten/sui/utils';
import { BrowserPasskeyProviderWithPrf } from './passkey-provider-with-prf';

type Status =
  | { kind: 'fetching' }
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

/**
 * popup-resident component that runs `navigator.credentials.get()` to sign a queued challenge
 * for a passkey vault. background side queues the request via `enqueuePasskeySign({ ... })`,
 * opens this popup with `?passkeysign=ID`. on success the popup posts the bcs-encoded passkey
 * signature (sip-9 wrapped) back to background and closes.
 *
 * three sign kinds the popup handles, all dispatched off the request meta's `kind` field:
 *   - `'tx'`       -> `keypair.signTransaction(bytes)`: sui ptb bytes, mysten wraps with
 *                    intent prefix internally before sending the digest to the authenticator.
 *   - `'personal'` -> `keypair.signPersonalMessage(bytes)`: `sui_signPersonalMessage` rpc shape.
 *   - `'raw'`      -> `keypair.sign(challenge)`: sign a 32-byte digest with no intent wrap.
 *
 * the popup intentionally renders a "tap continue to authorize" gate before invoking webauthn,
 * most browsers require a user gesture inside the popup window itself, so an immediate sign on
 * mount can be silently blocked.
 */
export function PasskeySign({ requestId }: { requestId: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'fetching' });
  const [meta, setMeta] = useState<{
    vaultId: string;
    credentialIdB64Url: string;
    rpId: string;
    publicKeyCompressedB64: string;
    challengeB64: string;
    kind: 'tx' | 'personal' | 'raw';
    prfSaltB64?: string;
  } | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    trpc.getPasskeySignRequest
      .query({ id: requestId })
      .then((m) => {
        const meta = m as {
          vaultId: string;
          credentialIdB64Url: string;
          rpId: string;
          publicKeyCompressedB64: string;
          challengeB64: string;
          kind: 'tx' | 'personal' | 'raw';
          prfSaltB64?: string;
        };
        setMeta(meta);
        setStatus({ kind: 'idle' });
      })
      .catch((e) => setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, [requestId]);

  // best-effort: tell background if the user closes the popup without authorizing.
  useEffect(() => {
    const onUnload = () => {
      if (closedRef.current) return;
      try {
        void trpc.rejectPasskeySign.mutate({ id: requestId, reason: 'popup closed' });
      } catch {
        /* best effort */
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [requestId]);

  async function authorize() {
    if (!meta) return;
    setStatus({ kind: 'busy', message: 'tap your device to authorize…' });
    try {
      const credentialId = base64UrlDecode(meta.credentialIdB64Url);
      const publicKey = fromB64(meta.publicKeyCompressedB64);
      if (publicKey.length !== 33) {
        throw new Error(`expected 33-byte compressed secp256r1 pk; got ${publicKey.length}`);
      }
      const provider = new BrowserPasskeyProviderWithPrf({
        rpName: 'Chromatika',
        rpId: meta.rpId,
        userName: 'chromatika',
        userDisplayName: 'Chromatika dWallet Vault',
        // sign-time prf eval is optional, passed when the caller also wants the prf secret
        // (e.g. an unlock-and-sign combined flow). signing alone uses an empty salt; webauthn
        // ignores the extension when the eval input is absent.
        prfSaltB64: meta.prfSaltB64 ?? toB64(new Uint8Array(32)),
      });

      const challengeBytes = fromB64(meta.challengeB64);
      const keypair = new PasskeyKeypair(publicKey, provider, credentialId);

      let serializedSignature: string;
      if (meta.kind === 'tx') {
        const out = await keypair.signTransaction(challengeBytes);
        serializedSignature = out.signature;
      } else if (meta.kind === 'personal') {
        const out = await keypair.signPersonalMessage(challengeBytes);
        serializedSignature = out.signature;
      } else {
        // raw digest, `keypair.sign` returns the bcs-encoded passkey authenticator bytes
        // (NO scheme flag prepend). callers wanting a full sui-serialized sig should use
        // `kind: 'tx'` or `'personal'` instead.
        const sigBytes = await keypair.sign(challengeBytes);
        serializedSignature = toB64(sigBytes);
      }

      setStatus({ kind: 'busy', message: 'finalizing…' });
      await trpc.resolvePasskeySign.mutate({
        id: requestId,
        serializedSignatureB64: serializedSignature,
      });
      closedRef.current = true;
      setStatus({ kind: 'done' });
      setTimeout(() => window.close(), 250);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: 'error', message });
      try {
        await trpc.rejectPasskeySign.mutate({ id: requestId, reason: message });
      } catch {
        /* best effort */
      }
    }
  }

  return (
    <div className="ws-passkey-popup" style={popupShellStyle}>
      <h2 style={{ margin: '0 0 12px', fontSize: '1.05rem' }}>sign with your passkey</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.85 }}>
        chromatika needs your passkey to authorize this transaction. on the next prompt, use face
        id, fingerprint, or your device pin.
      </p>
      {status.kind === 'fetching' && <p>loading request…</p>}
      {status.kind === 'error' && (
        <p role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.45 }}>
          {status.message}
        </p>
      )}
      {status.kind === 'busy' && <p style={{ fontSize: 13, opacity: 0.85 }}>{status.message}</p>}
      {status.kind === 'idle' && meta && (
        <button type="button" className="ws-choose-btn ws-choose-btn--primary" onClick={authorize}>
          continue
        </button>
      )}
      {status.kind === 'error' && meta && (
        <button
          type="button"
          className="ws-choose-btn ws-choose-btn--secondary"
          style={{ marginTop: 10 }}
          onClick={authorize}
        >
          try again
        </button>
      )}
      {status.kind === 'done' && (
        <p style={{ fontSize: 13, opacity: 0.85 }}>signed — finishing up in chromatika…</p>
      )}
    </div>
  );
}

const popupShellStyle: React.CSSProperties = {
  padding: 20,
  maxWidth: 380,
  margin: '0 auto',
  fontFamily: 'var(--theme-font-body, ui-sans-serif, system-ui)',
  color: 'var(--theme-page-text, rgba(234, 240, 255, 0.95))',
};

function base64UrlDecode(s: string): Uint8Array {
  const padLen = (4 - (s.length % 4)) % 4;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
