# DeSo derived-key delegation (chromatika)

> status: 2026-04-30: v0 shipped: Identity `/derive` window flow, AuthorizeDerivedKey tx via `/api/v0/authorize-derived-key`, owner-sign via Identity `/approve`, broadcast + verification poll, link record persisted per vault.

## TL;DR

DeSo's protocol-native answer to "let chromatika act on my account without giving it my owner key": **derived keys**. Chromatika's existing dWallet pubkey (the BC1Y... address that powers the v0 native flow) gets registered as a derived key on the owner's account. Subsequent sends + posts use the **owner's** pubkey on-chain, signed by chromatika's MPC key. The chain detects the derived signature via the SEQUENCE-tag mutation already in the v0 wire wrapping; **no new MPC plumbing**.

What ships in v0:
- **Link existing DeSo account**: Settings → DeSo → "link existing DeSo account (derived key)". Owner consents in the official Identity service window; chromatika never sees the owner's private key.
- **Sign sends + posts as the owner**: `getDeSoIdentity` returns the owner's BC1Y... when delegated; the existing `sendDeSo` / `submitDeSoPost` paths automatically use it.
- **30-day expiry** + unlimited spending limit (god-mode-with-expiry). Tighter scoping (per-action limits, GlobalDESOLimit) is v1; the wire format already supports it.
- **Local unlink**: stops chromatika from signing as the owner. On-chain authorization remains valid until the expiration block; full revoke (with `OperationType=NotValid`) is v1.
- **Verification poll**: after broadcast, chromatika polls `/api/v0/get-user-derived-keys` on a `+3s/+10s/+exp-backoff` cadence until `IsValid: true`.

## Architecture

```
src/background/chains/deso/
├── deso-derived.ts                    storage + Identity URL builders + AuthorizeDerivedKey flow + verification poll + getEffectiveDeSoSendIdentity
├── deso-derived.test.ts               16 unit cases (URL shape, storage round-trip, validators, mock-node submit + poll)
└── deso-send.ts                       getDeSoIdentity + sendDeSoNative + submitDeSoPost  ← all consume getEffectiveDeSoSendIdentity

src/background/chains/deso/
└── deso-node-client.ts                + constructAuthorizeDerivedKey + getTransactionSpendingLimitHex + getUserDerivedKeys

src/server/routers/deso.ts             + getDeSoOwnerLink / buildDeSoIdentityDeriveUrl / constructDeSoOwnerLink / submitDeSoOwnerLink / pollDeSoOwnerLinkVerification / clearDeSoOwnerLink
src/ui/components/DeSoPanel.tsx        identity row shows "linked (derived)" badge when delegated; embeds DeSoLinkSection
src/ui/components/DeSoLinkSection.tsx  multi-step Identity-window flow with postMessage listener
```

## Wire-format finding (the part the spike unlocked)

The big surprise from `DESO_DERIVED_KEY_SPIKE.md`: **chromatika's v0 send/post path already produces the correct derived-key wire form.** The chain detects derived-key signatures via the SEQUENCE-tag mutation (`0x30 + 1 + recoveryId` -> `0x31`-`0x34`) that v0 already emits. The `PublicKey` field of a derived-key-signed tx stays as the **owner's** pubkey; the chain looks up the registered derived key and verifies against it.

Practical consequence: **no changes to the signing pipeline.** All we add is:
1. Storage for the link record (`chromatika_deso_owner_link_v1_<vaultId>`).
2. URL builders for Identity `/derive` and `/approve`.
3. AuthorizeDerivedKey tx construction via `/api/v0/authorize-derived-key`.
4. Submit + verification poll.
5. `getEffectiveDeSoSendIdentity()` swaps the `senderPublicKeyBase58Check` field of construct requests to the owner's pubkey when delegation is active.

## Two-step user flow

### Step 1: Identity `/derive` window: owner consents

