# Aptos signing

Aptos transactions and messages signed via ika MPC ED25519 EDDSA. less surface than Sui because Aptos didn't have a hardware wallet first-mover advantage in the chromatika feature set, but the basic primitives are there: address derivation, message signing, transaction signing.

## the address

Aptos addresses are 32 bytes. derived from the public key:

```
auth_key = SHA-3-256(pubkey || 0x00)   // 0x00 scheme byte for single-key Ed25519
address = auth_key   // 32 bytes
```

note: SHA-3-256 (NIST FIPS 202), **not** keccak256 (which has different padding). same length output, different bytes.

`getAptosAddress` returns the EIP-55-style hex-encoded address (with leading `0x`).

multi-key (multi-sig, multi-curve) layouts use a different scheme byte and different `auth_key` derivation, but chromatika only deals with single-key Ed25519 today.

## message signing

```ts
async function signAptosMessage({ messageB64 }) {
  const messageBytes = base64Decode(messageB64);
  const presignId = takePresign("ED25519_EDDSA");

  const sigBytes = await ikaSign({
    dwalletId: activeEd25519DwalletId,
    curve: Curve.ED25519,
    algorithm: SignatureAlgorithm.EdDSA,
    message: messageBytes, // raw bytes, ika sha-512s
    presignId,
  });

  const { R, S } = parseSignatureFromSignOutput(sigBytes, Curve.ED25519, SignatureAlgorithm.EdDSA);
  return { signature: bytesToHex(new Uint8Array([...R, ...S])) };
}
```

raw 64-byte ed25519 signature output. dapps verify with standard ed25519_verify against the dWallet's pubkey.

note: there's no Aptos-specific "intent prefix" the way Sui has - Aptos messages are signed raw. dapps that want domain separation include their own prefix in the message bytes.

## transaction signing

Aptos transactions use the @aptos-labs/ts-sdk:

```ts
async function signAptosTx(rawTransaction: RawTransaction) {
  // 1. SDK serializes to BCS bytes
  const txBytes = rawTransaction.bcsToBytes();

  // 2. wrap with Aptos signing-message prefix (per Aptos spec)
  // signingMessage = sha3-256("APTOS::RawTransaction") || bcs(rawTx)
  const tag = sha3_256(new TextEncoder().encode("APTOS::RawTransaction"));
  const signingMessage = new Uint8Array(tag.length + txBytes.length);
  signingMessage.set(tag, 0);
  signingMessage.set(txBytes, tag.length);

  // 3. sign via ika
  const presignId = takePresign("ED25519_EDDSA");
  const sigBytes = await ikaSign({
    dwalletId: activeEd25519DwalletId,
    curve: Curve.ED25519,
    algorithm: SignatureAlgorithm.EdDSA,
    message: signingMessage, // include the tag prefix
    presignId,
  });

  const { R, S } = parseSignatureFromSignOutput(sigBytes, Curve.ED25519, SignatureAlgorithm.EdDSA);
  const sig64 = new Uint8Array([...R, ...S]);

  // 4. wrap as Aptos AccountAuthenticatorEd25519
  const auth = new AccountAuthenticatorEd25519(
    new Ed25519PublicKey(getDwalletEd25519PublicKey()),
    new Ed25519Signature(sig64)
  );

  // 5. submit via SDK
  return aptos.transaction.submit.simple({
    transaction: rawTransaction,
    senderAuthenticator: auth,
  });
}
```

key Aptos-specific bit: the **signing-message tag** (`sha3-256("APTOS::RawTransaction")`) prefixes the raw bytes before signing. this is Aptos's analog of Sui's `[0x00, 0x00, 0x00]` intent prefix - domain separation so a tx can't be replayed as a different signed object.

## hardware wallets

Aptos signing on Ledger / Trezor:

- Ledger: `@ledgerhq/hw-app-aptos` (if it exists - Aptos Ledger app is community-maintained; check current support)
- Trezor: not supported in `@trezor/connect-web` today

if hardware support is needed, route via the hardware-sign popup using the device's signing primitive. chromatika's main path is dWallet-via-ika.

## activity

Aptos activity reads via the Aptos Indexer (`https://api.[mainnet|testnet].aptoslabs.com/v1`). standard REST GET; no SDK fancier than `@aptos-labs/ts-sdk`'s `Aptos.transactions.list...`.

## NFTs

`getAptosNfts({ address })` reads via the Aptos token-v2 indexer. no API key required (Aptos provides a public-tier indexer for NFT metadata).

## library

- `@aptos-labs/ts-sdk` `Aptos`, `RawTransaction`, `AccountAuthenticatorEd25519`, `Ed25519PublicKey`, `Ed25519Signature`
- `@noble/hashes/sha3` `sha3_256` for the signing-message tag
- internal: `wallet-extension/src/background/chains/aptos.ts`

## related

- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - signature algorithm
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput
