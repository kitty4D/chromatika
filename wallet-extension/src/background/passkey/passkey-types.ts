/**
 * popup ↔ background contract for sui passkey vaults.
 *
 * the popup runs `navigator.credentials.create / get` (webauthn requires a user gesture in a
 * visible context, not the mv3 service worker). it serializes the artifacts and hands them to
 * background via `resolvePendingPasskey*`. background never touches webauthn directly.
 *
 * mirrors the shape of `pending-queue.ts` for hardware sign requests.
 */

/** request to register a fresh passkey credential + capture its prf hmac-secret. */
export type PendingPasskeyRegister = {
  id: string;
  /** rpId the popup should pass to webauthn (chrome.runtime.id by default). */
  rpId: string;
  /** rpName shown in the os passkey dialog. */
  rpName: string;
  /** human-readable user identity shown in the os passkey dialog. */
  userName: string;
  userDisplayName: string;
  /** base64-encoded 32-byte prf salt (popup forwards into `extensions.prf.eval.first`). */
  prfSaltB64: string;
  /** resolves with the popup-collected register payload. */
  resolve: (payload: PasskeyRegisterPayload) => void;
  reject: (err: Error) => void;
};

/** what the popup hands back after a successful register + prf eval. */
export type PasskeyRegisterPayload = {
  /** base64url(`credential.rawId`). */
  credentialIdB64Url: string;
  /** base64(33-byte compressed secp256r1 public key). */
  publicKeyCompressedB64: string;
  /** base64(32-byte prf hmac-secret output). validated as 32 bytes by the popup. */
  prfSecretB64: string;
  /** rpId actually used (for diagnostics, should match the request). */
  rpId: string;
};

/** request to assert an existing passkey credential and produce a sui-side signature. */
export type PendingPasskeySign = {
  id: string;
  vaultId: string;
  credentialIdB64Url: string;
  rpId: string;
  /**
   * base64 of the 33-byte compressed secp256r1 public key. `PasskeyKeypair` needs this to wrap
   * the assertion's `r||s` into the sip-9 `userSignature` shape (`flag || sig || pk`); webauthn
   * itself does NOT return the pk on assertions, so we plumb it through the queue from the
   * vault record (it's stored as `passkeyPublicKeyB64` on `PasskeyVaultRecord`).
   */
  publicKeyCompressedB64: string;
  /** base64 of the bytes to sign (sui ptb digest, personal message, etc.). */
  challengeB64: string;
  /**
   * - `'tx'`         : sign sui ptb bytes (intent prefix included by `PasskeyKeypair.signTransaction`).
   * - `'personal'`   : sign personal-message bytes.
   * - `'raw'`        : sign raw 32-byte digest (no intent prefix).
   */
  kind: 'tx' | 'personal' | 'raw';
  /** prf salt for re-deriving the unlock secret in the same authenticator round. optional, only set on unlock paths. */
  prfSaltB64?: string;
  /** resolves with the popup-collected sign payload. */
  resolve: (payload: PasskeyAssertionPayload) => void;
  reject: (err: Error) => void;
};

export type PasskeyAssertionPayload = {
  /** base64 of the bcs-serialized passkey signature ready for `Transaction.sign({signer: passkey})`. */
  serializedSignatureB64: string;
  /** prf hmac-secret output if the unlock path requested it. */
  prfSecretB64?: string;
};

/** request to recover an existing chromatika passkey vault on a fresh install. */
export type PendingPasskeyRecover = {
  id: string;
  rpId: string;
  /** two probe messages the popup signs so we can run signAndRecover + findCommonPublicKey. */
  probeAB64: string;
  probeBB64: string;
  /** prf salt to re-derive the unlock secret for the recovered credential. */
  prfSaltB64: string;
  resolve: (payload: PasskeyRecoverPayload) => void;
  reject: (err: Error) => void;
};

export type PasskeyRecoverPayload = {
  credentialIdB64Url: string;
  publicKeyCompressedB64: string;
  prfSecretB64: string;
  rpId: string;
};