Side panel calls `window.open(...)` on `https://identity.deso.org/derive?...` with these query params:
- `v=2`
- `DerivedPublicKey=<chromatika's BC1Y...>`
- `TransactionSpendingLimitResponse=<JSON-encoded { IsUnlimited: true }>`
- `ExpirationDays=30` (or user's chosen value)
- `PublicKey=<owner BC1Y...>` (optional; if omitted, Identity asks owner to log in)
- `AppName=chromatika`

The owner consents in Identity's UI. Identity then calls `window.opener.postMessage(...)` back to the side panel with the payload:

```ts
{
  derivedSeedHex: string,                  // chromatika ignores
  derivedPublicKeyBase58Check: string,     // sanity-check against chromatika's dWallet
  publicKeyBase58Check: string,            // owner
  expirationBlock: number,                 // resolved block for the 30-day window
  accessSignature: string,                 // hex DER, owner-signed proof of consent
  transactionSpendingLimitHex?: string,    // sometimes echoed back
}
```

The side panel listener filters `event.origin !== 'https://identity.deso.org'`, extracts the payload, and routes the next step.

### Step 2: build + sign + submit AuthorizeDerivedKey

Backend takes (`accessSignature`, `expirationBlock`, `spendingLimitHex`) and POSTs `/api/v0/authorize-derived-key` to obtain an unsigned `TransactionHex`. Then the side panel opens a second Identity window: `https://identity.deso.org/approve?tx=<TransactionHex>`. The owner reviews + signs in Identity; Identity postMessages the signed tx hex back. Backend calls `/api/v0/submit-transaction` and persists the link record.

### Step 3: verify

Side panel polls `pollDeSoOwnerLinkVerification` on `+3s/+10s/+exp-backoff` cadence. Each poll hits `/api/v0/get-user-derived-keys` for the owner. Once the chain confirms `IsValid: true`, the link's `verifiedAtMs` is patched and the UI flips to "linked (derived) ✓".

## Effective send identity

After linking, `getDeSoIdentity()` returns:
```ts
{
  compressedPubkey: <dWallet 33-byte SECP>,    // signing key (always)
  publicKeyBase58Check: <OWNER BC1Y...>,        // EFFECTIVE on-chain identity
  derivedPubkeyBase58Check: <dWallet BC1Y...>,  // chromatika's signing key
  isDelegated: true,
  ownerPubkeyBase58Check: <OWNER>,
  expirationBlock: 312500,
}
```

The existing `sendDeSoNative` and `submitDeSoPost` flows read `identity.publicKeyBase58Check` and use it as `senderPublicKeyBase58Check` in the construct request. Sending logic is unchanged: the chain accepts the SEQUENCE-tag-mutated DER signature against the registered derived key and credits the tx to the owner.

`getDeSoBalance()` similarly returns the **owner's** balance + username (via `/api/v0/get-users-stateless`) when delegation is active. The user sees "their" account, not chromatika's empty derived-key account.

## Privacy + trust

- **Owner key never leaves Identity.** Chromatika sends `accessSignature` + `signedTransactionHex` only: both are produced by Identity, not by chromatika. No paste-the-private-key flow anywhere.
- **Spending limit honestly disclosed.** v0 ships `IsUnlimited: true` (the documented prototype shortcut). The Settings panel says "v0 = unlimited spending limit with a 30-day expiry"; v1 will add the per-action picker.
- **30-day expiry.** Hardcoded for v0. After expiry the on-chain authorization is dead; user must re-link. Stops a stolen-laptop scenario from lasting forever.
- **Local unlink ≠ on-chain revoke.** Clearing the local record stops chromatika from signing as the owner, but the on-chain authorization remains valid until the expiration block. To revoke on-chain, the user submits another AuthorizeDerivedKey tx with `OperationType=NotValid` (v1) or visits Diamond's settings page.
- **Per-vault link table.** Switching vaults switches the active link picture. A vault with no link reverts to chromatika's own dWallet identity for DeSo.

## Reuse from existing chromatika surfaces

- **`signBitcoinTxSighashPreimage`**: same ika SECP path used by EVM + BTC + DeSo v0. No new MPC plumbing.
- **`getDwalletSecpPublicKey`**: same dWallet pubkey used everywhere; here it serves as the *derived* key on the owner's account.
- **`encodeDeSoAddress`**: already mainnet/testnet aware; just adds a base58check encoding step.
- **`recordSignedTx`**: DeSo sends + posts continue to record under `kind: 'deso-send'` / `'deso-post'`. The on-chain `publicKey` field is the owner's, not chromatika's: drain analysis sees the right entity.

## What's deferred (post-v0)

| feature | scope | notes |
|---|---|---|
| Per-action spending limit picker | UI + JSON shape | wire format already accepts `TransactionCountLimitMap` / `GlobalDESOLimit` / scoped variants. Just needs the form. |
| Custom expiry windows | UI + UX copy | hardcoded 30 days today. |
| On-chain revoke | second AuthorizeDerivedKey tx with `OperationType: NotValid` | needs the same `/approve` flow on the owner side. |
| Multi-account linking | per-vault array of links instead of one | one owner per vault for v0. |
| Post-as-owner UI | thread profile + post composer | the v0 panel composer already posts as the owner when delegated; v1 adds richer composer + Diamond UX. |
| Identity `webview=true` callback URL fallback | for browser contexts where postMessage is unreliable | side-panel `window.open` works today; this is a hardening item. |
| Full ExtraData round-trip | port `TransactionV0.fromBytes` from `deso-js` | required for tipping creator coins, NFT bids; still v1+. |

## Demo flow

1. Existing DeSo user opens chromatika side panel → Settings → "deso · social chain" → "link existing DeSo account (derived key)".
2. Click "open Identity to authorize" → Identity window opens. Owner logs in (or picks an account). Identity shows the spending-limit summary: "chromatika will be able to do anything your account can do for the next 30 days." Owner clicks "Authorize".
3. ~1s later, the second Identity window opens for the AuthorizeDerivedKey tx: "Sign this transaction to register chromatika as a derived key on your account." Owner clicks "Sign".
4. Chromatika submits the tx. Side panel shows "verifying on-chain (poll 1)...". ~3-10s later, the chain confirms; UI flips to "linked to BC1YL... ✓".
5. Identity row now shows the **owner's** BC1Y... + a "linked (derived)" badge. Balance shows the owner's DESO + username.
6. Send a tiny amount of DESO from the panel: tx hash on-chain shows the owner as `PublicKey`, signed by chromatika's derived key. Diamondapp credits the owner.
7. Compose a post: same. Posts from chromatika appear under the owner's handle on the public DeSo feed.

## Verification

```bash
cd wallet-extension
pnpm test --run src/background/chains/deso/deso-derived.test.ts
pnpm run build
```

Tests cover URL builder shape, storage round-trip, input validation in `constructDeSoAuthorizeDerivedKey`, mock-node submit-and-persist, and the verification poll happy path + unverified path.

## Related

- [`DESO.md`](DESO.md): v0 chain integration (identity, balance, send, post)
- [`DESO_DERIVED_KEY_SPIKE.md`](DESO_DERIVED_KEY_SPIKE.md): wire-format research that unblocked this slice
- [`DESO_SPIKE.md`](DESO_SPIKE.md): original v0 wire-format spike
- [`STATUS.md`](STATUS.md): single-source shipped/gated/future index
