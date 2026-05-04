# DeSo Derived Key Delegation Spike

Status: research only. Goal: confirm we can let an existing DeSo user authorize chromatika's dWallet pubkey as a **derived key** so chromatika sends + posts on their behalf without ever holding the owner key.

## Findings TL;DR

**Buildable** for v0 with one important shortcut: chromatika should not roll its own AccessSignature path. The DeSo Identity service `/derive` flow returns a fully formed `accessSignature` after the owner consents, plus the matching `derivedSeedHex`. Chromatika ignores the seed (it has its own dWallet) and only consumes `accessSignature + expirationBlock + transactionSpendingLimitHex`, then submits the actual `AuthorizeDerivedKey` tx itself with the owner's signature obtained via the same Identity `/approve` flow. The richer model only matters once we want to skip Identity entirely (post-v0).

Top wire-format gotchas (worth surfacing now):

1. **AccessSignature signs `sha256X2(DerivedPublicKey || ExpirationBlock_BE_uint64 || TransactionSpendingLimitBytes)`** — *not* `sha256(DerivedPublicKey || ExpirationBlock)`. The pre-`DerivedKeySetSpendingLimitsBlockHeight` shorter form is gone in mainnet today. Source: `_verifyAccessSignature` in `core/lib/block_view_derived_key.go` and the `accessBytes = [...derivedPub, ...uint64BE(expBlock), ...spendingLimitBytes]` pattern in `deso-js/src/identity/derived-key-utils.ts`.
2. **Spending-limit serialization is server-side.** Don't try to port the Go encoder. Use `POST /api/v0/get-transaction-spending-limit-hex-string` with the JSON `TransactionSpendingLimitResponseOptions` and read back `{ HexString }`. Same hex goes into the AuthorizeDerivedKey tx, *and* the same bytes (after hex-decode) are what AccessSignature hashes over. Both sides agree because both got the bytes from the same node.
3. **Derived-key signed txs are detected by ExtraData, not the `PublicKey` field.** When chromatika later sends DESO via the derived key, the tx's `PublicKey` stays as the **owner's** pubkey; the derived-key signature is the only signal, and it's identified by the `0x31`-`0x34` SEQUENCE-tag mutation we already implemented for v0 sends. The chain calls `IsDerivedSignature()` on the sig bytes, looks up `(owner_pub, derived_pub)` in the derived-key index, and verifies. Conclusion: chromatika needs *no new tx-building plumbing* for derived-key sends — the existing `deso-signature.ts` SEQUENCE-tag mutation path already produces the right wire form. The derived-key registration is the only new tx type.

## 1. AuthorizeDerivedKey transaction structure

`TxnTypeAuthorizeDerivedKey = 22` (per `core/lib/network.go`).

`AuthorizeDerivedKeyMetadata` fields (Go core):

| field | type | purpose |
|---|---|---|
| `DerivedPublicKey` | `[]byte` (33B compressed SECP) | the key being granted access |
| `ExpirationBlock` | `uint64` | block height after which the grant is invalid |
| `OperationType` | `uint8` (`AuthorizeDerivedKeyOperationValid = 1`, `…NotValid = 0`) | grant vs. revoke |
| `AccessSignature` | `[]byte` (DER, **standard `0x30` tag** — *no* recovery mutation) | proof the owner consented to this exact `(derivedPub, expBlock, spendingLimit)` triple |

`TransactionSpendingLimit` rides in `ExtraData["TransactionSpendingLimit"]` as raw bytes (the same hex that came back from `get-transaction-spending-limit-hex-string`). `Memo` and `AppName`, when set, also live in `ExtraData`. These are v1 ExtraData entries — chromatika's v0 wire wrapper currently doesn't handle ExtraData on outbound construction, but for AuthorizeDerivedKey we don't construct ourselves: we let `POST /api/v0/authorize-derived-key` build the unsigned `TransactionHex`, sign the owner side, splice, broadcast.

### `POST /api/v0/authorize-derived-key`

Request:

```json
{
  "OwnerPublicKeyBase58Check": "BC1YL...",
  "DerivedPublicKeyBase58Check": "BC1YL...",
  "ExpirationBlock": 312500,
  "AccessSignature": "30440220...",
  "DeleteKey": false,
  "DerivedKeySignature": false,
  "TransactionSpendingLimitHex": "80d0dbc3f4...",
  "Memo": "chromatika delegation",
  "AppName": "chromatika",
  "MinFeeRateNanosPerKB": 1000,
  "TransactionFees": [],
  "ExtraData": {}
}
```

