# Solana transaction signing via ika MPC

Solana versioned transactions signed via ika MPC ED25519 EDDSA. dapp-originated `solana_signTransaction` and wallet-UI `sendSolanaNative` both end up here. on Sui ika base, signing produces real distributed MPC signatures; on Solana ika base (pre-alpha), signatures come from a single mock signer.

## the flow

```ts
async function signSolanaTx(versionedTx: VersionedTransaction) {
  // 1. extract the signable message bytes
  const messageBytes = versionedTx.message.serialize();
  // this is the v0 message (header + accounts + recent_blockhash + instructions)
  // NOT the full tx (which would include signature slots)

  // 2. take a presign
  const presignId = takePresign('ED25519_EDDSA');

  // 3. sign via ika - PASS RAW MESSAGE BYTES (ika sha-512s internally per RFC 8032)
  const sigBytes = await ikaSign({
    dwalletId: activeEd25519DwalletId,
    curve: Curve.ED25519,
    algorithm: SignatureAlgorithm.EdDSA,
    message: messageBytes,
    presignId,
  });

  // 4. parse 64-byte ed25519 sig
  const { R, S } = parseSignatureFromSignOutput(sigBytes, Curve.ED25519, SignatureAlgorithm.EdDSA);
  const sig64 = new Uint8Array([...R, ...S]);

  // 5. assign signature to the tx's signature slot
  versionedTx.signatures[0] = sig64;

  // 6. tx is now ready to broadcast
  return versionedTx;
}
```

## what gets signed

the **serialized v0 message** (`versionedTx.message.serialize()`), not the whole tx. v0 message layout (per Solana):

```
[message_header (3 bytes)]
   numRequiredSignatures (u8)
   numReadonlySignedAccounts (u8)
   numReadonlyUnsignedAccounts (u8)
[static_account_keys (compact array of 32-byte pubkeys)]
[recent_blockhash (32 bytes)]
[instructions (compact array of CompiledInstruction)]
[address_table_lookups (compact array of MessageAddressTableLookup)]
```

signers verify by:
```
ed25519_verify(message_bytes, signature, signer_pubkey)
// internally: sha-512(message_bytes), then verify on the curve
```

ika's ED25519 EdDSA signs raw bytes (sha-512s internally). hand it the message bytes; the signature works.

## broadcasting

```ts
async function sendSolanaTx(tx: VersionedTransaction) {
  const signed = await signSolanaTx(tx);
  const connection = new Connection(SOLANA_RPC_URL);
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'processed',
  });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}
```

`sendRawTransaction` returns the tx signature (which is the same 64-byte ed25519 sig in base58 form). `confirmTransaction` waits for the network to confirm at the requested commitment level.

## sendSolanaNative path

```ts
async function sendSolanaNative({ to, amountSol }) {
  const lamports = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
  const from = new PublicKey(await getSolanaAddress());
  const toPk = new PublicKey(to);

  const connection = new Connection(SOLANA_RPC_URL);
  const { blockhash } = await connection.getLatestBlockhash('finalized');

  const message = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: toPk,
        lamports: Number(lamports),
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  return sendSolanaTx(tx);
}
```

native SOL sends are exactly one SystemProgram.transfer instruction. SPL token sends would use spl-token's `createTransferInstruction` (see [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) for an example with USDC).

## dapp `solana_signTransaction` path

when a dapp asks for `solana_signTransaction` via the dapp bridge, chromatika:
1. enqueues the tx as a pending sign request
2. opens a sign-approval popup
3. on approve, runs `signSolanaTx`
4. returns the signed tx (or just the signature) to the dapp via the bridge

a sibling MCP tool (`sendSolanaTx` for agents) is **tracked future** - today MCP exposes only EVM `sendEvmTx` / `signTransaction` plus a chain-agnostic `signMessage`.

## SOL on Sui ika base vs Solana ika base

- **Sui ika base** + ED25519 dWallet: real ika 2PC-MPC ED25519 signing. neither chromatika nor the ika network alone can sign. production-grade
- **Solana ika base** + ED25519 dWallet: pre-alpha. **single mock signer**, not real distributed MPC. the disclaimer in CLAUDE.md is unambiguous: "never trust Solana-base signatures for real value"

both paths produce the same byte-shape ed25519 signature, but the trust model differs. don't confuse them.

## blockhash freshness

Solana txs include a recent_blockhash; the network rejects txs whose blockhash is older than ~150 blocks (~60 seconds). chromatika fetches the blockhash inside the build flow, right before signing. if the user takes >60s reading the popup, the blockhash may expire - on submit, the user gets "blockhash not found" and re-signs with a fresh blockhash.

## library

- `@solana/web3.js` `Connection`, `VersionedTransaction`, `TransactionMessage`, `SystemProgram`
- `@solana/spl-token` for SPL transfers
- internal: `wallet-extension/src/background/chains/signing/solana.ts`

## related

- [ed25519-eddsa.md](/library/tech/ed25519-eddsa) - underlying signature algorithm
- [signature-normalization.md](/library/tech/signature-normalization) - parseSignatureFromSignOutput details
- [x402-solana-tx-build.md](/library/tech/x402-solana-tx-build) - SPL transfer construction example
