# seed vault parity

how the seeker app guarantees the same dWallet identities as the chrome extension without ever sharing a vault blob.

## the chain of equalities

```
seed vault wallet S        (same user's seeker, anywhere)
   │
   │ S.sign("ika.chromatika.user-share-encryption-key.v1")
   ▼
ed25519 signature σ        (RFC 8032 deterministic → same wallet, same message, same bytes)
   │
   │ keccak256(σ || u32_le(0))
   ▼
32-byte seed K             (no randomness, no time component)
   │
   │ UserShareEncryptionKeys.fromRootSeedKey(K, curve)
   ▼
ika encryption key E       (curve-byte-tagged per @ika.xyz/sdk ≥ 0.4.0)
   │
   │ protocol DKG anchored on E
   ▼
dWallet id D               (sui object id OR solana PDA, both deterministic from E.pubkey)
```

every arrow is a pure function with no side-effects on the trust model. the seeker app and the chrome extension hold the same E and therefore see the same D for the same curve.

## why this works even though the apps don't talk to each other

- the JS extension already derives K via [`hd.ts:131`](../../wallet-extension/src/background/keyring/hd.ts:131) `ikaRootSeedFromMwaSignature` when the user pairs the seeker as a remote hardware signer over the reflector.
- the seeker app's [`IkaSeedDerivation.kt`](../app/src/main/java/xyz/chromatika/seeker/identity/IkaSeedDerivation.kt) ports the same constant + same keccak preimage + same index encoding. byte-for-byte identical preimage → byte-for-byte identical seed.
- both call into the same `@ika.xyz/sdk` (sui base) or `@ika.xyz/pre-alpha-solana-client` (solana base, pre-alpha mock signer) downstream. same SDK + same seed + same curve → same encryption key.

## what could break the chain

| break | mitigation |
|---|---|
| extension bumps the domain string ("v1" → "v2") | [`IkaSeedDerivationTest.kt`](../app/src/test/java/xyz/chromatika/seeker/identity/IkaSeedDerivationTest.kt) `ika usk domain matches extension constant byte for byte` fails. CI blocks the merge. |
| anyone "simplifies" the kotlin keccak preimage (drops index byte, swaps endian, etc.) | parity tests fail: `changes with encryption key index` and the fee-payer non-collision assertion. |
| `@ika.xyz/sdk` changes curve-byte tagging | `CLAUDE.md` "ika `UserShareEncryptionKeys` root seed" note tracks this. on a major bump, retest the chain end-to-end with a known dWallet fixture before shipping. |
| seed vault on a future android version becomes non-deterministic (non-RFC-8032) | this would be a solana mobile spec break. extremely unlikely; document the contract assumption in the README. |

## non-goals

- migrating extension vault blobs onto the seeker. the extension stores an argon2id-encrypted multi-vault blob in chrome.storage; the seeker app's vault store is independent. **identity** is shared via the derivation chain above; **encrypted state** (passkey blobs, lazor link rows, dapp permissions, etc.) is per-app.
- syncing dapp connection state across surfaces. dapp permissions on the seeker do not propagate to the extension or vice-versa. each surface negotiates its own MWA / EIP-1193 session.
- sharing the in-extension solana fee-payer balance with the seeker app. fee-payer keypairs ARE derived from the same wallet signature at `IKA_FEE_PAYER_DERIVATION_INDEX`, so they share an address — meaning the balance is literally the same SOL pool on-chain, but each app sees it independently via their own RPC reads. this is a feature, not a bug.
