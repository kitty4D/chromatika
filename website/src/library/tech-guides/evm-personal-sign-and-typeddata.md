# EVM personal_sign + signTypedData_v4

`personal_sign` and `eth_signTypedData_v4` are the two EVM message-signing primitives chromatika supports. both produce 65-byte secp256k1 signatures (`r||s||v`). the **rule**: hand ika the **preimage bytes**, not the keccak digest. ika keccak256s once internally per RFC; pre-hashing breaks v-recovery.

## personal_sign (EIP-191)

EIP-191 specifies the format:

```
preimage = "\x19Ethereum Signed Message:\n" + len(message) + message
digest = keccak256(preimage)
signature = ecdsa_sign(digest, key)
```

the `\x19` prefix and `Ethereum Signed Message:\n` marker domain-separate this from raw transaction signatures - a preimage that starts with `\x19...` cannot accidentally collide with a valid RLP-encoded transaction (RLP uses different starting bytes). this prevents "you signed what you thought was a login challenge but it was actually a $1M tx" attacks.

### chromatika's personal_sign path

```ts
async function signEvm({ message, chainId }) {
  // 1. wrap per EIP-191
  const messageBytes =
    typeof message === "string" ? new TextEncoder().encode(message) : ethers.getBytes(message);
  const prefix = `\x19Ethereum Signed Message:\n${messageBytes.length}`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const preimage = new Uint8Array(prefixBytes.length + messageBytes.length);
  preimage.set(prefixBytes, 0);
  preimage.set(messageBytes, prefixBytes.length);

  // 2. take a presign
  const presignId = takePresign("SECP256K1_ECDSA");

  // 3. sign via ika - PASS THE PREIMAGE
  const sigBytes = await ikaSign({
    dwalletId: activeSecpDwalletId,
    curve: Curve.SECP256K1,
    algorithm: SignatureAlgorithm.ECDSASecp256k1,
    message: preimage, // RAW PREIMAGE
    presignId,
  });

  // 4. parse + recover v
  const { r, s } = parseSignatureFromSignOutput(
    sigBytes,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1
  );
  const digest = ethers.keccak256(preimage);
  const dwalletAddress = await getEvmAddress();

  let v: 27 | 28 = 27;
  if (
    ethers.recoverAddress(digest, { r, s, v: 27 }).toLowerCase() !== dwalletAddress.toLowerCase()
  ) {
    v = 28;
  }

  // 5. assemble 65-byte signature
  return { signature: ethers.concat([r, s, ethers.getBytes(`0x${v.toString(16)}`)]) };
}
```

## signTypedData_v4 (EIP-712)

EIP-712 is structured-data signing: instead of arbitrary bytes, the user signs a typed object (e.g. `{ name: "Permit", domain: ..., message: { holder, spender, value } }`). the rule is:

```
preimage = 0x1901 || domainSeparator || hashStruct(message)
digest = keccak256(preimage)
signature = ecdsa_sign(digest, key)
```

`0x1901` is the EIP-712 prefix (analog to EIP-191's `\x19`). `domainSeparator` and `hashStruct(message)` are each 32-byte keccak hashes of the typed-data domain and message respectively, computed via the recursive `encodeData` rules in EIP-712.

### the critical preimage method

ethers v6 exposes both:

- `TypedDataEncoder.encode(domain, types, value)` - returns the **preimage** (`0x1901 || domainSep || msgHash`)
- `TypedDataEncoder.hash(domain, types, value)` - returns the **digest** (keccak256 of the preimage)

chromatika **must** call `encode` (preimage), not `hash` (digest). passing `hash` to ika causes ika to keccak256 the digest, signing over the wrong digest, and v-recovery fails.

### chromatika's typed-data path

```ts
async function signTypedDataV4({ domain, types, value, chainId }) {
  // 1. compute the preimage (NOT the digest)
  const preimage = ethers.TypedDataEncoder.encode(domain, types, value);
  // preimage is hex string; convert to bytes
  const preimageBytes = ethers.getBytes(preimage);

  // 2. take a presign
  const presignId = takePresign("SECP256K1_ECDSA");

  // 3. sign via ika - PASS THE PREIMAGE
  const sigBytes = await ikaSign({
    dwalletId: activeSecpDwalletId,
    curve: Curve.SECP256K1,
    algorithm: SignatureAlgorithm.ECDSASecp256k1,
    message: preimageBytes,
    presignId,
  });

  // 4. parse + recover v
  const { r, s } = parseSignatureFromSignOutput(
    sigBytes,
    Curve.SECP256K1,
    SignatureAlgorithm.ECDSASecp256k1
  );
  const digest = ethers.keccak256(preimageBytes);
  const dwalletAddress = await getEvmAddress();

  let v: 27 | 28 = 27;
  if (
    ethers.recoverAddress(digest, { r, s, v: 27 }).toLowerCase() !== dwalletAddress.toLowerCase()
  ) {
    v = 28;
  }

  return { signature: ethers.concat([r, s, ethers.getBytes(`0x${v.toString(16)}`)]) };
}
```

## the rule, summarized

| operation          | what to pass to ika                               | what NOT to pass                       |
| ------------------ | ------------------------------------------------- | -------------------------------------- |
| transaction send   | `tx.unsignedSerialized` (RLP-encoded unsigned tx) | the keccak digest of the tx            |
| `personal_sign`    | the EIP-191 wrapped bytes                         | the keccak digest of the wrapped bytes |
| `signTypedData_v4` | `TypedDataEncoder.encode(...)`                    | `TypedDataEncoder.hash(...)`           |

ika hashes once with KECCAK256 internally for SECP256K1_ECDSA. ALWAYS pass the **preimage bytes**.

## what double-hashing looks like

if you accidentally pre-hash:

```ts
const digest = ethers.keccak256(preimage);
const sig = await ikaSign({ message: digest, ... });   // BAD - ika hashes the digest
const recovered = ethers.recoverAddress(ethers.keccak256(preimage), sig);   // recovered != expected
```

ika has now signed `keccak256(digest) = keccak256(keccak256(preimage))`. when verifiers compute `keccak256(preimage)` and try to recover, they get a different address. the v-recovery loop tries 27 and 28 and neither matches.

if you ever see "signature does not recover to expected address" errors, suspect a double-hash bug first.

## chain id in the v byte (legacy chains only)

EIP-155 introduced chain-aware tx signing where `v = 35 + chainId * 2 + (0 or 1)`. for typed transactions (type 2 EIP-1559), `chainId` is a separate field and `v` is just the parity bit (0 or 1, written as 27 or 28 by ethers). chromatika defaults to type 2, so the v-recovery is straightforward.

`personal_sign` does NOT incorporate chain id - it's the same signature regardless of which network the user thinks they're on. that's a feature (off-chain signing for any network) and a footgun (replay across networks if a dapp doesn't include chain id in its message).

## library

- `ethers` v6 `TypedDataEncoder`, `keccak256`, `recoverAddress`, `getBytes`, `concat`
- internal: `wallet-extension/src/background/chains/signing/evm.ts` `signEvm`, `signTypedDataV4`
- internal: `wallet-extension/src/background/ika/signing.ts`

## related

- [evm-send-flow.md](/library/tech/evm-send-flow) - the transaction send path
- [ecdsa-secp256k1.md](/library/tech/ecdsa-secp256k1) - underlying signature math
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput details
