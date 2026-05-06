# WebAuthn PRF / HMAC-secret extension

WebAuthn's PRF (Pseudo-Random Function) extension - also called `hmac-secret` at the CTAP2 layer - lets a relying party (chromatika) extract a deterministic 32-byte secret from a passkey credential per assertion. given the same credential + same salt, the output is identical across assertions. this is what makes a passkey usable as an **encryption credential**, not just an authentication credential.

spec: [WebAuthn Level 3 (working draft) §10.1.4](https://www.w3.org/TR/webauthn-3/) (PRF extension).

## why we use it

without PRF, a passkey can prove "you have this credential" (authentication) but can't produce stable secret material (encryption). chromatika needs encryption to:

- derive the AES key for the passkey-PRF unlock envelope (see [passkey-prf-envelope.md](/library/tech/passkey-prf-envelope))
- derive the ika `UserShareEncryptionKeys` root seed for Sui-base passkey vaults (see [ika-seed-sui-passkey.md](/library/tech/ika-seed-sui-passkey))

both want a deterministic 32-byte input. PRF provides exactly that.

## the eval input

the relying party supplies a **salt** in the PRF request:

```ts
extensions: {
  prf: {
    eval: {
      first: prfSaltBytes,      // up to 32 bytes
      // second: optionalSecondSaltBytes,
    }
  }
}
```

the authenticator computes:

```
prf_output = HMAC-SHA256(per_credential_secret, salt)
```

where `per_credential_secret` is a 32-byte secret the authenticator generated when the credential was created and never reveals. the user can't extract `per_credential_secret`; only HMAC outputs of (credential, salt) pairs.

determinism: same `(credential, salt)` always produces the same `prf_output`. across devices that have the credential synced (iCloud Passwords, Google Passkey), it's the same. across re-registration of a "different" credential (a new keypair), it's different.

## the registration ceremony

```ts
const credential = await navigator.credentials.create({
  publicKey: {
    challenge: random32,
    rp: { id: rpId, name: "Chromatika" },
    user: { id, name, displayName },
    pubKeyCredParams: [
      { alg: -7, type: "public-key" }, // ES256 (secp256r1)
      { alg: -257, type: "public-key" }, // RS256 (RSA, fallback for Windows Hello)
    ],
    extensions: {
      prf: {
        eval: { first: prfSaltBytes }, // optional eval at register time
      },
    },
  },
});

const prfResult = credential.getClientExtensionResults().prf;
if (prfResult?.results?.first) {
  const prfSecret = prfResult.results.first; // 32 bytes
  // success - we have the PRF output
} else if (prfResult?.enabled) {
  // PRF supported but not eval-d at register; do an immediate get() to extract
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: random32,
      rpId,
      allowCredentials: [{ id: credential.rawId, type: "public-key" }],
      extensions: { prf: { eval: { first: prfSaltBytes } } },
    },
  });
  const prfSecret = assertion.getClientExtensionResults().prf.results.first;
} else {
  // authenticator does not support PRF / hmac-secret
  // chromatika rejects: cannot create a PRF-backed vault on this authenticator
  throw new Error("authenticator does not support PRF extension");
}
```

some authenticators evaluate PRF at register-time (`prf.results.first` populated immediately). some don't, only at assertion-time. chromatika handles both paths.

## the assertion ceremony

```ts
const assertion = await navigator.credentials.get({
  publicKey: {
    challenge: random32,
    rpId,
    allowCredentials: [{ id: credentialIdBytes, type: "public-key" }],
    extensions: { prf: { eval: { first: prfSaltBytes } } },
  },
});
const prfSecret = assertion.getClientExtensionResults().prf.results.first;
// 32 bytes
```

every unlock-time assertion supplies the same `prfSaltBytes` (persisted in the envelope record) and gets the same `prfSecret` back, deterministically.

## chromatika's PasskeyProviderWithPrf wrapper

chromatika has a custom wrapper (`wallet-extension/src/ui/passkey/passkey-provider-with-prf.ts`) around `navigator.credentials` that:

- mirrors `@mysten/sui`'s `PasskeyProvider` interface (so existing Sui passkey code can use it)
- injects the PRF extension request
- handles the register-vs-assertion PRF availability split
- packages the result into chromatika's expected shape

this wrapper keeps the PRF integration localized; the rest of chromatika just sees "a passkey credential that produces a 32-byte secret on assertion."

## authenticator support

PRF / `hmac-secret` is supported by:

- **YubiKey** firmware 5.2.3+
- **SoloKey 2** (most firmware versions)
- **Touch ID** on macOS Sonoma+ (with iCloud Passwords)
- **Windows Hello** on Windows 11 22H2+
- **Android passkey** (Google Password Manager)

NOT supported by:

- older YubiKeys (firmware <5.2.3)
- some non-FIDO2 hardware tokens
- platform authenticators on older OS versions

chromatika tests for PRF availability at registration. if not supported, surfaces "authenticator does not support PRF; use a different one or use a password / WAAP envelope instead."

## the salt rotation

`prfSalt` is generated once at envelope create time (32 random bytes). rotation = creating a new envelope with a fresh salt + dropping the old one. the underlying credential stays the same; only the PRF salt changes. this means the same credential can back multiple chromatika vaults, each with its own salt → different PRF outputs → different envelope keys.

## the credential public-key info

after registration, chromatika persists:

- `credentialIdB64Url`: webauthn `credential.rawId` in base64url (RFC 4648 §5)
- `publicKeyCompressedB64`: 33-byte secp256r1 compressed pubkey from the attestation object
- `rpId`: relying-party id (chrome-extension origin)
- `prfSaltB64`: per-vault salt

the public key isn't strictly needed for unlock (PRF is independent of the keypair), but it's used:

- for SIP-9 Sui address derivation: `blake2b_256(0x06 || pk_compressed)` produces a Sui address that can be displayed alongside the passkey
- for verifiable signatures (passkey can also sign, separately from the PRF flow)

## library

- browser native `navigator.credentials`
- internal: `wallet-extension/src/ui/passkey/passkey-provider-with-prf.ts` for the wrapper
- internal: `wallet-extension/src/background/keyring/passkey-derive.ts` for register-time validation + Sui address derivation

## related

- [passkey-prf-envelope.md](/library/tech/passkey-prf-envelope) - the unlock-envelope use of PRF
- [ika-seed-sui-passkey.md](/library/tech/ika-seed-sui-passkey) - the ika seed derivation use of PRF
- [multi-envelope-design.md](/library/tech/multi-envelope-design) - the broader envelope model
