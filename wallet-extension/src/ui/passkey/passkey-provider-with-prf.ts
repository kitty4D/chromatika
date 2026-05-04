/**
 * webauthn provider that mirrors mysten's `BrowserPasskeyProvider` but opts into the **prf
 * hmac-secret extension** on every `create` and `get`. prf is the deterministic 32-byte secret
 * we feed into `ikaRootSeedFromPasskeyPRF` to seed the dwallet.
 *
 * keep in sync with `wallet-extension/node_modules/@mysten/sui/src/keypairs/passkey/keypair.ts`
 * if mysten ever surfaces prf natively, we'd swap this for the upstream wrapper. for now this
 * is the only path: their provider doesn't accept extension hooks.
 *
 * ONLY usable in popup / side-panel contexts (uses `navigator.credentials`). do not import
 * from the background service worker, webauthn requires a user gesture in a visible window.
 */

import type { PasskeyProvider } from '@mysten/sui/keypairs/passkey';
import { fromBase64 as fromB64 } from '@mysten/sui/utils';

/**
 * mysten doesn't export the credential aliases publicly, so we mirror the structural shape
 * the upstream `PasskeyKeypair.sign()` consumes. matches `keypair.ts`'s internal types.
 */
type RegistrationCredential = PublicKeyCredential & { response: AuthenticatorAttestationResponse };
type AuthenticationCredential = PublicKeyCredential & { response: AuthenticatorAssertionResponse };

export type PasskeyProviderWithPrfOptions = {
  /** display name shown in the os passkey dialog (e.g. 'Chromatika'). */
  rpName: string;
  /** relying party id. for chrome extensions this is `chrome.runtime.id` (matches `window.location.hostname`). */
  rpId: string;
  /** human-readable user identity in the os passkey dialog. */
  userName: string;
  userDisplayName: string;
  /** base64-encoded 32-byte salt fed into `extensions.prf.eval.first`. stable per vault. */
  prfSaltB64: string;
  /** authenticator selection. defaults to platform + required user verification. */
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  /** request timeout in ms. default 60s. */
  timeoutMs?: number;
};

/** what `create` returns once the prf extension confirms enabled + the assertion follow-up succeeds. */
export type PasskeyRegisterResult = {
  credential: RegistrationCredential;
  /** 32-byte hmac-secret derived from `(credential, prfSalt)`. captured via a follow-up assertion. */
  prfSecret: Uint8Array;
};

/**
 * webauthn-extensions input shape for the prf extension. typedom doesn't include this in
 * `PublicKeyCredentialCreationOptions`/`PublicKeyCredentialRequestOptions` yet, so we cast
 * through a structural type rather than relying on lib.dom.d.ts.
 */
type PrfInput = { eval: { first: BufferSource } };

type CreateOptionsWithPrf = PublicKeyCredentialCreationOptions & {
  extensions?: { prf?: PrfInput };
};

type GetOptionsWithPrf = PublicKeyCredentialRequestOptions & {
  extensions?: { prf?: PrfInput };
};

type PrfClientResults = {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
};

export class BrowserPasskeyProviderWithPrf implements PasskeyProvider {
  #opts: PasskeyProviderWithPrfOptions;

  constructor(opts: PasskeyProviderWithPrfOptions) {
    this.#opts = opts;
  }

