# ChromaShard: identity-sharded portable wallet recovery

> Standalone, no-backend, BSD/MIT-licensed TypeScript library that bundles one-or-many wallet secrets (BIP39 mnemonics, raw private keys, future-extensible) into a single portable recovery string. Recovery requires the user to prove control of a threshold quorum of *identity factors* the user pre-registered: passkeys, hardware devices, recovery passphrases, email/DM inboxes, and cloud-storage accounts.
>
> Single sentence: *"useless recovery string + 4 of 7 logins = your wallet back, in any compatible wallet."*
>
> chromatika ships the first integration. The library spec is intentionally portable so any other wallet can adopt.

---

## Status

**Design phase. Not implemented yet.** This document is the canonical spec. Implementation will be tracked as a separate plan under [`docs/STATUS.md`](../../wallet-extension/docs/STATUS.md) once design is locked.

---

## Table of contents

1. [Context](#context)
2. [Goals / non-goals](#goals--non-goals)
3. [Trust model](#trust-model)
4. [Architecture (high level)](#architecture-high-level)
5. [Components](#components)
   - [5.1 Threshold protocol](#51-threshold-protocol)
   - [5.2 Factor types](#52-factor-types)
   - [5.3 Anchor binding](#53-anchor-binding-cloud-surface-bundles-only)
   - [5.4 Provider surfaces](#54-provider-surfaces-v1)
   - [5.5 Recovery string format](#55-recovery-string-format)
   - [5.6 Payload format](#56-payload-format)
6. [Backup flow](#backup-flow-user-facing)
7. [Recovery flow](#recovery-flow-user-facing)
8. [Audit / tamper detection](#audit--tamper-detection)
9. [Factor rotation](#factor-rotation)
10. [Operational concerns](#operational-concerns)
11. [Comparison with existing solutions](#comparison-with-existing-solutions)
12. [Library API](#library-api-ts-sketch)
13. [Chromatika integration](#chromatika-integration)
14. [Open questions / risks](#open-questions--risks)
15. [Roadmap (post-v1)](#roadmap-post-v1)
16. [Verification plan](#verification-plan)
17. [What this changes for chromatika today](#what-this-changes-for-chromatika-today)
18. [File touch-list](#file-touch-list-anticipated-for-v1-implementation)
19. [Glossary](#glossary)

---

## Context

A user has 1..M secrets to back up:
- BIP39 seed phrases (multiple: main wallet, side wallet, ika base chains, dWallet seed bases)
- Raw private keys (EVM hex, Sui `suiprivkey`, Solana base64 keypair, BTC WIF, Aptos hex, Cosmos mnemonic-equivalents)
- Future: hardware-wallet pubkey lists, x402 caps config, encrypted notes, agent-MCP bearer tokens

Today, every wallet re-install means locating these secrets in a notes app / paper / password manager and typing or pasting them back in. The user trades convenience for security: notes app is exfiltrable; paper is losable + fire-vulnerable; password-manager vault is a single point of failure (if you lose the master password, you've lost everything). Worse: most users have 5 to 10 *identity factors already* (Google + Apple + Microsoft + Dropbox + Gmail + Outlook + Twitter + Discord + a passkey or two + a Ledger or YubiKey) but no protocol turns that ambient login surface into a portable recovery mechanism.

ChromaShard turns those identity surfaces into the recovery mechanism, with three core properties:

1. **No new infrastructure.** No coordinator nodes, no federated network, no chromatika-run service that's required for recovery. Everything happens on surfaces the user already controls.
2. **Cryptographic threshold semantics** (k-of-n). Any k of n pre-registered factors suffice to recover. Losing 1 or 2 factors is survivable. A single OAuth account breach does not yield a usable share.
3. **A portable single artifact**: the recovery string. Safe to publish (contains no decryption secrets). Tiny enough to print on paper or QR. Cross-wallet by spec (any wallet linking the library can recover any pack).

The "useless seed phrase that becomes useful only with the right logins" framing is the user-facing pitch. Cryptographically, it is a threshold-encrypted bundle of wrapped Shamir shares, each share wrapped under a key derived from one identity factor's proof.

---

## Goals / non-goals

### Goals (v1)

1. **Fully usable offline** after factor proofs are gathered. The library itself runs in Node + browser + MV3 service worker with no network dependency beyond standard OAuth into the user's own cloud / email / DM accounts.
2. **Threshold recovery** with default 4-of-7, library-parameterized (`k`, `n`, factor weights, cloud-surface-bundle shape, anchor `t`).
3. **Single recovery string** the user holds (base58 + 4-byte checksum, ~3.4 KB typical for 4-of-7 with one cloud-surface-bundle). Also issuable as QR code or `.chromashard` file.
4. **Bag-of-credentials payload** with per-credential metadata (kind, label, derivation paths, chain hints, optional notes) so receiving wallets auto-import seamlessly.
5. **Cross-wallet portability.** Any wallet that links the library spec can recover any pack. Reference implementation outside chromatika ships as part of post-v1 validation.
6. **No single-OAuth-account breach yields a usable share**, even when paired with a leaked recovery string. Cloud factors use a *surface-bundle primitive* whose locations and content keys are derived from an *anchor key* `A` that lives only inside the strong factors (Shamir `t-of-m`, default `t=2`).
7. **Factor rotation.** Add / remove / replace one factor without protocol breakage; old recovery strings cleaned up via cloud-side zero-byte sentinels.
8. **Test-recovery dry-run** during backup. The wallet walks the user through the full recovery flow once *before* letting them save the recovery string, catching "I scanned the QR but didn't actually save the seed" / "the email never arrived" / "the OAuth scope was wrong" mistakes while the user is still present.

### Non-goals (v1)

- OPRF coordinator / federated node network. Architecturally excluded by user requirement (and adds operational debt).
- "Sign in with Google" using id_tokens as cryptographic key material. Technically unsound. The desired UX is covered by passkey-in-Google-Password-Manager instead.
- SMS as a factor. Entropy too low; channel observable; deferred.
- On-chain anchoring of the pack. Interesting future work; not v1. Tracked in roadmap.
- Automatic factor-rotation without recovery-string re-issuance. More complex; tracked in roadmap.
- Multi-party / shared-custody (Argent-style social recovery where guardians are *other people*). This is single-user backup.
- Duress passphrase support. Tracked in roadmap as v1.5.

---

## Trust model

### Threats addressed

| Threat | Defense |
|---|---|
| User loses their device | Threshold recovery from other factors |
| User forgets passphrase | Threshold recovery without it (passphrase = 1 of n) |
| Single OAuth account breached (Google account taken over) | Cloud-surface-bundle pieces live at HMAC-derived locations across Drive / Docs / Gmail / Keep that are only discoverable with the anchor key `A`. Attacker with Google + recovery string alone sees thousands of normal-looking files and can't tell which (if any) are ChromaShard pieces. Even guessed correctly, contents are AES-GCM under a key only derivable from `A`. |
| Single OAuth account breached + recovery string leaked + 1 strong factor compromised | Anchor key requires `t=2` strong factors to reconstruct. One compromised strong factor is still under threshold: anchor unreconstructible, cloud surfaces undiscoverable and unreadable. |
| Single OAuth account breached + recovery string leaked + ≥t strong factors compromised | Attacker reconstructs anchor, finds cloud surfaces, but still has only the cloud bundle's share + the t strong shares. Master threshold k=4 not met unless t ≥ k. With default t=2, k=4 the attacker needs k−t = 2 *more* shares from somewhere else. |
| Email inbox phished / read by ISP | Email fragment = 1 share only; threshold not met |
| Hardware wallet stolen | Hardware sign = 1 share only |
| Recovery string leaked (paper photo, cloud doc shared) | Contains no decryption secrets; useless without ≥k factor keys |
| Tamper attempt detection | Audit beacon files in cloud-surface-bundles + recovery-string fingerprint check (see Audit section) |
| Cross-chain key compatibility | Receiving wallet checks payload `kind` against its supported credential types and ignores unknowns |

### Formal adversary models (v1)

Each adversary `A` knows the recovery string `R` (which is public by assumption). What they additionally hold determines outcome.

- **A0 (passive observer):** `R` only. Outcome: pack opaque (no factor keys, no anchor reconstruction, no master key).
- **A1 (one cloud account):** `R` + full control of one OAuth provider (e.g., Google). Outcome: pack opaque. Surfaces undiscoverable without anchor; contents unreadable even if filenames guessed.
- **A2 (one strong factor):** `R` + one phished/cracked strong factor key. Outcome: 1 master share + 1 anchor share. Anchor `t=2` not met → cloud surfaces still inaccessible. 1 < k=4 → pack opaque.
- **A3 (one strong + one cloud):** `R` + 1 strong factor + 1 OAuth account. Outcome: still 1 master share + 1 anchor share. Anchor `t=2` not met. Cloud surfaces inaccessible. Pack opaque.
- **A4 (anchor-meeting):** `R` + `t=2` strong factors + 1 OAuth account hosting a cloud surface. Outcome: anchor reconstructible, cloud surfaces visible + decryptable. Total shares: 2 strong + 1 cloud bundle (if `k_internal` met) = 3 master shares. 3 < k=4 → pack opaque.
- **A5 (threshold-meeting):** `R` + 4 strong factors. Outcome: 4 master shares, anchor reconstructed, recovery succeeds. (This is the design intent: a legitimate user recovers.)
- **A6 (cloud-only):** `R` + k cloud-account compromises only (no strong factors). Outcome: anchor unreconstructible (`t=2` strong factors required), cloud surfaces undiscoverable. Pack opaque even if attacker has 4+ cloud accounts.

The structural property: **any successful recovery requires ≥t strong factors AND ≥k total factors.** Adversaries below either floor fail.

### Out of scope (documented, not defended)

- **Device compromise during backup creation.** Malware on the user's machine when they generate the pack. Outside library's reach; mitigated by chromatika running backup in MV3 SW + popup, not page context.
- **Inbox/DM eavesdropper has factor key in plaintext.** Email/DM factors are documented as *weaker* than passkey/hardware. Spec recommends: configure k such that strong factors alone meet threshold. Library enforces this in `strict` mode.
- **Cloud provider TOS deletes file.** Library writes audit beacons; chromatika polls weekly and warns user. User responsibility to maintain accounts.
- **OAuth provider locks user out** (Google account banned, Apple ID closed). Threshold means losing 1-2 factors is survivable; losing >n−k is not.
- **Weak user passphrase** (e.g. `password123`). Argon2id raises the cost but can't make weak passphrases strong. Spec warns; doesn't enforce.
- **Wallet operating in coercion** (user forced to recover under duress). Tracked as v1.5 roadmap item "Duress passphrase" (see Roadmap section).
- **Side-channel attacks on the wallet host.** Timing leaks, power analysis, etc. Library uses constant-time operations where applicable (`@noble/hashes` constant-time SSS), but a compromised host is out of scope.
- **Long-term cryptographic agility.** v1 uses AES-256-GCM + Argon2id + HMAC-SHA256 + SSS over GF(2^8). If any of these break, migration is a v2 concern (tracked in roadmap).

---

## Architecture (high level)

```
                         ┌─────────────────────────────────────────────┐
                         │              BACKUP FLOW                    │
                         └─────────────────────────────────────────────┘

  user secrets (bag)        master key K (256 bits)         Shamir k-of-n shares
  ┌────────────────┐        ┌─────────────────────┐         ┌─────────────────────┐
  │ bip39 #1       │        │   random K          │         │ S1, S2, …, Sn       │
  │ evm privkey #1 ├──AES─→ │   AES-GCM(K, bag)   │  SSS→   │ each Si = 32 bytes  │
  │ sui privkey    │        │  = master ciphertext│         └──────────┬──────────┘
  │ btc WIF        │        └─────────────────────┘                    │
  │ metadata…      │                                                   │
  └────────────────┘                                                   ▼

                            Each share wrapped under factor key:
                            Wi = AES-GCM(Si, Fi)

                            ┌──────────────────────────────────────────┐
                            │  FACTORS (one per logical share)         │
                            ├──────────────────────────────────────────┤
                            │  STRONG (anchor-bearing):                │
                            │  • passkey-PRF    → Fi = PRF(prf_input)  │
                            │  • hardware-sign  → Fi = HKDF(sig)       │
                            │  • passphrase     → Fi = Argon2id(pp)    │
                            │  • totp-seed      → Fi = HKDF(seed)      │
                            │  • email-inbox    → Fi = (mailed bytes)  │
                            │  • social-DM      → Fi = (DM'd bytes)    │
                            │                                          │
                            │  CLOUD (anchor-bound):                   │
                            │  • cloud-surface-bundle:                 │
                            │      Fi assembled via internal k-of-N    │
                            │      SSS over surfaces; surface paths +  │
                            │      content keys derived from anchor    │
                            │      key A (which is itself t-of-m       │
                            │      Shamir-split across strong factors) │
                            └──────────────────────────────────────────┘
                                          │
                                          ▼
                            Anchor binding (cloud factors only):
                            A = 32 random bytes, split t-of-m over strong factors.
                            location(surf_i)    = HMAC(A, "loc/<bundle>/<surf>/<provider>/<service>")
                            content_key(surf_i) = HMAC(A, "key/<bundle>/<surf>")
                            file content = AES-GCM(share_data, content_key, iv)
                                                  │
                                                  ▼
                            Recovery string (base58 + checksum):
                            {
                              version, k, n, weights, grouping,
                              master_ciphertext,
                              [W1, W2, …, Wn],
                              factor_metadata[i] = {
                                type, hint, factor_salt,
                                surface_bundle?{ bundle_idx, k_internal, surfaces[] }
                              },
                              anchor_binding?{ t, m_indices, anchor_ciphertext,
                                               anchor_shares[wrapped Ai_share] },
                              audit_pubkey, created_at, checksum
                            }


                         ┌─────────────────────────────────────────────┐
                         │             RECOVERY FLOW                   │
                         └─────────────────────────────────────────────┘

   recovery string         user proves k factors          shares unwrapped
  ┌────────────────┐      ┌────────────────────────┐    ┌─────────────────┐
  │ paste / scan / │      │ passkey assertion      │    │ S_a, S_b, S_c,  │
  │ upload .pack   ├─────→│ Ledger sign            ├───→│ S_d (any k)     │
  │                │      │ argon2id(passphrase)   │    └────────┬────────┘
  └────────────────┘      │ OAuth into clouds      │             │
                          │ paste email fragment   │             ▼
                          │ …                      │      Lagrange interpolate
                          └────────────────────────┘      reconstruct K
                                                                  │
                                                                  ▼
                                                  AES-GCM-decrypt(master_ciphertext, K)
                                                                  │
                                                                  ▼
                                                       bag of typed credentials
                                                                  │
                                                                  ▼
                                                  receiving wallet auto-imports
                                                  (recognized kinds → vault create;
                                                   unknowns → "skipped, can be exported manually")
```

---

## Components

### 5.1 Threshold protocol

- **Secret sharing scheme:** Shamir's Secret Sharing over **GF(2^8) per byte** (SLIP-39-style), reconstructing K byte-by-byte. Reference: `@noble/secret-sharing` or similar audited library. Alternative GF(2^256) is fine but byte-by-byte SSS is well-tested and re-uses existing tooling. Lagrange interpolation is constant-time when implemented carefully.
- **Master key K:** 256 random bits from `crypto.getRandomValues`. Never persisted; held in transient SW memory during pack creation and during recovery only.
- **Master ciphertext:** AES-256-GCM(payload, K, iv=random 12 bytes). AAD = `pack_version || created_at || checksum_of_metadata`. AAD prevents version downgrade attacks.
- **Default parameters:** k=4, n=7 (per design conversation). Anchor t=2 default.
- **Library exposes:** `(k, n, weights, groupings, anchor_t)` so wallet integrators can pick. chromatika defaults: tiered weighting, scheme B (cloud-surface-bundle), anchor t=2.
- **Scheme B default weighting:**
  - Each strong factor (passkey, hardware, passphrase, totp, email, social-DM) = 1 share.
  - Each cloud-surface-bundle (k_internal-of-N surfaces, anchor-bound) = 1 share. Default: 3 surfaces, k_internal=2.
  - 4-of-7 threshold over logical shares.
- **Cloud-surface-bundle internal split:** Each bundle's factor key Fi is itself split via internal `k_internal`-of-`N` SSS into Fi_1...Fi_N, each written to one surface. So Fi requires any `k_internal` surfaces to reassemble; the full pack still requires 4 logical shares overall.
- **Anchor binding:** All cloud-surface-bundle file locations *and* content-encryption keys are derived from an anchor key `A` that is `t-of-m` Shamir-split across the strong factors only. Default `t=2`. This means cloud surfaces are undiscoverable + unreadable without proving control of at least `t` strong factors first.

#### Pseudo-code (backup-side)

```typescript
function createPack(payload, factors, opts) {
  const K = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = encodeAad(opts.version, opts.created_at, opts.checksum);
  const master_ciphertext = aesGcmEncrypt(payload, K, iv, aad);

  // SSS split K into n shares with threshold k
  const shares = sssSplit(K, opts.k, opts.n);

  // For each factor, derive Fi, wrap Si
  const wrapped = factors.map((factor, i) => {
    const Fi = deriveFactorKey(factor, opts.factor_salts[i]);
    const wrap_iv = crypto.getRandomValues(new Uint8Array(12));
    return { wrapped_ciphertext: aesGcmEncrypt(shares[i], Fi, wrap_iv), wrap_iv };
  });

  // Anchor binding (if any cloud factor present)
  let anchor_binding = undefined;
  if (factors.some(f => f.type === 'cloud-surface-bundle')) {
    const A = crypto.getRandomValues(new Uint8Array(32));
    const Akey = crypto.getRandomValues(new Uint8Array(32));
    const a_iv = crypto.getRandomValues(new Uint8Array(12));
    const anchor_ciphertext = aesGcmEncrypt(A, Akey, a_iv);

    const strong_indices = factors
      .map((f, i) => f.type !== 'cloud-surface-bundle' ? i : -1)
      .filter(i => i >= 0);
    const Akey_shares = sssSplit(Akey, opts.anchor_t, strong_indices.length);

    const anchor_shares = strong_indices.map((idx, j) => ({
      share_index: idx,
      wrapped_anchor_share: aesGcmEncrypt(Akey_shares[j], factorFi[idx], ws_iv),
    }));

    anchor_binding = { t: opts.anchor_t, m_indices: strong_indices, anchor_ciphertext, anchor_iv: a_iv, anchor_shares };

    // For each cloud-surface-bundle, write surfaces using A
    for (const cloud_factor of cloudFactors) {
      const Fi = cloud_factor.Fi;
      const internal_shares = sssSplit(Fi, cloud_factor.k_internal, cloud_factor.surfaces.length);
      for (let j = 0; j < cloud_factor.surfaces.length; j++) {
        const location = hmacSha256(A, `loc/${bundle_idx}/${j}/${provider}/${subservice}`);
        const content_key = hmacSha256(A, `key/${bundle_idx}/${j}`);
        const file_iv = crypto.getRandomValues(new Uint8Array(12));
        const file_content = aesGcmEncrypt(internal_shares[j], content_key, file_iv);
        await cloudProvider.write(location, file_content);
      }
    }
  }

  return encodePack({ version: 1, k: opts.k, n: opts.n, ..., master_ciphertext, master_iv: iv, shares: wrapped, anchor_binding, audit_pubkey, created_at, checksum });
}
```

(Real implementation will be more careful about zeroization, constant-time operations, error handling.)

### 5.2 Factor types

| Type | Mechanism | Recovery UX | Entropy | Setup complexity |
|---|---|---|---|---|
| `passkey-prf` | WebAuthn create with `prf` extension at backup; `get` with `prf` at recovery. PRF input = `HMAC-SHA256("chromashard/v1/factor-prf" \|\| factor_salt)`. PRF output = 32 bytes = Fi. **Requires PRF-supporting authenticator**: ✓ 1Password 8+, ✓ Bitwarden, ✓ Google Password Manager (Chrome 137+), ✓ YubiKey 5 series w/ FIDO2.1, ✓ recent Android phones. ✗ iCloud Keychain PRF support is partial (improving as of Apple 2026 updates; library probes capabilities and refuses to register if PRF unavailable). | Touch passkey-enabled device (phone, security key, password manager popup). Same passkey lives in the user's password-manager vault, surfaces as "Sign in with Google / Apple / 1Password" via the browser passkey UX. | 256 bits (high) | Low. One WebAuthn create flow. |
| `hardware-sign` | Vendor-specific deterministic signature over fixed message `"chromashard/v1/factor-hwsign/" \|\| factor_salt`. Signature → HKDF-SHA256 → 32 bytes Fi. Supports Ledger (Sui / EVM apps), Trezor (EVM app), YubiKey (FIDO2 PRF, falls back to passkey-prf path). | Connect device, approve sign on screen. Same pattern as chromatika's `IKA_USK_DERIVATION_MESSAGE`. | 256 bits (high) | Medium. Requires USB / NFC connection. |
| `passphrase` | User-chosen (or chromatika-generated) string. Argon2id(t=3, m=64 MiB, p=4) → 32 bytes Fi. Salt = per-factor `factor_salt`. | User types passphrase. | User-dependent. A 6-word diceware = ~75 bits; "P@ssw0rd1!" = ~30 bits. Library warns and shows entropy meter at registration. | Low. Just typing. |
| `totp-seed` | At backup: library generates 80-bit random TOTP seed, displays QR + plaintext for user to scan into Authenticator app *and* write down. HKDF(seed, "chromashard/v1/factor-totp/" \|\| factor_salt) → Fi. | At recovery: user re-enters the seed (typically by exporting from Google Authenticator Transfer / 1Password / etc., or from their paper backup). **Caveat:** Some apps (e.g., Authy) hide the seed and cannot export. Spec warns; wallet UI explains. | 80 bits (medium) | Medium. Requires saving seed to paper + scanning to app. |
| `email-inbox` | At backup: library mails the user 32 random bytes (base32-encoded) at registered address. At recovery: user pastes that value, OR wallet OAuths into Gmail / Outlook via IMAP / Graph API and reads it. Fi = the bytes (no KDF; already random). | "Find the email subject 'ChromaShard recovery fragment' and paste the code." | 256 bits (high), but in-transit via SMTP (so weaker against ISP / mail-server reads) | Low. Confirming an email address. |
| `social-dm` | Same as `email-inbox` but via DM platform. **v1 supports Telegram only** (MTProto User API, Saved Messages, clean fit). Discord and Twitter deferred to v1.1+. Fi = the bytes sent. | At recovery: paste fragment from the saved Telegram message, OR OAuth into Telegram and let library read the message at the HMAC-derived subject. | 256 bits (high), but in-transit via Telegram servers | Medium. Phone-number login on first use. |
| `cloud-surface-bundle` | At backup: user picks N surfaces (any combination of providers + sub-services, see "Provider surfaces" below). Library generates Fi, splits via `k_internal`-of-N SSS into Fi_1...Fi_N. Each Fi_j is AES-GCM-encrypted with `content_key(j) = HMAC(A, "key/<bundle_idx>/<j>")` and written to its surface at `location(j) = HMAC(A, "loc/<bundle_idx>/<j>/<provider>/<subservice>")`. Anchor key `A` is reconstructible only by recovering `t` strong-factor shares. | At recovery: user unwraps `t` strong factors first → reconstructs `A` → derives all surface locations → OAuths into any `k_internal` of the bundle's `N` providers → reads files → decrypts using `content_key(j)` → SSS-reassembles Fi → unwraps Si. | 256 bits (high), anchor-bound | Medium-high. Multiple OAuth flows. |

**Strong-factor backbone rule** (recommended in spec, enforced by wallet UI in `strict` mode): when constructing a pack, the wallet should validate that strong factors alone (passkey + hardware + passphrase) reach the threshold. Email / DM / cloud are "convenience" supplements, not the security floor. This addresses the email/DM eavesdropper concern. Anchor binding makes this rule cryptographically meaningful for cloud factors: cloud factors literally cannot be used until `t` strong factors have been proven, so they cannot substitute for the strong-factor backbone.

#### Failure modes per factor type (UX-level)

- **passkey-prf**: lost device + lost iCloud sync = factor unrecoverable. Mitigation: use password-manager-stored passkeys (cloud-synced).
- **hardware-sign**: device damaged or firmware bricked = factor unrecoverable. Mitigation: paper backup of the seed phrase that controls the device (orthogonal to ChromaShard).
- **passphrase**: forgotten = factor unrecoverable. Mitigation: write down + store in a non-factor location.
- **totp-seed**: authenticator app deleted without export = factor unrecoverable. Mitigation: save QR / seed to a non-Authy app.
- **email-inbox**: email account deleted = factor unrecoverable. Mitigation: keep email account active.
- **social-dm**: Telegram account banned or deleted = factor unrecoverable. Mitigation: keep account active.
- **cloud-surface-bundle**: any (N − k_internal + 1) of N surfaces deleted = bundle unrecoverable (one factor lost). Mitigation: weekly audit-beacon poll surfaces this before it becomes a problem.

In all cases, losing 1 to (n − k) factors is survivable by the master threshold. Losing more is fatal. The wallet UI shows a "recovery health" indicator after backup so the user knows how close they are to the edge.

### 5.3 Anchor binding (cloud surface bundles only)

To prevent the threat "attacker who has the recovery string + a single OAuth account can find and decrypt my cloud shards," every cloud-surface-bundle factor is *anchor-bound* to the strong-factor subset of the pack.

**Mechanism:**

- **Anchor key `A`:** 32 random bytes generated at backup time. Never written to the recovery string directly. Never persisted in any single location.
- **Anchor share split:** `A` is itself Shamir-split via `t-of-m` over the *strong factors* only. `m = count(strong_factors)` in this pack. Default `t = 2`. Each strong factor `i` receives one anchor share `Ai` alongside its master-key share `Si`.
- **Required constraint:** `t ≤ k` (so that meeting the master threshold of `k` shares always yields at least `t` strong-factor proofs, automatically unlocking the anchor). Library enforces this at backup time; UI rejects configs that violate it.
- **Surface map derivation:** `location(bundle_idx, surface_idx, provider, subservice) = truncate(HMAC-SHA256(A, "chromashard/v1/loc/" || bundle_idx || "/" || surface_idx || "/" || provider || "/" || subservice), provider_path_length)`. Truncation rules:
  - Drive / iCloud Drive / OneDrive / Dropbox folders: 32 hex chars (e.g. `/AppData/<hex>/<hex>`).
  - Google Docs / Microsoft Word doc IDs: full HMAC result (provider accepts arbitrary IDs at create time).
  - Gmail / Outlook labels + subjects: 12-char base32 prefix for label; 16-char base32 for subject.
  - Telegram Saved Messages: message id is provider-assigned; we store the bundle's message-id list in an indexable header message titled with HMAC-derived subject.
- **Per-surface content key:** `content_key(bundle_idx, surface_idx) = HMAC-SHA256(A, "chromashard/v1/key/" || bundle_idx || "/" || surface_idx)`. File written at each surface is `AES-GCM-encrypt(Fi_share, content_key, iv=random12)`.

**Storage in the recovery string:**

```
PackV1 {
  ...,
  anchor_binding?: AnchorBinding,  // present iff at least one cloud-surface-bundle exists
  ...,
}

AnchorBinding {
  t: u8,                          // threshold for reconstructing Akey
  m_indices: [u8],                // which WrappedShare.index values are anchor-bearing (must be strong factor type)
  anchor_ciphertext: bytes,       // AES-GCM(A, Akey, iv); Akey is itself reconstructed from anchor_shares
  anchor_iv: bytes (12),
  anchor_shares: [AnchorShare; m_indices.length],
}

AnchorShare {
  share_index: u8,                // refers to a WrappedShare in the shares array
  wrapped_anchor_share: bytes,    // AES-GCM(Ai_share_of_Akey, Fi_of_that_strong_factor, iv)
  wrapped_anchor_iv: bytes (12),
}
```

Each strong factor's `Fi` wraps *two things*: the master-key share `Si` (in `WrappedShare.wrapped_ciphertext`) and a share `Ai` of `Akey` (in `AnchorShare.wrapped_anchor_share`). Unwrapping a strong factor yields both at once.

**Recovery walk-through:**

1. User proves strong factor #1 → Fi#1 → unwrap Si#1 (master share) + Ai#1 (anchor share).
2. User proves strong factor #2 → Fi#2 → unwrap Si#2 + Ai#2.
3. Anchor reconstruction: with `t=2` anchor shares, Lagrange-interpolate `Akey`, decrypt `anchor_ciphertext` → recover `A`.
4. Now the library can derive every cloud surface's `location` + `content_key`.
5. User OAuths into cloud providers for a bundle → library reads files → decrypts → SSS-reassembles bundle's Fi → unwraps that bundle's Si.
6. Continue with remaining factors until ≥k shares total → reconstruct master K → decrypt payload.

**Security gain summary:**

| Attacker holds | Without anchor binding | With anchor binding |
|---|---|---|
| Recovery string only | Useless (no factor keys) | Useless |
| Recovery string + Google account (no factor keys) | Could enumerate the app-folder and find shards (still encrypted) | Cannot find shards (locations require `A`); even if found, contents encrypted under `content_key` derived from `A` |
| Recovery string + Google account + 1 strong factor | 1 strong share + 1 cloud bundle share via brute-force = 2 < k=4 → fails | Anchor needs t=2 → can't even find clouds → 1 strong share = 1 < k=4 → fails |
| Recovery string + 2+ strong factors compromised + ≥1 cloud account | Could already reach threshold via 4 strong factors | Same end-state if 2 strong + 1 cloud + … → still need k=4 total |

**Why default `t=2`, not `t=1`:** with `t=1`, any single phished strong factor (offline-guessed passphrase, stolen passkey) unlocks the entire cloud surface map. `t=2` forces the attacker to compromise *two* independent strong factors before the cloud surfaces become discoverable.

**Why not `t=k`:** Cloud surfaces should still contribute partial value when strong factors are partially available (e.g., user has 2 strong + 2 cloud → wants threshold 4). If `t=k`, recovering anchor already meets the master threshold and clouds add nothing.

**Anchor key zeroization:** `A` is held only in transient SW memory during a recovery flow. Before returning the recovered payload, the library zeroes the `A` buffer and any intermediate HMAC outputs. (Browser GC complicates this; library uses `Uint8Array.fill(0)` on the bytes it controls and avoids string conversions of `A`.)

### 5.4 Provider surfaces (v1)

| Provider | Sub-services in v1 | Mechanism | OAuth scope (min) |
|---|---|---|---|
| `google` | `drive`, `docs`, `gmail`, `keep` | `drive.file` (app-folder only), Docs API for arbitrary doc creation, Gmail labels + subject-derived messages, Keep via Drive REST | `drive.file`, `docs`, `gmail.modify`, no Keep-specific scope (uses Drive) |
| `apple` | `icloud-drive` | CloudKit container, app-folder isolated | App-specific CloudKit container |
| `microsoft` | `onedrive`, `outlook` | OneDrive `Files.ReadWrite.AppFolder`, Outlook mail via Microsoft Graph | `Files.ReadWrite.AppFolder`, `Mail.ReadWrite` |
| `dropbox` | `dropbox-files` | App-folder isolated | `files.content.write` |
| `telegram` | `saved-messages` | MTProto User API via `gramjs`; persists session locally; messages stored in Saved Messages chat | n/a (User API, phone-number login) |
| `generic-imap` | `mailbox` | IMAP+SMTP with app-password auth; fragments stored as flagged messages with HMAC-derived subjects | n/a (app-password / OAuth depending on provider) |

**Deferred to v1.1+:** Discord DMs (needs a bot operator the user trusts; open-source bot code can ship for self-hosters once v1 settles), Twitter / X DMs (paid Basic API tier + no DM-self, revisit if X reverses policy), Telegram channels (vs Saved Messages), Matrix (E2E-encrypted DMs), Signal-link, Box, Proton Drive, pCloud, MEGA, Sync.com.

**Deferred indefinitely:** iMessage (no public API), WhatsApp Business (paid + business-only).

#### Google sub-service specifics (the headline case for single-cloud users)

The "single Google account, multiple surfaces" configuration is the most common user-facing pick. Specific implementation details:

- **`drive`** (scope: `drive.file`): app-folder isolated. Files are not browsable in the user's normal Drive UI; only the chromatika app sees them. Files have HMAC-derived names like `9f3e2b...`. App-folder is a special folder per OAuth client.
- **`docs`** (scope: `docs`): Google Docs created with HMAC-derived document IDs (Google accepts arbitrary IDs at creation). The Doc body contains base64-encoded encrypted bytes wrapped in plain text (looks like a meeting note to a casual observer). Title field is also HMAC-derived but visible in user's Drive root; recommend hiding via `properties` API.
- **`gmail`** (scope: `gmail.modify`): a Gmail label is created (HMAC-derived name) and a single message is sent to self with HMAC-derived subject. Body contains the encrypted bytes (base64). Library can read by querying for the label or subject.
- **`keep`** (scope: handled via `drive.appdata`): Keep notes are stored as Drive files in the user's app-data folder. Created via Drive REST with the Keep mimetype.

**Operational consideration:** Google's `drive.file` scope is robust against TOS changes (it's part of the public API). `gmail.modify` is more invasive but documented. `docs` is straightforward. Keep is less stable (Google has deprecated the standalone Keep API multiple times); library uses Drive-backed storage to avoid Keep-specific churn.

### 5.5 Recovery string format

```
CBOR encoding of:
  PackV1 {
    version: 1,
    k: u8,
    n: u8,
    weights: enum { TIERED_DEFAULT, FLAT, CUSTOM(weights_table) },
    created_at: u64 (epoch seconds),
    master_ciphertext: bytes (payload AES-GCM ciphertext + tag),
    master_iv: bytes (12 bytes),
    shares: [WrappedShare; n],
    anchor_binding?: AnchorBinding,    // present iff ≥1 cloud-surface-bundle factor exists
    audit_pubkey: bytes (ed25519, 32 bytes),
    checksum: bytes (truncated SHA-256, 4 bytes),
  }

  WrappedShare {
    index: u8,
    factor_type: enum,                 // passkey-prf | hardware-sign | passphrase
                                       //  | totp-seed | email-inbox | social-dm
                                       //  | cloud-surface-bundle
    factor_hint: string (max 32 bytes, e.g., "passkey:1password", "email:m**@example.com" masked),
    factor_salt: bytes (16 bytes),
    wrapped_ciphertext: bytes (Si AES-GCM ciphertext + tag),
    wrapped_iv: bytes (12 bytes),
    surface_bundle?: SurfaceBundleMeta,  // present iff factor_type == cloud-surface-bundle
  }

  SurfaceBundleMeta {
    bundle_idx: u8,                    // 0..255; identifies this bundle for HMAC domain separation
    k_internal: u8,                    // surfaces needed to reassemble Fi
    surfaces: [SurfaceRef; N],
  }

  SurfaceRef {
    surface_idx: u8,
    provider: enum { google, apple, microsoft, dropbox, telegram, generic-imap, ... },
    subservice: enum { drive, docs, gmail, keep, icloud-drive, onedrive, outlook,
                       dropbox-files, saved-messages, dm, mailbox, ... },
    // NOTE: actual location (path / doc-id / subject / etc.) is NOT stored here.
    // It is derived at runtime from HMAC(A, "loc/<bundle_idx>/<surface_idx>/<provider>/<subservice>").
  }

  AnchorBinding {
    t: u8,                             // threshold for reconstructing Akey (default 2)
    m_indices: [u8],                   // strong-factor WrappedShare indices that hold an anchor share
    anchor_ciphertext: bytes,          // AES-GCM(A, Akey, anchor_iv)
    anchor_iv: bytes (12),
    anchor_shares: [AnchorShare; m_indices.length],
  }

  AnchorShare {
    share_index: u8,                   // matches a WrappedShare.index in m_indices
    wrapped_anchor_share: bytes,       // AES-GCM(Akey_share_i, Fi, iv), Fi from that strong factor
    wrapped_anchor_iv: bytes (12),
  }
```

#### Size breakdown (typical 4-of-7 with one cloud-surface-bundle of 3 surfaces)

| Field | Bytes |
|---|---|
| Header (version, k, n, weights, created_at) | ~20 |
| master_ciphertext (~500 byte payload + 16 tag) | ~520 |
| master_iv | 12 |
| WrappedShare × 7 (each ~80 bytes: index + hint + salt + wrap + iv) | ~560 |
| SurfaceBundleMeta (1 bundle, 3 surfaces) | ~30 |
| AnchorBinding header | ~20 |
| AnchorShare × 6 strong factors (each ~50 bytes) | ~300 |
| audit_pubkey | 32 |
| CBOR overhead | ~50 |
| **Total CBOR** | **~1544 bytes** |
| Base58 encoded with 4-byte checksum | **~2100 chars** |

For larger payloads (e.g., 10 BIP39 mnemonics, 3 private keys, metadata), the master_ciphertext grows but everything else stays roughly the same. A typical "all my secrets" pack lands at 3 to 4 KB base58.

#### Encoding & display

- CBOR-encoded, then **base58-encoded with a 4-byte SHA-256 checksum suffix** (Bitcoin-address style).
- Chunked into 4-character groups for readability: `7Q3v gB2k YpQ8 ...` (groups of 4, line breaks every 8 groups).
- Also issuable as a **QR code** (large, ~1500-3500 chars but feasible with QR version 30+).
- Also issuable as a **`.chromashard` JSON-CBOR file** for users who'd rather save a file than copy a string.
- Future: BIP-39-style word-list issuance (tracked in roadmap; more memorable, longer).

### 5.6 Payload format

```typescript
// Plaintext payload (encrypted under K)
type Payload = {
  v: 1;
  createdAt: number;
  credentials: TypedCredential[];
  notes?: string;  // optional user-visible note
};

type TypedCredential = {
  id: string;  // uuid v4
  kind: CredentialKind;
  label?: string;  // user-facing name, e.g., "main wallet"
  value: string;  // the actual secret material, kind-specific encoding
  metadata?: CredentialMetadata;
};

type CredentialKind =
  | 'bip39'              // value: mnemonic words
  | 'bip39-passphrase'   // value: mnemonic + passphrase, encoded as JSON
  | 'evm-privkey'        // value: 0x-prefixed hex
  | 'sui-privkey'        // value: suiprivkey... bech32
  | 'solana-keypair'     // value: base64 of 64-byte secretKey
  | 'btc-wif'            // value: WIF
  | 'cosmos-mnemonic'    // value: bip39 (specialised label only)
  | 'aptos-privkey'      // value: 0x hex
  | 'webauthn-credential'  // value: credentialId base64 + future-extension info
  | 'opaque'             // value: base64, wallet-specific; carries metadata.wallet to identify
  ;

type CredentialMetadata = {
  chains?: string[];         // hint: ['evm:1', 'evm:8453', 'sui:mainnet']
  derivationPath?: string;   // BIP44 path
  accountIndex?: number;     // for HD multi-account
  walletId?: string;         // free-form, for wallet self-identification
  importNotes?: string;      // human-readable instructions for the receiving wallet
  createdAt?: number;
};
```

**Receiving wallet auto-import** loops over `payload.credentials`, matches `kind` against its support table, and imports each recognized one. Unrecognized kinds (e.g., a future `webauthn-credential` exported by chromatika but not understood by Metamask) are shown to the user as "this pack contains 1 credential this wallet doesn't support; you can extract it as JSON."

---

## Backup flow (user-facing)

Typical end-to-end backup for a 4-of-7 pack with one cloud-surface-bundle: **5 to 10 minutes** (estimate based on similar OAuth-heavy flows like Privy onboarding).

1. User opens chromatika → Settings → **"Create recovery shard pack"**. (~10 seconds.)
2. Wallet prepopulates "secrets to back up" with the active user's vaults (mnemonics, imported privkeys). User can add raw extras (paste an EVM privkey from another wallet, paste a BTC WIF, etc.). (~30 seconds.)
3. Wallet asks for **factor selection** (UI menu): (~30 seconds.)
   - Pick at least n=7 factors.
   - Strong factor backbone validator: wallet refuses to proceed if strong factors alone can't reach k=4. (e.g., user picked 3 cloud-surface-bundles + 4 emails + 0 passkeys → refused: cloud bundles cannot serve as strong factors because of anchor binding, and the email/DM-only configuration leaves the security floor in OAuth-account-takeover territory.)
4. For each factor, the wallet walks the user through registration: (~30-90 seconds per factor.)
   - `passkey-prf`: WebAuthn create flow. User picks where to save (device, password manager).
   - `hardware-sign`: connect Ledger / Trezor, approve signature.
   - `passphrase`: type / type-confirm; suggested entropy meter.
   - `totp-seed`: scan QR into Authenticator + **download backup of seed**.
   - `email-inbox` / `social-dm`: confirm address / handle, send fragment, user verifies receipt.
   - `cloud-surface-bundle`: user picks a "shape" (cross-provider trio, single-provider multi-surface, or custom mix). OAuths into each surface's provider. Library generates anchor key `A`, splits `A` via `t-of-m` across strong factors (after all strong factors are registered), then for each bundle: derives surface locations from `A`, generates Fi, internal-SSS splits Fi, AES-GCM encrypts each Fi_share under the per-surface content_key (also derived from `A`), uploads to each surface at its HMAC-derived path/subject/id.
5. Library generates K, splits, wraps; assembles recovery string. (~1 second.)
6. **Test-recovery dry-run** (mandatory): wallet immediately walks user through the recovery flow once before letting them save. Catches "I scanned the QR but didn't actually save the seed" / "the email never arrived" / "the OAuth scope was wrong" mistakes while the user is still in the flow. (~2-3 minutes.)
7. User saves the recovery string. Wallet offers: (~30 seconds.)
   - Copy to clipboard
   - Download as `.chromashard` file
   - QR code for scanning into another device
   - "Send to my email" (note: if email is *also* configured as a factor, breaching the email account gives an attacker both the recovery string *and* 1 factor share. Still survives k=4 threshold (3 more factors needed), but it reduces defense-in-depth. Wallet warns and recommends storing the string in a non-factor location).

**Total: ~5 to 10 minutes for a 4-of-7 pack.** Bigger packs (7-of-10 with 2 cloud bundles) take longer, primarily due to OAuth flow latency.

---

## Recovery flow (user-facing)

Typical end-to-end recovery for a 4-of-7 pack: **3 to 6 minutes**, depending on which factors the user proves first.

1. User installs chromatika fresh / wants to recover into a different wallet (e.g., Rabby). (~30 seconds.)
2. Onboarding choice: "I have a shard pack." (~10 seconds.)
3. User pastes / scans / uploads recovery string. (~30 seconds.)
4. Wallet parses, validates checksum, displays: (~5 seconds.)
   - "This pack was created on [date]. It requires [k] of [n] factors to recover. Available factors: [icon list with hints]."
5. User proves factors in two phases: (~1-2 minutes per factor.)
   - **Phase A (strong factors first, to unlock the anchor):**
     - Passkey: WebAuthn assertion → PRF output → Fi → unwrap Si **and** anchor share Ai.
     - Hardware: connect device, sign → HKDF → Fi → unwrap Si and Ai.
     - Passphrase: type → Argon2id → Fi → unwrap Si and Ai.
     - TOTP: enter seed → HKDF → Fi → unwrap Si and Ai.
     - Email: paste fragment or OAuth Gmail/Outlook → Fi → unwrap Si and Ai.
     - DM: paste fragment or OAuth into Telegram → Fi → unwrap Si and Ai.
     - Once `t` strong factors are proven, library reconstructs `Akey` → decrypts anchor → `A` in hand → cloud surfaces become addressable.
   - **Phase B (cloud surface bundles, now addressable):**
     - For each cloud-surface-bundle factor in the pack, the wallet shows the bundle's listed surfaces (provider + sub-service names; *not* the locations, those are still secret-derived). User OAuths into each surface's provider, the library queries the HMAC-derived location, decrypts the file with the HMAC-derived content key, and SSS-reassembles Fi once `k_internal` surfaces have responded → unwrap Si.
   - Phases are sequenced in the UI but can interleave: the user can start a cloud bundle's OAuth flow as soon as `t` strong factors are unwrapped, even if more strong factors remain.
6. Once k shares unwrapped, library Lagrange-interpolates K, decrypts master ciphertext, returns payload. (~1 second.)
7. Wallet shows preview: "Found 3 BIP39 mnemonics, 2 EVM private keys, 1 Sui private key. Import?" (~20 seconds.)
8. User confirms; wallet imports each kind into its vault model. (~30 seconds.)

**Total: ~3 to 6 minutes for a 4-of-7 pack** assuming factors are at hand. First-time MTProto Telegram login adds ~1-2 minutes for SMS verification.

---

## Audit / tamper detection

- **Audit beacon per cloud-surface-bundle:** each bundle includes a beacon location derived from `A` (`location = HMAC(A, "beacon/<bundle_idx>")`). Whenever the recovery flow reads a bundle's surfaces, it also writes a small access record (timestamped + truncated SHA of the requester's anchor reconstruction) to one of the bundle's surfaces. The chromatika wallet, on subsequent unlocks of its primary vault, **polls the user's clouds weekly** for unexpected beacon writes. Spike → notify user "your recovery shards were accessed at [time] from [provider]; was this you?". (Polling itself needs the anchor key, so the wallet caches `A` in `chrome.storage.session` when the user is unlocked, same trust boundary as the rest of the unlocked-vault state.)
- **Recovery-string fingerprint:** wallet stores `SHA-256(recovery_string)[:8]` locally. On startup it can prompt "your shard pack fingerprint is X, does that match the string you saved?" to catch tampering.
- **Audit pubkey in recovery string:** allows future-version chromatika to sign access events for non-repudiation. Field is reserved in v1 format; activation tracked as v1.5 roadmap item "Audit signing".

---

## Factor rotation

v1: changing the factor set requires reissuing the recovery string. Wallet keeps the in-progress old pack temporarily so the user can sanity-check both old and new work before retiring the old.

- **Add factor:** regenerate K, regenerate shares with new (k', n'), reissue string. Old string still works until user removes it (cloud beacon stays). Anchor key `A` is regenerated and re-split across the new strong-factor set; old cloud files at old anchor-derived locations are orphaned (cleaned up by the deletion step below).
- **Remove factor:** same; new string has fewer shares. If the removed factor is a strong factor that held an anchor share, anchor is re-split with new `m-1` (still need `t ≤ k`).
- **Replace factor:** same; e.g., user got a new Ledger, register new factor, remove old.
- **Update default k/n or anchor t:** same; reissue.
- **Cloud cleanup on rotation:** during recovery-string reissuance, library walks all old cloud surfaces (using the *old* anchor, wallet has it cached from the most recent unlock) and overwrites them with zero-byte sentinels so the old pack stops being usable even with the old string. User can opt to skip cleanup if they want the old pack to keep working as a fallback.

Wallet UI shows "your recovery string was reissued; update the copy you have saved." If user fails to update, *both* strings work until the user explicitly revokes the old one (which means deleting the obfuscated cloud files for the old pack).

Tracked as v1.1 roadmap item "Additive factor changes (addendum string)" (see Roadmap section).

---

## Operational concerns

Real-world deployment considerations that don't fit cleanly under "security."

### Cost & rate limits

- **Google OAuth + API:** free up to generous quotas. App-folder writes don't count against the user's Drive quota in a meaningful way (~bytes). Gmail send/read uses user's own send/storage quota, also negligible.
- **Telegram MTProto:** free for User API. Library uses the user's existing Telegram account.
- **iCloud CloudKit:** free for app-specific containers, capped at 1 GB / user (well above our needs).
- **Microsoft Graph:** free tier sufficient for personal use.
- **Dropbox:** free tier sufficient for app-folder writes.
- **chromatika library:** no recurring cost. No backend.

### Support model

If a user gets stuck mid-recovery (e.g., OAuth scope rejected, Telegram session expired), the wallet UI must surface clear actionable error messages with self-help. No human support escalation path is feasible for a fully self-sovereign tool. Failure modes that can't be self-recovered (e.g., user lost too many factors below threshold) result in permanent loss of the pack contents. This is the same trust model as a seed phrase, just better-quartered.

### TOS / API change risk

- **Google `drive.file` scope:** stable, part of public Drive API. Low risk.
- **Gmail `gmail.modify`:** stable. Low risk.
- **iCloud CloudKit:** stable. Low risk.
- **Telegram MTProto:** documented public protocol; risk is account ban for "spam" if library misuses it (we don't; messages are user-to-self only).
- **Provider TOS deletions:** wallet polls weekly and warns user if files disappear. User responsibility from there.
- **Library policy:** if a provider becomes unstable (e.g., Microsoft deprecates a scope), library marks that provider as "deprecated for new packs" and existing packs continue to work or get migrated via factor rotation. Tracked under "Cloud provider TOS monitoring" in roadmap.

### Privacy considerations

- The recovery string contains masked hints (`m**@example.com`) so an attacker who has only the string can't immediately tell whose pack it is. But correlation attacks (matching factor hints to known users) are possible.
- Cloud files are encrypted at rest (under content_key derived from `A`) and at name (HMAC-derived). Without `A`, the cloud provider sees opaque blobs. With `A` (which the provider doesn't have), the provider also can't decrypt without the strong-factor key.
- Audit beacon writes are visible in cloud-account activity logs. If an attacker reaches the audit-beacon stage, the user gets notified via the weekly poll.
- **The user is identifiable to OAuth providers.** Google knows the user has a chromatika-app-folder. This is intrinsic to OAuth and unavoidable. Library minimizes by using narrowest possible scopes.

### Account recovery loop

Chicken-and-egg risk: chromatika needs the *user's primary vault unlocked* to run audit polling on the user's behalf. If the primary vault is locked or absent (fresh install), audit polling doesn't run. Mitigation: the wallet runs a "recovery health check" prompt during onboarding that asks the user to do a quick anchor unlock + audit-beacon check. Not required, but offered.

### Disaster scenarios

- **Chromatika team disappears.** Library is open-source; another team can fork or users can use a reference implementation directly. No coordinator dependency means no central point of failure.
- **Major provider outage.** Threshold semantics survive: if Google is down, user can still recover via 4 strong factors not involving Google.
- **OAuth provider revokes app credentials.** Library can re-register under new credentials; existing packs continue to work because cloud files don't depend on app credentials at rest.

---

## Comparison with existing solutions

| System | Trust model | Identity factors | Single string? | Cross-wallet? | Free? | Open source? | Anti-coercion? |
|---|---|---|---|---|---|---|---|
| **Plain seed phrase** | Self-custody, single secret | None | Yes (12-24 words) | Yes | Yes | n/a | No |
| **ChromaShard** (proposed) | Self-custody, threshold | Many (passkey, hardware, OAuth, etc.) | Yes | Yes (by spec) | Yes | Yes (BSD/MIT) | v1.5 roadmap |
| **Web3Auth tKey** | Federated nodes + user shares | OAuth via node network | No (multi-share) | Limited (SDK-bound) | Free tier | Open SDK | No |
| **Privy embedded wallets** | Centralized provider | OAuth + device | No | No | SaaS tiered | No | No |
| **Magic Link** | Centralized provider | Email + device | No | No | SaaS tiered | No | No |
| **Lit Protocol PKP** | Threshold network | OAuth via Lit nodes | On-chain | Limited (Lit-bound) | Free tier | Open | No |
| **SLIP-39 / Shamir Backup** | Self-custody, threshold | Paper shares (no identity gating) | Multi-share | Yes | Yes | Yes | No |
| **Trezor Hidden Wallet** | Self-custody, single device | Passphrase | No | No | Free w/ device | Yes (firmware) | Yes (decoy) |
| **MetaMask Social Recovery** | Smart contract guardians | Other wallets | On-chain | EVM only | Gas fees | Yes | No |
| **Argent Guardians** | Smart contract guardians | Other wallets | On-chain | EVM only | Gas fees | Yes | No |
| **iCloud Keychain Backup** | Centralized vendor (Apple) | Apple ID | Apple-only | No | Free | No | No |

### What's distinctive about ChromaShard

- **Threshold + self-custody + no nodes.** Most threshold systems use a federated node network (Web3Auth, Lit) or a smart contract (MetaMask Social Recovery, Argent). ChromaShard's threshold logic runs entirely client-side; the "nodes" are the user's own identity surfaces.
- **Cloud-as-surface architecture.** No existing solution uses the user's own Google Drive / iCloud / Telegram as cryptographic share storage. SLIP-39 uses paper. Trezor uses one device. Most others use centralized backends.
- **Single portable artifact + multi-credential payload.** SLIP-39 splits one seed; ChromaShard packs many secrets into one bundle with metadata for auto-import.
- **Anchor binding.** No existing solution combines a strong-factor anchor with cloud-storage shards. This is the key novelty that makes "single Google account doesn't yield a usable share" work.

### What ChromaShard explicitly is *not*

- Not a custodial wallet. The library does not hold or operate on the user's secrets after returning them.
- Not a smart contract. No on-chain logic. (On-chain anchoring is an optional v1.5 addition for tamper-evidence, not functionality.)
- Not a network. No nodes, validators, or relays beyond standard provider OAuth.
- Not a key generator. The library takes existing secrets as input; it doesn't generate wallet keys for the user.

---

## Library API (TS sketch)

```typescript
// Package: @chromatika/chromashard (final name TBD; placeholder)
//
// Platform: pure TS + WebCrypto + @noble/* hashes. Runs in Node, browser,
// MV3 SW (with the existing buffer-polyfill chromatika ships).

import {
  createShardPack,
  recoverShardPack,
  parseRecoveryString,
  testRecover,
  type FactorConfig,
  type TypedCredential,
} from '@chromatika/chromashard';

// --- Backup ---

const result = await createShardPack({
  payload: [
    { kind: 'bip39', label: 'main wallet', value: 'word1 word2 …', metadata: { chains: ['evm:1','sui:mainnet'] } },
    { kind: 'evm-privkey', label: 'side wallet', value: '0xabc…', metadata: {} },
  ],
  scheme: {
    k: 4,
    n: 7,
    weights: 'tiered-default',     // or 'flat' or { factorType: weight } map
    anchorBinding: { t: 2 },       // applies only if any cloud-surface-bundle is configured
  },
  factors: [
    { type: 'passkey-prf', config: { rpId: 'chromatika.xyz', userName: 'me@example.com' } },
    { type: 'passphrase', config: { /* prompt callback */ } },
    { type: 'hardware-sign', config: { vendor: 'ledger', appName: 'Ethereum' } },
    { type: 'totp-seed', config: { label: 'ChromaShard recovery', issuer: 'Chromatika' } },
    { type: 'email-inbox', config: { address: 'me@example.com', sendVia: 'smtp-callback' } },
    { type: 'social-dm', config: { platform: 'telegram', handle: '@me' } },
    {
      type: 'cloud-surface-bundle',
      config: {
        kInternal: 2,
        surfaces: [
          // Example: single-provider multi-surface (defends single-Google-account-breach)
          { provider: 'google',  subservice: 'drive', oauth: googleOauthCallback },
          { provider: 'google',  subservice: 'gmail', oauth: googleOauthCallback },
          { provider: 'google',  subservice: 'keep',  oauth: googleOauthCallback },
        ],
      },
    },
  ],
  onFactorRegister: async (factorRef) => { /* wallet UI prompts user */ },
  onProgress: (event) => { /* progress bar */ },
});

// result.recoveryString: string  (base58 with checksum)
// result.recoveryStringFile: Uint8Array  (.chromashard JSON-CBOR)
// result.qrPayload: string  (compact form for QR rendering)
// result.audit: { fingerprint: string, beaconIds: string[] }

// Wallet should immediately invoke testRecover before showing the string to the user:
await testRecover({
  recoveryString: result.recoveryString,
  // Provide live factor provers (already configured from backup):
  factorProvers: result.activeProvers,
});

// --- Recovery ---

const parsed = parseRecoveryString(userInputString);
// parsed.k, parsed.n, parsed.factors[i] = { type, hint }

const recovered = await recoverShardPack({
  recoveryString: userInputString,
  factorProver: async (factorRef) => {
    // Wallet UI walks user through proving this factor.
    // Returns 32 bytes Fi (factor key) OR throws.
  },
  onProgress: (event) => { /* progress bar */ },
});

// recovered.payload.credentials: TypedCredential[]
// recovered.metadata: { createdAt, sourceWallet?, ... }
```

---

## Chromatika integration

- **New settings section:** `src/ui/pages/SettingsPage.tsx` → "Recovery shard pack" panel.
- **Backup screen:** new component `RecoveryChromaShardPanel.tsx`. Picks secrets from `wallet-service` (mnemonics + imported privkeys for each vault) + lets user paste extras. UI is multi-step:
  1. "Choose secrets to back up" (checklist of vaults + custom-paste field)
  2. "Choose factors" (menu of factor types with descriptions + entropy hints)
  3. "Register factor [i] of [n]" (per-factor wizard)
  4. "Test recovery" (mandatory dry-run)
  5. "Save recovery string" (copy / file / QR)
- **Recovery onboarding option:** add "I have a shard pack" to `WalletSetupFlow.tsx` alongside the existing "I have a seed phrase" / passkey / hardware / WaaP / Lazor / Seeker / Ledger paths.
- **Auto-import:** for each recovered TypedCredential, route to the appropriate `wallet-service` flow:
  - `bip39` → `importVault({ mnemonic })`
  - `evm-privkey` / `sui-privkey` / `solana-keypair` / `btc-wif` → `importVault({ privkey, kind })` (extend if needed)
  - `aptos-privkey`, `cosmos-mnemonic` etc., same pattern
  - `opaque` with `metadata.wallet === 'chromatika'` → restore additional chromatika-specific state (e.g., encrypted activity notes, x402 caps)
- **Audit polling:** add a `chrome.alarms` weekly poll job in `src/background/chromashard/audit-watcher.ts` that reads beacon files from the user's clouds and surfaces alerts via the existing `OperationProgressBanner` / safety-alert system.
- **Storage:** local pack fingerprint + factor hints at `chromatika_chromashard_meta_v1` (per vault); no secrets, just remind-me data.
- **tRPC router:** `src/server/routers/chromashard.ts` exposes `createPack`, `recoverPack`, `pollAudit`, `rotateFactor`. UI calls go through this; library is loaded server-side (SW) for crypto and provider OAuth.
- **MV3 quirks:** library imports the existing `buffer-polyfill.ts` to use `Buffer` for `@noble/*` operations. WebAuthn must run from popup/side-panel (user-gesture context), not SW; library exposes a clean popup-to-SW handoff.

---

## Open questions / risks

1. **Social-DM platform support in v1**: Telegram only (MTProto User API via `gramjs`, ~1-2 MB extra SW bundle, no backend, Saved Messages as the per-user storage). Phone-number login is a one-time setup. Discord and Twitter explicitly deferred to v1.1+: Discord because every DM path adds a bot trust dependency (operator the user has to vet); Twitter because DM read/write requires the paid Basic API tier and has no DM-self capability. The `social-dm` factor type stays platform-agnostic so v1.1 can add providers without a protocol change.
2. **Cloud OAuth scopes:** each provider has different scope granularity. Library should request the *minimum* scope (single-folder access) where the provider supports it (Google Drive: `drive.file`; iCloud: app-folder via CloudKit; OneDrive: app folder). Dropbox: app folder is default.
3. **TOTP seed export friction:** Authy doesn't expose seeds at all. Spec recommends Google Authenticator (Transfer) or 1Password. Library will refuse to count TOTP toward threshold if the wallet UI doesn't surface the seed save step.
4. **Recovery string visual format:** base58 + checksum + 4-char groupings is one option; BIP-39-style wordlists (a "long mnemonic") is another (more memorable, longer). v1 picks base58; word-list issuance is a future option.
5. **iCloud Drive on non-Apple devices:** iCloud Drive web access exists but is limited. Spec marks iCloud as "best-effort" outside Apple devices.
6. **Recovery string size on a paper print:** 3.4 KB base58 (after anchor binding) is ~60 lines of 60 chars at standard font size. Acceptable for a folded letter but tight; brotli compression on the CBOR (estimate 30-40% reduction) would bring it to ~2.4 KB if size becomes a real ergonomic issue.
7. **Multi-language passphrases:** Argon2id is encoding-agnostic but the wallet UI should normalize NFC/NFKD consistently.
8. **Library audit:** security audit before any wallet ships v1 (chromatika-internal + external). Budget item; estimate $30K-$60K for a Trail of Bits / Zellic-tier review.
9. **Trademark/name:** "ChromaShard" is the current working name (chromatika-aligned). Check trademark availability before public release.

---

## Roadmap (post-v1)

### v1.1 (incremental polish; no protocol changes)

- **More social-DM providers**: Discord (via open-source community-bot the user picks an operator for), Twitter / X (revisit if API policy reverses), Matrix (E2E-encrypted DMs).
- **More cloud providers**: Box, Proton Drive, pCloud, MEGA, Sync.com.
- **More sub-services within existing providers**: Telegram channels (vs Saved Messages), Discord server pin (once Discord is added), OneNote sections, Microsoft To Do lists.
- **Additive factor changes** ("addendum string"): add or replace a single factor without reissuing the entire recovery string. Old string stays valid; addendum string links to it. Cuts the "I have to re-print my recovery sheet" cost when a user gets a new YubiKey.
- **Recovery health check**: chromatika prompts the user monthly to verify a random subset of factors still work. Catches "I lost my YubiKey 3 months ago and forgot" before it becomes fatal.
- **Password-manager integration for the recovery string**: 1Password / Bitwarden / Apple Passwords item type "ChromaShard pack" so the string lives natively in the password manager without a copy-paste fingerprint.
- **Brotli compression** of the CBOR before base58. Reduces typical 3.4 KB pack to ~2.4 KB. Less ergonomic-friction on paper backup.
- **Multi-language passphrase normalization**: NFC / NFKD Unicode normalization baked into Argon2id input. Prevents "I typed my passphrase the same way and it doesn't work" because the OS keyboard layer normalized differently.

### v1.5 (features needing their own brainstorm + design pass)

- **Duress passphrase**: at backup the user registers a primary passphrase *and* a duress passphrase. Real passphrase decrypts the real bag of credentials; duress passphrase decrypts a *decoy* payload (a believable but low-value wallet). Both look like successful recoveries: no error, no leak that the real version exists. Mitigates coercion (rubber-hose, border-crossing) scenarios. Open design questions before this can be specced: (a) how the decoy payload is generated (random plausible secrets vs. user-supplied decoy), (b) how to prevent the decoy from accidentally revealing whether a real version exists (timing, file sizes, audit beacons all need scrubbing in the decoy flow), (c) UX for "this feature was used" notifications when the user is back in safe territory.
- **Audit signing**: today the recovery string reserves an `audit_pubkey` field that's unused. v1.5 turns it active: chromatika signs every successful (or attempted) recovery event with a key tied to the unlocked vault, so the user has non-repudiable evidence of any access. Needs a published anchor for the pubkey (could be on-chain or a chromatika-team signature ladder).
- **On-chain anchoring** (opt-in): publish a hash of the recovery string + audit pubkey to a public chain (Sui object, Solana PDA, EVM contract event). Gives the pack a verifiable creation timestamp and a tamper-evident anchor. Useful for legal-evidence scenarios; orthogonal to crypto correctness.
- **Cross-wallet portability proof**: ship a non-chromatika sandbox app that recovers a chromatika-created pack, as a public proof the spec is genuinely portable. Lays the groundwork for ecosystem adoption.
- **Family / inheritance plan**: register one or more "successor" addresses (Ethereum addresses or chromatika-vault IDs). If the user is inactive for N days (configurable, default 180), a delayed-reveal flow lets a successor begin recovery. Successor proves their address via signature; the pack adds an additional "successor share" via a separate Shamir layer. Includes an abort window where the original user can cancel inheritance if they're still alive. Uses on-chain anchoring to coordinate (the inactivity timer is checked on-chain).
- **Time-locked recovery**: enforce an N-day delay (configurable, default 48 hours) between threshold-met and payload-revealed. During the delay window, the user receives notifications across all their factor surfaces ("a recovery of your wallet has been started; if this wasn't you, click here to abort"). Mitigates against rapid-fire compromise.
- **Decoy file scattering**: at backup time, optionally write plausible-looking dummy files alongside the real shard files across all the user's cloud surfaces. Real files are indistinguishable from decoys without the anchor key. Increases forensic effort required to find real shards in a breached account.
- **Geographic anomaly detection**: chromatika notes the IP / approximate location of normal usage; flags recovery attempts from anomalous locations and surfaces them via the audit beacon system.

### v2.0 (protocol-level changes; recovery string format bump)

- **Threshold share refresh / proactive secret sharing**: rotate the master key `K` and re-issue shares to all factors *without changing factor identities*. Old shares become useless. Done on a schedule (e.g., annually) or on-demand after a suspected compromise. Recovery string can carry version metadata so a v2 wallet handles both versions.
- **Post-quantum primitive migration**: when Shor-grade quantum computers threaten ECC / RSA primitives, the underlying Shamir scheme over GF(2^8) remains secure (information-theoretic) but the AES-GCM / HMAC layer needs review. Migration path: swap AES-GCM for AES-GCM-SIV (or a PQ-safe AEAD if one becomes standard); swap HMAC-SHA256 for a PQ-safe MAC. Recovery string version bump.
- **Verifiable Shamir shares (PVSS)**: publish zero-knowledge proofs that each wrapped share is well-formed without revealing its content. Useful for detecting tampering / corruption of individual shares before recovery is attempted. Niche but cryptographically clean.
- **Multi-version pack**: a single recovery string can carry multiple (k, n) tiers. Example: a 2-of-3 tier for "partial recovery" (read-only access, low-value subset of credentials) + a 4-of-7 tier for "full recovery." Lets the user gracefully degrade if they only have a few factors immediately available.
- **Threshold encryption directly to multiple identities**: B2B group wallets where 3-of-5 individual identities can sign / recover. Different threat model from this v1 single-user backup, but the primitives compose.

### Ecosystem (parallel to feature work)

- **Wallet integration SDK**: example integrations for Metamask, Rabby, Phantom, Frame, Lit-Protocol-backed wallets. Each is a thin wrapper over the core library showing "drop this in your wallet code." Encourages adoption.
- **"ChromaShard Recovery" minimal browser extension**: a stripped-down recovery-only extension that contains *just* the library + a recovery UI, no wallet functionality. For users who need to recover a pack into a different ecosystem and don't want to install a full wallet just to do it.
- **Mobile recovery app** (iOS / Android): native app for on-the-go recovery. Mobile-native passkey + biometric UX. Same crypto, different shell.
- **Standards body submission**: present the spec at IETF (potentially an Informational RFC), Ethereum Magicians, CAIP-aligned identity standards groups, W3C Credentials CG. Goal: get the format reviewed and potentially standardized.
- **Hardware vendor integration**: work with Trezor, Ledger, GridPlus, Keystone to surface ChromaShard creation directly in firmware. The hardware device becomes one of the strong factors *and* the wallet that holds the recovery string.
- **Insurance partnerships**: explore offering optional insurance on properly-configured ChromaShard packs. Underwriters: Lloyd's of London (crypto-asset coverage), Nexus Mutual (smart contract insurance has a non-overlapping niche).
- **Bug bounty program**: $10K-$100K tiered bounties for spec / implementation vulnerabilities. Helps build confidence pre-audit.

### Longer-term / explicitly open

- **SMS as factor**: deferred indefinitely because SMS OTPs are observable and low-entropy. Could revisit if a high-entropy SMS variant (256-bit codes, SIM-card-bound keys) ever emerges. Probably not.
- **iMessage / WhatsApp Business as DM providers**: no public APIs that match the spec's requirements; deferred indefinitely.
- **Recovery string as BIP-39-style long mnemonic** (vs base58): more memorable for users who want to type the string by hand, but roughly 3x longer. Considered if user feedback says base58 is too unfriendly.
- **Hardware-backed anchor key**: cache the anchor key `A` on a hardware token (YubiKey, Ledger) instead of `chrome.storage.session` for audit polling. Stronger zeroization; needs hardware token plugged in for weekly polling.
- **IPFS / Filecoin / Arweave as decentralized cloud surface**: store cloud-surface fragments on a decentralized network. Censorship-resistant; pricing model unclear (Arweave has one-time fee; Filecoin has recurring). Niche but interesting for users who don't trust any of the centralized cloud providers.
- **Cross-chain anchor redundancy**: when on-chain anchoring (v1.5) ships, write the anchor to multiple chains simultaneously (Sui + Solana + Ethereum) so one chain going down doesn't prevent verification.
- **Tor / I2P OAuth flows for privacy**: route OAuth provider requests through privacy networks so the provider can't link the recovery flow to the user's normal-traffic IP. Useful for users in adversarial network environments.
- **Sybil resistance for cloud factors**: verify the user's cloud accounts aren't all fake / disposable. Hard problem; might use proof-of-payment (account has a payment method on file) or proof-of-time (account is N months old) as signals.
- **Cloud provider TOS monitoring**: a periodic chromatika-team-published feed of "provider X has changed scope Y; recommend factor rotation" notifications. Uses the same safety-alert plumbing as the existing chromatika alert system.

---

## Verification plan

Before chromatika integration ships (these run in a separate implementation phase, not this design phase):

1. **Unit tests** (vitest):
   - SSS round-trip k-of-n for k∈{2..6}, n∈{3..10}.
   - Factor key derivation determinism for each factor type (with mock provers).
   - Recovery string encode/decode round-trip with checksum tampering rejection.
   - Wrap/unwrap AES-GCM with IV reuse rejection.
   - CBOR schema versioning forward-compat smoke test.
   - Anchor binding split + reconstruct with t∈{1..k}.
   - Surface location derivation determinism (same A + same bundle → same locations).

2. **Integration tests** (vitest + jsdom):
   - Full backup → recovery round-trip with all factor types (mocked transports).
   - Strong-backbone validator: rejects under-spec configurations.
   - Test-recover dry-run catches misconfigured factors.
   - Anchor-binding gate: cloud factors unusable without t strong factors.

3. **Manual smoke** (chromatika-extension e2e):
   - Real passkey via Playwright virtual authenticator with PRF extension.
   - Real Ledger Sui sign (manual smoke, no CI hardware).
   - Real Google Drive OAuth → file write → file read → file delete (smoke account).
   - Real Google Docs OAuth → doc create → doc read → doc delete.
   - Real Gmail OAuth → message send → message read.
   - Real Telegram MTProto → Saved Messages write → read.
   - End-to-end backup + recovery with mixed factor types on real provider accounts.

4. **Cross-wallet portability proof** (post-v1):
   - Reference recovery implementation in a non-chromatika sandbox app; recover a chromatika-created pack into it. Confirms spec is portable.

5. **Adversarial review**:
   - Send the spec + reference impl to ≥2 external crypto-aware reviewers before public release.
   - Run static analysis for IV/nonce reuse, key zeroization, timing-leak entry points.
   - Confirm Argon2id parameters survive a "user with iPhone 14 SE class device" benchmark (no >5s spike).
   - Formal threat model walkthrough with the audit firm.

---

## What this changes for chromatika today

- **`docs/STATUS.md`**: new "ChromaShard: identity-sharded portable recovery" row under Future hardening, then Shipped after delivery.
- **`docs/WALLET_SECURITY.md`**: new section "ChromaShard: threshold backup over identity factors" pointing to this canonical spec doc.
- **`README.md`**: bullet under "vault setup methods": *"Restore from ChromaShard (4-of-7 identity threshold; cross-wallet portable)."*
- **`CLAUDE.md`**: add a short "ChromaShard" entry under the architecture section once the library lives in `wallet-extension/packages/chromashard/` (workspace package).
- **Skills catalog**: eventually a `skills/chromashard-integration/SKILL.md` so other wallets integrating the library have a guided path.

---

## File touch-list (anticipated for v1 implementation)

> Not implementing here. This is the design spec. When implementation begins (after user approves this design and a separate implementation plan is written), the changes will land roughly in:
>
> - **New package:** `wallet-extension/packages/chromashard/` (workspace package; exports core lib).
> - **Wallet integration:** `wallet-extension/src/background/chromashard/{create.ts, recover.ts, audit-watcher.ts}`, plus a tRPC router `src/server/routers/chromashard.ts`.
> - **UI surfaces:** `src/ui/components/RecoveryChromaShardPanel.tsx` (settings), `src/ui/components/ChromaShardRecoveryFlow.tsx` (onboarding), entries in `WalletSetupFlow.tsx`.
> - **Storage keys:** `chromatika_chromashard_meta_v1_<vaultId>` (no secrets; just hints + fingerprints + audit pointers).
> - **Cloud OAuth glue:** `src/background/chromashard/oauth/{google.ts, apple-cloudkit.ts, microsoft-graph.ts, dropbox.ts}`. Each module exposes `writeAtLocation(location, contentBytes)` and `readAtLocation(location)`, plus sub-service helpers (`writeDoc` / `writeGmailMessage` / etc.) for the Google adapter.
> - **Social-DM glue:** `src/background/chromashard/dm/{telegram.ts, generic-imap.ts}`. Telegram uses `gramjs` (User API, MTProto). Discord/Twitter modules deferred to v1.1+.
> - **Tests:** `packages/chromashard/src/**/*.test.ts` (vitest), `e2e/chromashard-roundtrip.spec.ts` (playwright).

---

## Glossary

- **AES-GCM**: Authenticated symmetric encryption (AES with Galois Counter Mode). Provides both confidentiality and tamper-evidence. Used to encrypt the master ciphertext and each wrapped share.
- **Anchor key (`A`)**: 32 random bytes generated at backup. Used to derive cloud surface locations and content keys. Split via Shamir t-of-m across strong factors only.
- **Argon2id**: Memory-hard password hashing function. Used to derive the passphrase factor key. RFC 9106 §4 second option (t=3, m=64 MiB, p=4) by default.
- **Base58**: Bitcoin-style alphabet for encoding binary as alphanumeric without ambiguous characters (no `0`, `O`, `I`, `l`). Used for the human-facing recovery string.
- **CBOR**: Compact binary serialization format (RFC 8949). Used for the recovery string's structured data.
- **Cloud surface bundle**: A logical factor type composed of k-of-N cloud surfaces. Each surface stores one piece; reassembling requires k_internal of N.
- **Factor**: An identity proof the user pre-registers. Examples: passkey, hardware sign, passphrase, TOTP, email inbox, social DM, cloud surface bundle.
- **Factor key (`Fi`)**: 32 bytes derived from a factor at backup/recovery. Used to wrap/unwrap the master share `Si`.
- **HKDF**: Key derivation function (RFC 5869). Used to derive factor keys from variable-length inputs (e.g., a signature).
- **HMAC**: Keyed hash function (RFC 2104). Used for deterministic location and content-key derivation from the anchor key.
- **k-of-n**: Threshold notation. Any `k` of `n` shares suffice to reconstruct; fewer than `k` reveal nothing.
- **Master key (`K`)**: 256 random bits. Encrypts the payload. Reconstructed at recovery from k Shamir shares.
- **MTProto**: Telegram's wire protocol. Used by `gramjs` (User API) to read/write the user's own Telegram messages without a bot.
- **OAuth**: Standard token-based auth flow used by Google / Microsoft / Dropbox / Apple for granting third-party apps scoped access.
- **OPRF**: Oblivious Pseudorandom Function. A server-side primitive that produces deterministic outputs without learning the input. *Not used* in ChromaShard v1 (explicitly excluded by no-backend requirement).
- **Payload**: The plaintext bag of typed credentials being backed up.
- **PRF**: Pseudorandom Function. WebAuthn's `prf` extension lets a passkey produce deterministic outputs for a given input.
- **Recovery string**: The single base58-encoded artifact the user holds. Contains the master ciphertext, wrapped shares, anchor binding (if any), and metadata.
- **Shamir's Secret Sharing (SSS)**: Information-theoretic threshold sharing scheme. A secret is split into n shares; any k reconstruct it; fewer than k reveal nothing.
- **Strong factor**: A factor that produces a deterministic local secret without server help. Examples: passkey-PRF, hardware sign, passphrase, TOTP seed, email inbox, social DM. Used in anchor binding.
- **Surface**: A specific `(provider, sub-service, location)` storage target. Examples: `(google, drive, /AppData/9f3e2b...)`, `(telegram, saved-messages, msg-id-12345)`.
- **t-of-m**: The anchor binding threshold. `t` strong factors are required to reconstruct the anchor key from `m` total strong factors.
- **TOTP**: Time-based one-time password (RFC 6238). The shared seed is the factor secret; the 6-digit codes are auxiliary.
- **WebAuthn**: Standard for passwordless / passkey authentication (W3C). Supports the PRF extension which ChromaShard uses for deterministic factor key derivation.
- **Wrapped share**: A Shamir share `Si` AES-GCM-encrypted under a factor key `Fi`. Stored in the recovery string.
