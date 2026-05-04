# DeSo Integration Spike

Status: research only. No code shipped. Goal: confirm we can add DeSo as a SECP256K1 ika dWallet base + chain by wrapping our compact `r||s` output into DeSo's "DER-with-recovery-byte-prefix-mutation" wire format.

## Findings summary (TL;DR)

**Buildable as written.** The brainstorm description is right in spirit but slightly off on layout. The recovery byte is **not a separate prefix byte**. DeSo mutates the **first byte of the DER envelope** (the `0x30` SEQUENCE tag) by adding `(1 + recoveryId)` to it - becoming `0x31`, `0x32`, `0x33`, or `0x34` for derived-key signed txns. Owner-key signed txns keep `0x30` as a normal DER signature. The "signed bytes" are `sha256(sha256(transactionBytes))` of the entire transaction hex *including* the trailing `0x00` (empty signature length placeholder). For the splice we replace that `0x00` with `<varint signatureLength><DER bytes>`.

Top 3 deltas vs the brainstorm:

1. **Signed digest is double-SHA256, not single.** Brainstorm said `sha256(transactionBytes)` - upstream `signTx` calls `sha256X2`. Both deso-js (`crypto-utils.ts:259-291`) and the C# Bouncy Castle gist confirm.
2. **Recovery byte is a header-tag mutation, not a prepended byte.** `signatureBytes[0] += 1 + recoveryParam` overwrites `0x30` in place; total bytes do not grow by 1. Only applied for derived keys; owner-key path keeps standard DER.
3. **Splice point is the trailing zero, not a tail slice.** Unsigned `TransactionHex` ends in `00` (uvarint signature length = 0). Drop those 2 hex chars, then append `<sigLenVarint><DER>`. v1 ExtraData fields, if present, sit *between* the signature and the end of the unsigned hex - the deso-js path handles them; for v0 sends (the chromatika MVP) there are no v1 fields to worry about.

## Network endpoints + auth model

- **Mainnet base URL:** `https://node.deso.org` - confirmed active. No API key required for unauthenticated endpoints (construct + submit + read). No documented rate limits for unauthenticated tx submission - the docs are silent so we should add a polite client-side cooldown anyway.
- **Testnet:** No official public testnet endpoint surfaced in current docs. The `lib/constants.go` constants ship a testnet base58 prefix (`0x11, 0xc2, 0x00`) so the protocol still supports it, but no public node URL is published. Treat DeSo as **mainnet-only** for product MVP; lab work happens against `node.deso.org` with tiny amounts.
- **Auth model:** `/api/v0/submit-transaction` is unauthenticated and accepts any well-formed signed `TransactionHex`. Identity service is **not** required (the brainstorm was right). DeSo Identity is only needed if the dapp wants OAuth-style key delegation - chromatika owns the key (via ika MPC), so we POST raw signed hex.

## Address format

From `lib/constants.go`:

| Network | Base58 prefix bytes |
|---------|-------------------|
| Mainnet | `0xcd, 0x14, 0x00` |
| Testnet | `0x11, 0xc2, 0x00` |

Wire layout: `base58check(prefix || compressed_pubkey_33B)`. Mainnet addresses begin with `BC1` characters. Total payload before base58check = 36 bytes. Base58check appends 4 bytes of `sha256(sha256(payload))[0:4]` checksum.

**Implementation plan:** chromatika derives the SECP256K1 compressed pubkey from the ika dWallet (we already do this for EVM; same curve, but we need the *compressed* form, 0x02/0x03 prefix + 32 bytes of x). Then `bs58check.encode(concat(prefix, compressedPubkey))`. The `bs58check` npm package handles the double-sha256 checksum. No new ika changes needed - dWallet `outputPublicKey` is already secp.

**Golden vector (partial):** `node.deso.org` example tx in docs starts with public key bytes `0102aa3dc8d299ea1e4914de66494ed3e16eda9a0d65719d523c1a9a03cbf9f60c45c6` - matches the 33-byte compressed format (note the leading `02` after the `01` length tag). No publicly published full privkey + signed-tx pair in upstream tests; we'll generate our own using a throwaway mainnet vault during lab integration.

## Signature wire format