Response: standard `{ TransactionHex, Transaction, FeeNanos, ... }`. The `Transaction.TxnMeta` carries `DerivedPublicKey` / `ExpirationBlock` / `AccessSignature` / `OperationType`. The `Signature` field of the outer tx is `null` until we splice the owner's signature.

## 2. AccessSignature semantics

The bytes the **owner** signs (verified inside the chain by `_verifyAccessSignature`):

```
accessBytes = DerivedPublicKey (33B compressed)
           || ExpirationBlock  (8B big-endian uint64)
           || TransactionSpendingLimitBytes (variable; same bytes as TransactionSpendingLimitHex)

digest = sha256(sha256(accessBytes))   // double-SHA256, "sha256X2" in deso-js

AccessSignature = ECDSA-sign(digest, ownerPrivKey)  // standard DER, no recovery mutation
```

Chain accepts both Encoding 1.0 (raw concat above) and Encoding 2.0 (a Metamask-friendly human-readable string of the same data). Either passes; chromatika should always emit Encoding 1.0 because that's what `deso-js` uses and what the Identity `/derive` flow returns.

DER format: standard `0x30 <totLen> 0x02 <Rlen> <R> 0x02 <Slen> <S>`, **low-S normalized**. **No** SEQUENCE-tag mutation here — that's only for the *outer* tx signature on derived-key-signed transactions, not for AccessSignature.

PR introducing the post-spending-limit form: `deso-protocol/core` PR introducing `DerivedKeySetSpendingLimitsBlockHeight`. The pre-fork shorter form (no spending-limit bytes in the digest) is dead on current mainnet.

## 3. TransactionSpendingLimit

`TransactionSpendingLimitResponseOptions` (deso-js TypeScript shape, mirrors the Go server-side struct field-for-field):

```ts
{
  GlobalDESOLimit?: number,                              // total nanos the derived key may spend
  TransactionCountLimitMap?: Partial<Record<TxnType, number | 'UNLIMITED'>>,
  CreatorCoinOperationLimitMap?: { [creatorPK: string]: { [op: CCOp]: number | 'UNLIMITED' } },
  DAOCoinOperationLimitMap?: { [creatorPK: string]: { [op: DAOOp]: number | 'UNLIMITED' } },
  NFTOperationLimitMap?: { [postHashHex: string]: { [serial: number]: { [op: NFTOp]: number | 'UNLIMITED' } } },
  DAOCoinLimitOrderLimitMap?: { ... },
  AssociationLimitMap?: AssociationLimitMapItem[],
  AccessGroupLimitMap?: AccessGroupLimitMapItem[],
  AccessGroupMemberLimitMap?: AccessGroupMemberLimitMapItem[],
  StakeLimitMap?: StakeLimitMapItem[],
  UnstakeLimitMap?: UnstakeLimitMapItem[],
  UnlockStakeLimitMap?: UnlockStakeLimitMapItem[],
  LockupLimitMap?: LockupLimitMapItem[],
  IsUnlimited?: boolean,                                 // god-mode shortcut
}
```

`TxnType` keys are the string names of the `TxnType` enum from `core/lib/network.go`. The full list (current mainnet, ID column for cross-reference):

```
BasicTransfer (2), BitcoinExchange (3), PrivateMessage (4), SubmitPost (5),
UpdateProfile (6), UpdateBitcoinUSDExchangeRate (8), Follow (9), Like (10),
CreatorCoin (11), SwapIdentity (12), UpdateGlobalParams (13), CreatorCoinTransfer (14),
CreateNFT (15), UpdateNFT (16), AcceptNFTBid (17), NFTBid (18),
NFTTransfer (19), AcceptNFTTransfer (20), BurnNFT (21), AuthorizeDerivedKey (22),
MessagingGroup (23), DAOCoin (24), DAOCoinTransfer (25), DAOCoinLimitOrder (26),
CreateUserAssociation (27), DeleteUserAssociation (28), CreatePostAssociation (29),
DeletePostAssociation (30), AccessGroup (31), AccessGroupMembers (32), NewMessage (33),
RegisterAsValidator (34), UnregisterAsValidator (35), Stake (36), Unstake (37),
UnlockStake (38), UnjailValidator (39), CoinLockup (40), UpdateCoinLockupParams (41),
CoinLockupTransfer (42), CoinUnlock (43), AtomicTxnsWrapper (44)
```

