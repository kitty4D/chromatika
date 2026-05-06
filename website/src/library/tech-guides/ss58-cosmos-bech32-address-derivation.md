# SS58 + Cosmos bech32 address derivation

three address encoding shapes chromatika ships for non-EVM scan probes:

1. **Cosmos-SDK bech32**: `bech32(hrp, ripemd160(sha256(secp256k1_compressed_pubkey)))` — Cosmos Hub (`cosmos1...`), Osmosis (`osmo1...`), Juno (`juno1...`), and any other SDK chain that follows the standard derivation
2. **Polkadot SS58**: `base58(prefix_bytes || ed25519_pubkey || blake2b_checksum[0..2])` — Polkadot (`1...`), Kusama (`F...`), generic Substrate (`5...`)
3. **DeSo base58check**: `base58check(prefix(3) || secp256k1_compressed_pubkey)` — covered separately in [`DESO_DERIVED_KEY.md`](../../wallet-extension/docs/DESO_DERIVED_KEY.md), included here for context

shared trait: all three derive from a public key chromatika already has on hand for HD candidates (`secp256k1CompressedHex` from the EVM derivation path, or `polkadotEd25519PubkeyHex` from the substrate derivation path). zero new keypair material per chain.

## cosmos-sdk bech32

### the math

```
1. start with 33-byte SEC1 compressed secp256k1 pubkey
2. sha256(pubkey) -> 32 bytes
3. ripemd160(...) -> 20 bytes (the "address payload")
4. bech32.encode(hrp, bech32.toWords(20-byte payload)) -> "cosmos1..." / "osmo1..." / etc.
```

**no witness version byte** — that's BTC's segwit thing. Cosmos addresses encode the 20-byte hash directly into bech32 words.

### implementation: `chains/cosmos/cosmos-address.ts`

```ts
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { bech32 } from "@scure/base";

export function encodeCosmosAddress(compressed: Uint8Array, hrp: string): string {
  // assert 33 bytes + valid SEC1 prefix (0x02/0x03)
  assertCompressedPubkey(compressed);
  if (!hrp) throw new Error("encodeCosmosAddress requires an HRP");
  const hash20 = ripemd160(sha256(compressed));
  return bech32.encode(hrp, bech32.toWords(hash20));
}
```

reuses `@noble/hashes` (sha2, legacy/ripemd160) and `@scure/base` (bech32) already in chromatika's BTC module — zero new deps.

`decodeCosmosAddress(address, expectedHrp)` is the inverse: parses bech32, asserts HRP match, returns the 20-byte hash. used for validation, not for chromatika address resolution (chromatika owns the compressed pubkey, not the hash).

### per-chain HRP catalog

each Cosmos-SDK chain ships its own HRP. chromatika's `SUPER_PRO_COSMOS` registry today:

| chain      | hrp      | native denom | decimals | symbol |
| ---------- | -------- | ------------ | -------- | ------ |
| Cosmos Hub | `cosmos` | `uatom`      | 6        | ATOM   |
| Osmosis    | `osmo`   | `uosmo`      | 6        | OSMO   |
| Juno       | `juno`   | `ujuno`      | 6        | JUNO   |
| Stargaze   | `stars`  | `ustars`     | 6        | STARS  |
| Akash      | `akash`  | `uakt`       | 6        | AKT    |
| Stride     | `stride` | `ustrd`      | 6        | STRD   |
| Sei        | `sei`    | `usei`       | 6        | SEI    |

adding more chains (Celestia / dYdX / Kava / Injective / Neutron / Sommelier) is a one-line append. the probe is HRP-driven; nothing per-chain in `scan-probes.ts`.

### tests

`cosmos-address.test.ts` — 6 cases:

- bech32 round-trip (encode → decode = original 20-byte hash)
- HRP-driven uniqueness (`cosmos1...` ≠ `osmo1...` ≠ `juno1...` for the same key)
- wrong-length pubkey throws
- invalid SEC1 prefix throws
- empty HRP throws
- `isCosmosAddress` predicate behavior

## polkadot SS58

### the math

```
1. start with 32-byte ed25519 (or sr25519) pubkey
2. encode the network prefix as 1 or 2 bytes:
   - prefix 0..63: 1 byte = prefix
   - prefix 64..16383: 2 bytes (weighted format)
     hi = (prefix >> 8) & 0xFF
     lo = (prefix & 0xFF) | 0x40
     out[0] = 0x40 | hi | ((prefix & 0xFF) >> 2)
     out[1] = lo
3. payload = prefix_bytes || pubkey32
4. checksum = blake2b("SS58PRE" || payload, dkLen=64)[0..2]
5. base58_encode(payload || checksum)
```

note: SS58 uses a **2-byte** checksum (truncated blake2b), not BTC's 4-byte sha256(sha256(...)) — different from base58check.

### implementation: `chains/polkadot/polkadot-address.ts`