  /**
   * register a fresh credential. the create-time prf extension confirms support; the prf
   * secret itself isn't returned on `create` (browsers gate prf output to assertions only on
   * most platforms), so the caller should run a follow-up `get` to capture it.
   *
   * use `registerWithPrf` below for the convenience flow that does both.
   */
  async create(): Promise<RegistrationCredential> {
    const { rpName, rpId, userName, userDisplayName, prfSaltB64, authenticatorSelection, timeoutMs } = this.#opts;
    const prfSalt = fromB64(prfSaltB64);
    const userId = crypto.getRandomValues(new Uint8Array(16));
    // create-time challenge is not security-relevant for sip-9 (sui re-derives the verification
    // challenge from intent + ptb digest at sign time). a fixed domain string is fine here.
    const createChallenge = new TextEncoder().encode('Create passkey wallet on Sui');
    const opts: CreateOptionsWithPrf = {
      rp: { name: rpName, id: rpId },
      user: { id: userId as BufferSource, name: userName, displayName: userDisplayName },
      challenge: createChallenge as BufferSource,
      pubKeyCredParams: [{ alg: -7, type: 'public-key' }], // ES256 (secp256r1) per sip-9
      authenticatorSelection: authenticatorSelection ?? {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      timeout: timeoutMs ?? 60_000,
      extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
    };
    const credential = (await navigator.credentials.create({ publicKey: opts })) as RegistrationCredential | null;
    if (!credential) throw new Error('Passkey registration cancelled or failed.');
    return credential;
  }

  /**
   * assert an existing credential. always passes the prf eval so the assertion result carries
   * the deterministic 32-byte secret in `getClientExtensionResults().prf.results.first`.
   *
   * `credentialId` constrains which credential the browser offers when the user has multiple
   * registered for this rpId (e.g., a backup yubikey). when undefined, the os shows a picker.
   */
  async get(challenge: Uint8Array, credentialId?: Uint8Array): Promise<AuthenticationCredential> {
    const { rpId, prfSaltB64, authenticatorSelection, timeoutMs } = this.#opts;
    const prfSalt = fromB64(prfSaltB64);
    const opts: GetOptionsWithPrf = {
      challenge: challenge as BufferSource,
      rpId,
      timeout: timeoutMs ?? 60_000,
      userVerification: authenticatorSelection?.userVerification ?? 'required',
      ...(credentialId
        ? { allowCredentials: [{ type: 'public-key' as const, id: credentialId as BufferSource }] }
        : {}),
      extensions: { prf: { eval: { first: prfSalt as BufferSource } } },
    };
    const credential = (await navigator.credentials.get({ publicKey: opts })) as AuthenticationCredential | null;
    if (!credential) throw new Error('Passkey assertion cancelled or failed.');
    return credential;
  }
}

/**
 * convenience: register a passkey and capture its prf secret. runs `create` then a follow-up
 * `get` (with the freshly minted `credential.rawId`) so the os passkey dialog shows twice in
 * quick succession but the assertion produces the deterministic 32-byte secret we need to
 * seed ika.
 *
 * platforms that don't process the prf extension at create time are still handled, the
 * follow-up get is what actually evaluates prf, and modern macos / ios / android / 1password
 * all support prf on assertions today (chrome 132+, safari 18+).
 */
export async function registerWithPrf(opts: PasskeyProviderWithPrfOptions): Promise<PasskeyRegisterResult> {
  const provider = new BrowserPasskeyProviderWithPrf(opts);
  const credential = await provider.create();

  // verify the authenticator processed the prf extension at create time.
  const createExtResults = (credential.getClientExtensionResults?.() ?? {}) as PrfClientResults;
  if (createExtResults.prf?.enabled === false) {
    throw new Error(
      'this device does not support webauthn prf (hmac-secret). chromatika needs prf to '
      + 'derive a deterministic ika seed. either pair on a device that supports it (chrome '
      + '132+, safari 18+, recent icloud / google / 1password sync) or use the recovery code '
      + 'option to anchor the seed to a 24-word phrase instead.',
    );
  }

  // FAST PATH: if the authenticator returned the prf result during `create()`, use it directly
  // and SKIP the follow-up `get()`. modern apple platform / chromium often process `prf.eval`
  // at create time, so this saves the user a second face-id / fingerprint / pin tap.
  // (some webauthn implementations only run prf on assertion, we fall through to `get()` then.)
  const createPrf = createExtResults.prf?.results?.first;
  if (createPrf && createPrf.byteLength === 32) {
    return { credential, prfSecret: new Uint8Array(createPrf) };
  }

  // SLOW PATH: capture prf via a follow-up assertion. any non-empty challenge works; the prf
  // eval is what we actually care about.
  const followUpChallenge = new TextEncoder().encode('chromatika.passkey.prf-eval.v1');
  const assertion = await provider.get(followUpChallenge, new Uint8Array(credential.rawId));
  const assertExtResults = (assertion.getClientExtensionResults?.() ?? {}) as PrfClientResults;
  const first = assertExtResults.prf?.results?.first;
  if (!first || first.byteLength !== 32) {
    throw new Error(
      'webauthn prf returned no 32-byte hmac-secret on this device. chromatika needs prf to '
      + 'derive a deterministic ika seed; please use the recovery code option instead.',
    );
  }
  const prfSecret = new Uint8Array(first);

  return { credential, prfSecret };
}

/**
 * convenience: assert an existing credential and capture its prf secret in one round.
 * used by unlock + sign paths.
 */
export async function getWithPrf(
  opts: PasskeyProviderWithPrfOptions,
  challenge: Uint8Array,
  credentialId?: Uint8Array,
): Promise<{ assertion: AuthenticationCredential; prfSecret: Uint8Array }> {
  const provider = new BrowserPasskeyProviderWithPrf(opts);
  const assertion = await provider.get(challenge, credentialId);
  const ext = (assertion.getClientExtensionResults?.() ?? {}) as PrfClientResults;
  const first = ext.prf?.results?.first;
  if (!first || first.byteLength !== 32) {
    throw new Error('passkey assertion returned no prf hmac-secret; cannot unlock vault.');
  }
  return { assertion, prfSecret: new Uint8Array(first) };
}
