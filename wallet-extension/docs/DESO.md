# DeSo (chromatika)

> status: 2026-04-30 — v0 shipped: identity, balance, native send, text post, **derived-key delegation** (link existing DeSo account so chromatika acts on the owner's behalf without holding the owner key). **DeSo mainnet only** (no public testnet node). Diamonds, NFTs, and DeSo Messages are future work; this slice + the derived-key delegation slice unblock the social-chain story without committing to encryption / messaging surface area.

## TL;DR

DeSo = secp256k1 + custom binary tx wire format + a public node API. Chromatika's existing **SECP dWallet** directly produces a valid DeSo identity — same ika MPC pipeline that already signs EVM transactions, just with `DoubleSHA256` instead of `Keccak256` and a different output wrapper.

What ships in v0:
- **Identity** — `getDeSoIdentity()` returns `{ publicKeyBase58Check, compressedPubkeyHex }`. Address starts with `BC1Y…`.
- **Balance + username** — `getDeSoBalance()` hits `/api/v0/get-users-stateless` on the configured node.
- **Native send** — `sendDeSo({ recipient, amountDeso })` — recipient is either `BC1Y…` base58check or a `@username`. Returns the on-chain `TxnHashHex`.
- **Text post** — `submitDeSoPost({ body })` — the lowest-friction social demo. Returns the post tx hash.
- **Settings panel** — Settings → "deso · social chain". Identity readout, balance refresh, send form, post composer, Diamond app deeplink, optional node URL override (advanced).

## Architecture

```
src/background/chains/deso/
├── deso-constants.ts            address prefix bytes, default node URL, API endpoint paths
├── deso-base58check.ts          hand-rolled base58check (no dep on `bs58check`)
├── deso-address.ts              compressed-pubkey ↔ BC1Y… address + isDeSoAddress()
├── deso-signature.ts            DER assembly + recovery-byte SEQUENCE-tag mutation + splice
├── deso-node-client.ts          thin fetch() wrapper for /api/v0/* endpoints
├── deso-send.ts                 high-level flows: getDeSoIdentity / getDeSoBalance / sendDeSoNative / submitDeSoPost
├── deso-address.test.ts         address derivation tests (round-trip, prefix, parity)
└── deso-signature.test.ts       DER + recovery-byte + low-S + recoveryId loop, golden cases

src/server/routers/deso.ts       tRPC: getDeSoIdentity / getDeSoBalance / sendDeSo / submitDeSoPost / get+set node URL
src/ui/components/DeSoPanel.tsx  Settings panel UI
```

## Wire format (the part that's easy to get wrong)

DeSo's signature layout is a custom variant of DER. From the spike:

```
DeSo final signature bytes (derived-key signed):

  +--------+--------+--------+--------+--------+--------+--------+
  | 0x30+x |  totL  |  0x02  |  Rlen  |   R    |  0x02  |  Slen  | …
  +--------+--------+--------+--------+--------+--------+--------+
       ↑
       first byte mutated: 0x30 + 1 + recoveryId
       0x31 = recoveryId 0
       0x32 = recoveryId 1
       0x33 = recoveryId 2
       0x34 = recoveryId 3
```

Total length unchanged from standard DER. Recovery-byte is encoded *into* the SEQUENCE tag, not prepended. R/S are **low-S normalized** per BIP62.

The signed bytes are `sha256(sha256(transactionBytes))` — **including** the trailing `0x00` byte (the empty signature length placeholder). Chromatika reuses the existing `signBitcoinTxSighashPreimage` ika SECP path because Bitcoin uses the same `DoubleSHA256` scheme.

The splice: drop the trailing `00` from the unsigned hex, append `<varint sigLen><DER bytes>` (`<sigLen>` is a single byte for the typical 70-72 byte sigs).

Full wire-format spec + reference impl pointers: [`DESO_SPIKE.md`](DESO_SPIKE.md).

## Network endpoints

| field | value |
|---|---|
| Default node | `https://node.deso.org` (override per install via Settings → DeSo → node URL) |
| Address prefix (mainnet) | `0xcd, 0x14, 0x00` |
| Address prefix (testnet) | `0x11, 0xc2, 0x00` (no public testnet node currently published) |
| 1 DESO = 10⁹ nanos | min fee floor = `1000` nanos/KB |

Endpoints used:
- `POST /api/v0/send-deso` — construct unsigned send tx
- `POST /api/v0/submit-post` — construct unsigned post tx
- `POST /api/v0/submit-transaction` — broadcast signed tx
- `POST /api/v0/get-users-stateless` — fetch balance + profile

## Reuse from existing chromatika surfaces

- **`getDwalletSecpPublicKey()`** ([`chains/bitcoin.ts`](../src/background/chains/bitcoin.ts)) — returns the compressed 33-byte SECP pubkey from the active dWallet. Identical primitive used by BTC + EVM. No new key material.
- **`signBitcoinTxSighashPreimage(preimage)`** ([`chains/signing/btc.ts`](../src/background/chains/signing/btc.ts)) — ika SECP signing with `Hash.DoubleSHA256`. Returns `{ signature: hex }` (compact `r||s`). Pass DeSo's full unsigned tx bytes (with trailing `00`) as the preimage.
- **`recordSignedTx`** ([`services/tx-record.ts`](../src/background/services/tx-record.ts)) — DeSo sends + posts persist into `chromatika_signed_txs_v1` with `kind: 'deso-send'` or `'deso-post'`. Drain analysis + future safety surfaces benefit; the activity feed will pick them up once a DeSo activity source ships (future).
- **No new MPC plumbing.** SECP256K1 is already provisioned. `assertNotSolanaBaseForSecpSigning` still applies — DeSo is a Sui-base SECP path same as EVM.

## Privacy + trust model

- **Public chain.** Every send + post is fully visible on the DeSo public ledger. There's no FHE-style hiding. The "social" framing is the value, not privacy.
- **Mainnet money.** v0 hits `https://node.deso.org` and burns real DESO for fees. Send small (~0.0001 DESO covers a typical send). The Settings panel surfaces this with an honesty pill.
- **No Identity service.** Chromatika POSTs raw signed hex directly to `/api/v0/submit-transaction`. DeSo's Identity OAuth/iframe is for dapps that need OAuth-style key delegation — chromatika owns the key via ika MPC, no delegation needed.
- **No HD path collision.** DeSo doesn't have a SLIP44 number; the dWallet pubkey IS the identity. One dWallet → one DeSo address.

## What's deferred (post-v0)

| feature | scope | notes |
|---|---|---|
| Diamonds | `/api/v0/send-diamonds` | tip a post — natural follow-up |
| Creator coins | `/api/v0/buy-or-sell-creator-coin` | liquidity-bonded social tokens |
| NFTs | `/api/v0/create-nft` + `/api/v0/update-nft` + bid/buy | larger UX surface |
| ✅ Derived keys | `/api/v0/authorize-derived-key` + `TransactionSpendingLimit` | shipped 2026-04-30 — see [`DESO_DERIVED_KEY.md`](DESO_DERIVED_KEY.md). v0 = unlimited spending limit + 30-day expiry; per-action scoping is v1. |
| **DeSo Messages** | secp256k1 ECDH + AES-GCM, Access Groups V3 | E2E-encrypted on-chain DMs. Implementable in the SW without the Identity iframe. **The cross-chain plays from tier 5 of the rescue/safety brainstorm depend on this.** |
| Activity feed source | new `getDeSoActivity(address)` reading `/api/v0/get-transaction-info` | add to `services/activity.ts` merge |
| `window.deso` dapp shim | content-script injection + dapp-bridge handler | enables DeSo-native dapps |
| v1 ExtraData splice | port `TransactionV0.fromBytes` from deso-js | needed for tipping creator coins, NFT bids — not needed for v0 send + post |

## Tier 5 cross-chain plays unlocked by DeSo (from the rescue/safety brainstorm)

These all chain on top of v0:

1. **Cross-chain tip-and-shout-out** — send ETH/BTC/SUI tip → auto-broadcast a DeSo `SUBMIT_POST` with explorer link + `ExtraData.TipChain` / `ExtraData.PayeePubkey`. One social-graph entry per cross-chain action.
2. **DeSo as 3rd anchor for safety alerts** — the broadcast alerts surface (already shipped, tier 2) currently uses an HTTP-polled signed feed. Adding DeSo as a third anchor (sui object + solana memo + DeSo post) means non-chromatika users see the alerts via your follower graph. Marketing surface.
3. **Diamond-as-receipt for x402** — when an x402 USDC payment settles, Diamond the recipient's most recent post. Free public proof-of-payment for merchants.
4. **Decentralized phishing list mirror on DeSo** — chromatika diffs the eth-phishing-detect list daily and mirrors diffs to `SUBMIT_POST` with `ExtraData.PhishingDelta`. Any wallet can subscribe = chromatika contributes to ecosystem health.
5. **Creator-coin-gated dapp permissions** — dapp scopes `TransactionSpendingLimit` to "only allow if wallet holds ≥10 of @brand creator coin" using DeSo balance reads. Fan-token-gated dapps with no new schema.

All of these are post-v0 and bundled per item.

## Demo flow

1. Chromatika side panel → Settings → "deso · social chain"
2. Show the BC1Y… identity. Note: "this is your existing SECP dWallet, no new key material."
3. Click "diamondapp" → opens https://diamondapp.com/u/<address> in a new tab. The address is recognized; the user has no profile yet, that's fine.
4. Click "refresh" → balance loads (likely 0 DESO; fund with a tiny amount via DeSo's faucet or buy).
5. Once funded, send a tiny amount (0.0001 DESO) to a known recipient or back to yourself via `@username`.
6. Compose a post: "hello chromatika · ${date}". Click publish. ~5s later, the post is live on DeSo, viewable on diamondapp.com. Click the txn hash → DeSo block explorer.
7. Talking point: "your existing dWallet just gained a social presence. zero new key material, zero new SDK weight. mainnet, real social graph, real audit trail."

## Risks + caveats

- **DeSo's signature format is custom.** Any third-party tooling that expects standard DER will reject our signed hex. This only matters if we want to integrate with non-DeSo tooling (we don't — we hit the official node directly).
- **Mainnet only.** No public testnet means dev iteration burns small amounts of real DESO.
- **No published full golden vector.** Chromatika's tests use a synthesized vector via `@noble/secp256k1`. Once an integration test lands against the live node, we keep that as a regression fixture.
- **v1 ExtraData not supported.** Sends + posts are v0; tipping creator coins / NFT bids need the `TransactionV0.fromBytes` parser ported from deso-js. Documented as deferred.

## Related

- [`DESO_SPIKE.md`](DESO_SPIKE.md) — full wire-format spec + upstream reference URLs
- [`STATUS.md`](STATUS.md) — single-source shipped/gated/future index