```ts
import { blake2b } from "@noble/hashes/blake2.js";
import { encodeBase58, decodeBase58 } from "@/background/chains/deso/deso-base58check";

const SS58PRE = new Uint8Array([0x53, 0x53, 0x35, 0x38, 0x50, 0x52, 0x45]); // "SS58PRE"

export const SS58_NETWORKS = {
  polkadot: { label: "Polkadot", prefix: 0 },
  kusama: { label: "Kusama", prefix: 2 },
  substrate: { label: "Substrate", prefix: 42 },
};

export function encodeSs58Address(pubkey32: Uint8Array, network: Ss58Network): string {
  if (pubkey32.length !== 32) throw new Error("expects a 32-byte pubkey");
  const prefixBytes = encodePrefix(network.prefix);
  const payload = new Uint8Array(prefixBytes.length + 32);
  payload.set(prefixBytes, 0);
  payload.set(pubkey32, prefixBytes.length);
  const hashInput = new Uint8Array(SS58PRE.length + payload.length);
  hashInput.set(SS58PRE, 0);
  hashInput.set(payload, SS58PRE.length);
  const checksum = blake2b(hashInput, { dkLen: 64 }).subarray(0, 2);
  const out = new Uint8Array(payload.length + 2);
  out.set(payload, 0);
  out.set(checksum, payload.length);
  return encodeBase58(out);
}
```

reuses chromatika's existing base58 implementation in `chains/deso/deso-base58check.ts` (DeSo also uses the Bitcoin alphabet) and `blake2b` from `@noble/hashes` — zero new deps.

### important caveat: ed25519 vs sr25519

chromatika derives ed25519 + slip-10 at the substrate-standard path `m/44'/354'/N'/0'/0'`. polkadot.js / Talisman / Nova default to **sr25519** with substrate's native (non-slip10) derivation. addresses produced by chromatika from the same phrase will NOT match what those wallets show.

practical consequence: chromatika's polkadot scan probe finds activity at chromatika-derived addresses only. for users who created their polkadot account in polkadot.js / Talisman, the scan returns zero hits. surfaced in:

- inline comment in `scan-types.ts` on the `polkadotEd25519PubkeyHex` field
- comment block on `SUPER_PRO_POLKADOT` in `scan-chains.ts`
- the user-facing [multi-vault-siblings.md](/library/user/multi-vault-siblings) doc

a future slice could add sr25519 + substrate-native derivation when polkadot.js compatibility becomes a real ask. tracked as far-future deferred.

### prefix encoding edge case

the 1-byte vs 2-byte prefix split matters because SS58 supports up to 16383 networks. chromatika ships only Polkadot (0) and Kusama (2), both 1-byte. but the encoder handles both shapes for forward-compat.

decoder detects the shape from the leading byte:

- `lead < 64`: 1-byte prefix
- `(lead & 0xC0) === 0x40`: 2-byte prefix
- else: invalid

decoding reconstructs `prefix = (hi << 8) | lo` with the bit-twiddling inverse of encode.

### tests

`polkadot-address.test.ts` — 11 cases:

- valid `1...` polkadot mainnet shape (prefix 0, ~46-48 chars)
- encode → decode round-trip yields original pubkey + prefix
- different network prefixes → different addresses for same key
- wrong-length pubkey throws
- out-of-range network prefix throws
- bad checksum throws on decode
- short address throws on decode
- `isSs58Address` predicate (with optional expected-prefix check)

## DeSo base58check (cross-reference)

DeSo is documented separately in [`DESO_DERIVED_KEY.md`](../../wallet-extension/docs/DESO_DERIVED_KEY.md). short version:

```ts
encodeDeSoAddress(compressedPubkey, network): base58check(networkPrefix(3) || compressedPubkey(33))
```

unlike the cosmos / SS58 paths, DeSo doesn't hash the pubkey — the address contains the full 33-byte pubkey + a 4-byte sha256(sha256(...)) checksum. result starts with `BC1Y...` (mainnet) or `tBC1...` (testnet).

dwallet-bound vaults (passkey / seeker / waap / lazor) get DeSo addresses derived from the dwallet's `public_output` via `chainAddressesForDwalletId` — that path emits `evm` + `btcP2wpkh` + `btcP2tr` + `deso` + `desoTestnet` from the same SECP256K1 compressed pubkey.

## why these three live in chromatika today

each is enabled by a public key chromatika ALREADY has:

- HD: secp256k1 from the EVM derivation path (used for EVM + BTC + DeSo + Cosmos)
- HD: ed25519 from the substrate derivation path (used for SS58)
- dwallet-bound: secp256k1 / ed25519 from the dwallet's `public_output` (used by `chainAddressesForDwalletId`)

no new KDF, no new keypair material, no new bundle weight beyond a few bytes of address-encoding code per chain. that's why these specific shapes shipped first.

## why TON didn't ship in this batch

TON addresses derive from sha256 of a TVM stateInit cell (`workchain || hash(stateInit)`), where the cell includes the wallet contract code (varies per wallet version: v3R1, v3R2, v4R1, v4R2, w5) plus the pubkey + subwallet ID. computing this needs either:

1. `@ton/core` + `@ton/crypto` (~200kb minified, full TVM cell encoder + BoC serializer)
2. hand-rolling cell hash math against a pinned wallet contract version

neither pays back today's expected user count. the registry shape (`kind: 'ton'` variant + a `makeTonProbe`) follows the same pattern as Cosmos / Polkadot — bounded ~200 lines once the address derivation is settled. revisit when a real user request lands.

## related guides

- [`scan-service-architecture.md`](/library/tech/scan-service-architecture) — how these address encoders plug into the scan probe pipeline
- [`bip44-slip10-derivation.md`](/library/tech/bip44-slip10-derivation) — how chromatika derives the underlying secp256k1 / ed25519 keypairs from the user's mnemonic
- [`DESO_DERIVED_KEY.md`](../../wallet-extension/docs/DESO_DERIVED_KEY.md) — DeSo base58check details + dwallet-output → address derivation