(So the brainstorm's "coming soon!" placeholder in DeSo docs is real — they don't enumerate them in the published page; the source list above comes straight from `network.go`.)

### Simplest v0: `IsUnlimited: true`

```json
{ "IsUnlimited": true }
```

This is the documented "god-mode" shortcut for prototyping. For chromatika v0 we ship this exact object, so the user sees: "chromatika will be able to do anything your account can do, until block X." Tighter scoping (e.g. only `BasicTransfer` + `SubmitPost`) ships in v1 alongside per-action UI.

A scoped v1 example:

```json
{
  "GlobalDESOLimit": 100000000,
  "TransactionCountLimitMap": {
    "BasicTransfer": 10,
    "SubmitPost": 50
  }
}
```

### Server-side serialization

`POST /api/v0/get-transaction-spending-limit-hex-string`

```json
{ "TransactionSpendingLimit": { "IsUnlimited": true } }
```

Response: `{ "HexString": "80d0dbc3f4..." }`. Reverse direction is `GET /api/v0/get-transaction-spending-limit-response-from-hex/{hex}`. Both round-trip cleanly.

## 4. Derived-key-signed transaction encoding

When chromatika later submits a `BasicTransfer` or `SubmitPost` signed by the derived key:

- **`PublicKey` field** stays as the **owner's** pubkey. The chain looks up the owner, then matches the signature to a registered derived key.
- **`Signature` field** is the derived key's ECDSA, in the same DER-with-SEQUENCE-tag-mutation wire format we already produce in `chains/deso/deso-signature.ts` (`0x31`-`0x34` for recoveryId 0-3). The `_verifyBytesSignature` flow recovers the pubkey, sees it's not the owner, and checks the derived-key index.
- **No new `ExtraData` is needed** on the outbound side. Some integrations stamp `ExtraData["DerivedPublicKey"]` for clarity but the chain doesn't require it.

`signTx` reference: `deso-js/src/identity/crypto-utils.ts:259-291` — the `if (options?.isDerivedKey) { signatureBytes[0] += 1 + recoveryParam }` line is the only diff vs an owner-signed tx, and that's already what chromatika v0 emits. We are byte-for-byte parity already.

**Conclusion: tier-4 v1 needs no change to the existing `deso-send-native.ts` signing path.** The only new code is the AuthorizeDerivedKey registration tx and the verification poll.

## 5. Owner-key sign-out flow

Chromatika doesn't have the owner key. Three paths in priority order:

### Path A (recommended for v0): DeSo Identity `/derive` window flow

`window.open('https://identity.deso.org/derive?…')` with query params:

| param | value |
|---|---|
| `callback` | `chrome-extension://<id>/deso-derive-callback.html` (or postMessage if same-origin iframe — extension-side we use the popup window form) |
| `TransactionSpendingLimit` | `encodeURIComponent(JSON.stringify({ IsUnlimited: true }))` |
| `PublicKey` | owner's `BC1Y…` (optional; if omitted, Identity asks user to log in first) |
| `DerivedPublicKey` | chromatika's dWallet `BC1Y…` (if omitted, Identity generates a fresh one — we want to *force* our dWallet pubkey) |
| `testnet` | `false` |

Identity prompts the owner to consent, then either postMessages back (window flow) or redirects to the callback URL with payload as query params (callback flow). Payload:

```ts
{
  derivedSeedHex: string,                  // chromatika ignores
  derivedPublicKeyBase58Check: string,     // == chromatika's dWallet, sanity-check
  publicKeyBase58Check: string,            // owner
  expirationBlock: number,
  accessSignature: string,                 // hex DER — chromatika's prize
  transactionSpendingLimitHex?: string,    // sometimes echoed back
  jwt: string,
  derivedJwt: string,
}
```

Once chromatika has `accessSignature + expirationBlock + transactionSpendingLimitHex`, it:
1. POSTs `/api/v0/authorize-derived-key` to get the unsigned `TransactionHex`.
2. Sends the user back to **`https://identity.deso.org/approve?tx=<TransactionHex>`** to obtain the owner-signed hex.
3. Receives `signedTransactionHex` via the same postMessage / callback channel.
4. Submits via `/api/v0/submit-transaction`.
5. Polls `/api/v0/get-user-derived-keys` for `IsValid: true`.

