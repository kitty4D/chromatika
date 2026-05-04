import { useEffect, useRef, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { registerWithPrf } from './passkey-provider-with-prf';

type Status =
  | { kind: 'fetching' }
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'done' };

/**
 * popup-resident component that runs `navigator.credentials.create` (with the prf hmac-secret
 * extension) for the chromatika passkey vault flow. opened by background via
 * `chrome.windows.create({ url: '?passkeyregister=ID' })` after the side-panel issues
 * `runPasskeyOnboarding`.
 *
 * the popup:
 *   1. fetches request meta (rpId, rpName, userName, prfSalt) from background.
 *   2. calls the wrapped `BrowserPasskeyProviderWithPrf` to register + capture prf hmac-secret.
 *   3. posts the artifacts back to background via `resolvePasskeyRegister`.
 *   4. closes the popup window. the side-panel orchestrator then runs `createPasskeyVault`.
 *
 * the popup intentionally renders a clear "tap continue to authorize" gate before invoking
 * webauthn (most browsers like chrome, safari require a user gesture inside the popup itself,
 * so an immediate `create()` on mount can be blocked.
 */
export function PasskeyRegister({ requestId }: { requestId: string }) {
  const [status, setStatus] = useState<Status>({ kind: 'fetching' });
  const [meta, setMeta] = useState<{
    rpId: string;
    rpName: string;
    userName: string;
    userDisplayName: string;
    prfSaltB64: string;
  } | null>(null);
  const closedRef = useRef(false);

  useEffect(() => {
    trpc.getPasskeyRegisterRequest
      .query({ id: requestId })
      .then((m) => {
        setMeta({
          rpId: m.rpId,
          rpName: m.rpName,
          userName: m.userName,
          userDisplayName: m.userDisplayName,
          prfSaltB64: m.prfSaltB64,
        });
        setStatus({ kind: 'idle' });
      })
      .catch((e) => setStatus({ kind: 'error', message: e instanceof Error ? e.message : String(e) }));
  }, [requestId]);

  // best-effort: if the user closes the popup without clicking continue, tell background
  // so the orchestrator promise rejects instead of hanging until the popup gc.
  useEffect(() => {
    const onUnload = () => {
      if (closedRef.current) return;
      try {
        void trpc.rejectPasskeyRegister.mutate({ id: requestId, reason: 'popup closed' });
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
      const { credential, prfSecret } = await registerWithPrf({
        rpName: meta.rpName,
        rpId: meta.rpId,
        userName: meta.userName,
        userDisplayName: meta.userDisplayName,
        prfSaltB64: meta.prfSaltB64,
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
      });

      // sui passkey expects the spki-encoded p-256 public key; the registration response carries
      // it via `getPublicKey()`. mysten's `PasskeyKeypair.getPasskeyInstance` parses spki then
      // compresses to 33 bytes. we mirror that here, except we let the background derive the
      // sui address (we only post the compressed pk + credentialId + prf secret).
      const spki = credential.response.getPublicKey();
      if (!spki) throw new Error('passkey registration did not return a public key');
      const compressed = await spkiToCompressedSecp256r1Pk(new Uint8Array(spki));

      const credentialIdRaw = new Uint8Array(credential.rawId);
      const credentialIdB64Url = toB64Url(credentialIdRaw);
      const publicKeyCompressedB64 = toB64(compressed);
      const prfSecretB64 = toB64(prfSecret);

      setStatus({ kind: 'busy', message: 'finalizing…' });
      await trpc.resolvePasskeyRegister.mutate({
        id: requestId,
        credentialIdB64Url,
        publicKeyCompressedB64,
        prfSecretB64,
        rpId: meta.rpId,
      });
      closedRef.current = true;
      setStatus({ kind: 'done' });
      // close the popup once background has the artifacts; side-panel orchestrator continues.
      setTimeout(() => window.close(), 250);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ kind: 'error', message });
      try {
        await trpc.rejectPasskeyRegister.mutate({ id: requestId, reason: message });
      } catch {
        /* best effort */
      }
    }
  }

  return (
    <div className="ws-passkey-popup" style={popupShellStyle}>
      <h2 style={{ margin: '0 0 12px', fontSize: '1.05rem' }}>create your passkey</h2>
      <p style={{ margin: '0 0 18px', fontSize: 13, lineHeight: 1.55, opacity: 0.85 }}>
        chromatika will ask your device to register a new passkey. on the next prompt, use face
        id, fingerprint, or your device pin. recovery is handled by your platform passkey provider
        (icloud keychain, google password manager, 1password, etc.).
      </p>
      {status.kind === 'fetching' && <p>loading request…</p>}
      {status.kind === 'error' && (
        <p role="alert" style={{ color: 'rgba(255,99,132,0.95)', fontSize: 13, lineHeight: 1.45 }}>
          {status.message}
        </p>
      )}
      {status.kind === 'busy' && (
        <p style={{ fontSize: 13, opacity: 0.85 }}>{status.message}</p>
      )}
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
        <p style={{ fontSize: 13, opacity: 0.85 }}>passkey created — finishing setup in chromatika…</p>
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

/**
 * webauthn registration returns the public key in spki / x.509 SubjectPublicKeyInfo form.
 * for sip-9, sui needs the **33-byte compressed sec1** form. we use the platform `crypto.subtle`
 * to import the spki, export it as `raw` (which gives 65-byte uncompressed `0x04 || x || y`),
 * then compress to 33 bytes (`0x02|0x03 || x` based on y parity).
 *
 * ABSOLUTELY mirrors what `@mysten/sui/keypairs/passkey` does internally, keep in sync.
 */
async function spkiToCompressedSecp256r1Pk(spki: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'spki',
    // SubtleCrypto's overloaded `importKey` typings narrow on `BufferSource`. clone the bytes
    // into a fresh `ArrayBuffer` so the SharedArrayBuffer-vs-ArrayBuffer split doesn't trip
    // the overload resolver under recent typescript dom lib updates.
    spki.slice().buffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('unexpected webauthn public-key encoding (expected 65-byte uncompressed point)');
  }
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);
  const tag = (y[31] & 1) === 0 ? 0x02 : 0x03;
  const out = new Uint8Array(33);
  out[0] = tag;
  out.set(x, 1);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function toB64Url(bytes: Uint8Array): string {
  return toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