```
DeSo final signature bytes (derived-key signed):

  +--------+--------+--------+--------+--------+--------+--------+
  | 0x30+x |  totL  |  0x02  |  Rlen  |   R    |  0x02  |  Slen  | ...
  +--------+--------+--------+--------+--------+--------+--------+
       ^
       |
       first byte mutated: 0x30 + 1 + recoveryId
       0x31 = recoveryId 0
       0x32 = recoveryId 1
       0x33 = recoveryId 2
       0x34 = recoveryId 3

DeSo final signature bytes (owner-key signed):
  +--------+--------+--------+--------+--------+--------+
  |  0x30  |  totL  |  0x02  |  Rlen  |   R    |  0x02  | ...
  +--------+--------+--------+--------+--------+--------+
  (standard DER, no recovery info, classic ECDSA verify only)
```

`R` and `S` are big-endian, **low-S normalized** (per BIP62 / DeSo's malleability constraint - subtract from curve order if `S > N/2`). Total length is variable (typically 70-72 bytes); the `<totL>` byte is the length of everything that follows it.

For chromatika, since we're the owner of an ika dWallet (not a derived key), we COULD use plain DER (`0x30...`) and skip the recovery byte entirely. **Recommendation:** still use the derived-key form so we're consistent with the deso-js code path and so our signed txns "look normal" to any DeSo tooling that expects the recovery prefix on non-Identity-signed txns.

## Tx construction + submit flow

### `/api/v0/send-deso` (POST)

**Request:**
```json
{
  "SenderPublicKeyBase58Check": "BC1YL...",
  "RecipientPublicKeyOrUsername": "BC1YL... or @username",
  "AmountNanos": 1000000000,
  "MinFeeRateNanosPerKB": 1000,
  "TransactionFees": []
}
```
1 DESO = 10^9 nanos. `MinFeeRateNanosPerKB` = 1000 is the standard fee floor.

**Response:**
```json
{
  "TotalInputNanos": 1234567890,
  "SpendAmountNanos": 1000000000,
  "ChangeAmountNanos": 234566890,
  "FeeNanos": 1000,
  "TransactionIDBase58Check": "...",
  "Transaction": { "TxInputs": [...], "TxOutputs": [...], "TxnMeta": {...}, "PublicKey": "...", "Signature": null, "TxnTypeJSON": 0 },
  "TransactionHex": "0161b49620...0000"
}
```

### `/api/v0/submit-transaction` (POST)

**Request:** `{ "TransactionHex": "<our signed hex>" }`

**Response:** `{ "Transaction": {...}, "TxnHashHex": "...", "PostEntryResponse": null }` (PostEntryResponse only set for submit-post txns).

### `/api/v0/submit-post` (POST, construct phase)

**Request:**
```json
{
  "UpdaterPublicKeyBase58Check": "BC1YL...",
  "BodyObj": { "Body": "hello chromatika", "ImageURLs": [], "VideoURLs": [] },
  "MinFeeRateNanosPerKB": 1000
}
```
Returns `TransactionHex` same shape as send-deso. Sign + submit through the same path.

### `/api/v0/get-users-stateless` (POST)

**Request:** `{ "PublicKeysBase58Check": ["BC1YL..."], "SkipForLeaderBoard": true }`

**Response:** `{ "UserList": [{ "PublicKeyBase58Check": "...", "BalanceNanos": 12345678 }, ...] }`. Use this for portfolio rows.

## Sign-bytes derivation

The signing flow chromatika will run:

1. Receive `TransactionHex` from `/api/v0/send-deso`. The trailing `00` byte is the empty signature length placeholder.
2. Convert hex to bytes. Compute `digest = sha256(sha256(allTxBytes))` - **including** the trailing `00`. This 32-byte digest is what we hand to ika.
3. ika MPC signs the digest. We get `r||s` (64 bytes). We try `recoveryId = 0, 1, 2, 3` and pick the one that recovers our compressed pubkey via secp256k1 `recoverPublicKey(digest, r, s, recoveryId)`.
4. Convert `r||s` to DER: `0x30 <totLen> 0x02 <rLen> <r-trimmed> 0x02 <sLen> <s-trimmed>`. Apply low-S normalization (subtract from curve order if high). The `bn.js` + `asn1.js` combo or `@noble/curves/secp256k1` `Signature.toDERRawBytes()` both produce this.
5. Mutate `derBytes[0] += 1 + recoveryId` (becomes `0x31`-`0x34`).
6. Build varint length: `signatureLength = uvarint(derBytes.length)` (a single byte for typical 70-72 byte sigs - `0x46` for 70, `0x47` for 71, `0x48` for 72).
7. Splice: drop the final `00` from the hex, append `signatureLength.toHex() + derBytes.toHex()`. For v0 transactions this is the entire splice. For v1 transactions with extra data, the deso-js path uses `TransactionV0.fromBytes` to peel off the v1 tail buffer and concat back - we mirror that if/when we support v1.
8. POST `{ TransactionHex }` to `/api/v0/submit-transaction`.

## TS reference impl pointers

- **Signing function:** `deso-protocol/deso-js`, `src/identity/crypto-utils.ts:259-291` (`signTx`). Cleanest reference; we essentially port this verbatim with `signBytesEvm` (or a new `signBytesDeSo`) replacing the `sign(...)` call.
- **DER + recovery byte mutation:** same file, the `signatureBytes[0] += 1 + recoveryParam` line is the entire trick.
- **PR introducing the format:** `deso-protocol/core` PR #380. Comments describe the layout: "<0x30 + optionally (0x01 + recoveryId)> <length of whole message> <0x02> <length of R> <R> 0x2 <length of S> <S>".
- **C# cross-reference** (Bouncy Castle gist by ankushKun): demonstrates the same flow without the recovery mutation (owner-key path). Useful as a sanity test for the DER assembly.
- **Go core verifier:** `deso-protocol/core/lib/blockchain.go` - couldn't extract the exact verify function via WebFetch (file is large), but PR #380 confirms the verifier checks both `0x30` (standard DER) and `0x31`-`0x34` (recovery-prefixed DER) paths.

## Open questions / blockers

1. **No published full golden vector** (privkey + unsigned hex + signed hex). Chromatika will generate one in a lab run before shipping the chain, then keep it as a unit test fixture in `deso-send-native.test.ts`.
2. **v1 ExtraData splice** - the deso-js code uses `TransactionV0.fromBytes()` to extract the v1 tail buffer. We need to port that parser if we support v1 fields (tipping a creator coin, NFT bids, etc). For MVP (send DESO + read balance + simple post), v0 is sufficient.
3. **Testnet** - no public testnet node. Either run our own (DeSo core ships in Go and is `go run`-able) or test on mainnet with dust amounts. Lean toward mainnet dust for the spike.
4. **MinFeeRateNanosPerKB drift** - DeSo can raise this via param updaters. Use `DefaultFeeRateNanosPerKB` from `/api/v0/get-users-stateless` response if available; fallback `1000`.
5. **Public key encoding for the request body** - `SenderPublicKeyBase58Check` uses the 36-byte (3-prefix + 33-pubkey) base58check form, NOT a raw hex pubkey. Re-confirm at integration time by submitting a get-users-stateless query with our derived address and checking the response.

## Plan deltas vs the chromatika brainstorm

- **Add DeSo to ika `BaseChain` discussion:** SECP256K1 ECDSA - the same curve as EVM. ika SECP128 dWallet works. No new MPC primitives needed. `assertNotSolanaBaseForSecpSigning` guard remains; DeSo is a Sui-base SECP path same as EVM.
- **Adapter naming:** new `desoIkaAdapter` is overkill. DeSo lives at the chain layer (`src/background/chains/deso.ts`, `deso-send.ts`), reusing `signBytesEvm`'s underlying `signBytesEcdsa` primitive (rename if needed). The DeSo-specific work is purely the wire wrapping (DER + recovery byte + splice) and the address derivation (compressed pubkey + base58check).
- **Storage:** add `chromatika_deso_node_v1` for user-overridable node URL (default `https://node.deso.org`). Reuse the existing network registry pattern.
- **UI:** DeSo address column on the portfolio table. Send flow uses `/api/v0/send-deso` (construct) then ika sign + splice + `/api/v0/submit-transaction`. Activity reads from `/api/v0/get-transaction-by-id-base58check` or similar (TBD - separate spike for activity).
- **No HD path complexity** - DeSo doesn't have a SLIP44 number assigned in mainstream registries (last we checked). For an ika dWallet user this is a non-issue: the dWallet pubkey *is* the identity, no HD tree below it.
- **Risk:** DeSo's signature format is custom enough that any third-party tooling expecting standard DER will reject our signed hex. This only matters if we want to integrate with non-DeSo tooling - which we don't, since we hit the official node directly.
- **Effort estimate:** 2-3 days. Half a day for the address derivation + base58check, half a day for DER assembly + recovery byte mutation, a day for the splice + submit + integration tests, half a day for portfolio UI hookup.