This is the standard pattern every DeSo-native dapp uses, and it never asks chromatika to handle the owner's key material — exactly the trust model we want. **One caveat**: extension popups don't get a real `window.opener`, so we use the **callback URL** form (`?callback=chrome-extension://...`) instead of postMessage. Same outcome.

### Path B: manual paste

Show the unsigned `TransactionHex` and a textarea. User signs it externally (CLI, Diamond's tx-signing UI, another wallet that supports raw DeSo tx signing) and pastes the signed hex back. Robust fallback for users who don't trust the Identity service. Add a "did you double-check the AccessSignature payload?" disclaimer.

### Path C: Diamond deeplink

`https://diamondapp.com/derive?...` — Diamond exposes a deep-link to its own derived-key flow that proxies to Identity. Documented but flow-equivalent to Path A; offer as a friendly button labeled "open in Diamond" alongside Identity.

There is **no** public `/api/v0/sign-tx` HTTP endpoint that signs on the user's behalf — DeSo deliberately keeps owner-key signing in browser-side Identity.

## 6. Lookup + verification

After broadcast, poll:

`POST /api/v0/get-user-derived-keys`

```json
{ "PublicKeyBase58Check": "<owner BC1Y…>" }
```

Response (per docs):

```json
{
  "DerivedKeys": {
    "<derivedBC1Y>": {
      "OwnerPublicKeyBase58Check": "BC1Y…",
      "DerivedPublicKeyBase58Check": "BC1Y…",
      "ExpirationBlock": 312500,
      "IsValid": true
    }
  }
}
```

(`TransactionSpendingLimit` and `Memo` are *not* returned per the published shape; chromatika persists them locally at registration time and trusts the on-chain copy. Validate by simulating a small `BasicTransfer` if needed.)

Cadence: poll once at +3s, then +10s, then exponential backoff up to 60s. Mainnet block time is ~2-3s (Proof-of-Stake era), so a typical confirmation lands inside one poll.

## 7. Reference TS SDK pointers

- `deso-protocol/deso-js` `src/identity/identity.ts` — `derive()` method opens the Identity window, returns `IdentityDerivePayload` with `accessSignature`. **Mirror byte-for-byte** for chromatika's `desoIdentityDerive()`.
- `deso-protocol/deso-js` `src/identity/derived-key-utils.ts` — `accessBytes = [...derivedPub, ...uint64BE(expBlock), ...spendingLimitBytes]; sha256X2(accessBytes)`. The exact digest formula. Useful if we ever go off-Identity (the user runs their own DeSo CLI to sign). Not needed for the v0 ship.
- `deso-protocol/deso-js` `src/identity/crypto-utils.ts:259-291` — `signTx` already covered in v0 spike; the `signatureBytes[0] += 1 + recoveryParam` mutation is shared between owner-signed and derived-key-signed; chromatika's `chains/deso/deso-signature.ts` is byte-for-byte parity.

We do **not** add `@deso-protocol/deso-js` as a dep. The SDK pulls in `bs58check`, `@noble/curves`, hash libs we already have. We port the ~80 lines of Identity URL building + payload validation we actually need into `chains/deso/deso-derived.ts`.

## 8. Plan deltas vs the brainstorm

1. **"Richer than EIP-7702" framing is right but the simplest demo is `IsUnlimited: true`.** v0 ships god-mode-with-expiry; per-action scoping (`{ TransactionCountLimitMap: { SubmitPost: 50 } }`) is v1.5. Don't gate the chromatika ship on building the scoping UI; the wire format already supports it via the Identity `/derive` query-string.
2. **Don't roll AccessSignature ourselves.** The brainstorm framed it as "we'll need to build the proof-of-consent signing" — but the Identity `/derive` flow returns `accessSignature` pre-signed. Owner never types into chromatika. ~5 days of work removed from the estimate.
3. **No new outbound tx wire-wrapping.** Existing `deso-signature.ts` SEQUENCE-tag mutation already produces derived-key-form sigs. Tier-4 v1 effort is mostly Identity-window plumbing + a single new tx-builder route + verification poll. Realistic scope is **~3-4 days** for one engineer, not the brainstorm's 2 weeks. The longer estimate baked in the v0 chain integration that's already shipped.
