# x402 Solana tx build (`x402-solana-build.ts`)

both x402 signing paths (ika MPC and WalletConnect) share the same Solana versioned transaction construction. given x402 `PaymentRequirements`, build a tx that transfers USDC + writes a Memo v2 instruction with the nonce. the tx is then signed by either path.

## what the tx contains

```
versioned tx (Message v0)
├─ recent_blockhash (fetched from Solana RPC)
├─ fee_payer = signer (the user's dWallet's Solana address, or WC-paired phone's address)
└─ instructions:
   ├─ [createAssociatedTokenAccountIdempotent]  // only if destination ATA doesn't exist
   ├─ [splToken.transfer]                        // USDC transfer
   └─ [memoV2]                                   // memo containing nonce + optional caller memo
```

## the full build flow

```ts
async function buildX402SolanaTx({
  requirements, // PaymentRequirements decoded from payment-required header
  callerHint, // { url, method }
  signerAddress, // base58 of the signer (dWallet or WC account)
}): Promise<{
  message: Uint8Array; // serialized v0 message bytes (what gets signed)
  versionedTx: VersionedTransaction;
}> {
  const connection = new Connection(SOLANA_RPC_URL);
  const signer = new PublicKey(signerAddress);
  const usdcMint = new PublicKey(USDC_MINT);
  const amount = BigInt(requirements.amount); // USDC base units (6 decimals)
  const destination = new PublicKey(requirements.payTo);

  // 1. derive sender ATA
  const senderAta = getAssociatedTokenAddressSync(usdcMint, signer, false);

  // 2. derive destination ATA
  const destAta = requirements.destinationAta
    ? new PublicKey(requirements.destinationAta)
    : getAssociatedTokenAddressSync(usdcMint, destination, false);

  // 3. check whether dest ATA exists; if not, prepend create-idempotent instruction
  const destAtaInfo = await connection.getAccountInfo(destAta);
  const instructions = [];

  if (!destAtaInfo) {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer, // payer (signer pays the rent)
        destAta, // ata to create
        destination, // owner of the ata
        usdcMint
      )
    );
  }

  // 4. SPL token transfer
  instructions.push(
    createTransferInstruction(
      senderAta,
      destAta,
      signer,
      Number(amount) // u64 - chromatika's amounts fit; cast is safe
    )
  );

  // 5. memo v2 with nonce + optional caller memo
  const memoText = JSON.stringify({
    nonce: requirements.nonce,
    memo: requirements.memo ?? "",
    callerHint: callerHint.url,
  });
  instructions.push(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID_V2, // MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr
      data: Buffer.from(memoText, "utf-8"),
    })
  );

  // 6. fetch recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

  // 7. compile to v0 message
  const messageV0 = new TransactionMessage({
    payerKey: signer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const versionedTx = new VersionedTransaction(messageV0);
  const messageBytes = messageV0.serialize();

  return { message: messageBytes, versionedTx };
}
```

## what gets signed

the **serialized v0 message bytes** (`messageV0.serialize()`) is what the signer signs. NOT the full tx; just the message portion (header + account keys + recent blockhash + instructions). after signing, the signature is written into the `versionedTx.signatures[0]` slot.

```ts
versionedTx.signatures[0] = ed25519Signature; // 64 bytes
const serializedSigned = versionedTx.serialize(); // full signed tx bytes
const paymentSignatureHeader = base64(
  JSON.stringify({
    scheme: "exact",
    chain: "solana",
    transaction: base64(serializedSigned),
    signature: base64(ed25519Signature),
    signer: signerAddress,
    nonce: requirements.nonce,
  })
);
```

## why use ATAs

USDC on Solana lives in **associated token accounts** - one ATA per (mint, owner) pair. transferring USDC means transferring **between ATAs**, not between wallet addresses directly. you have to:

- know your sender ATA (deterministic via PDA derivation: `getAssociatedTokenAddressSync(mint, owner)`)
- know the destination ATA (either provided in `requirements.destinationAta` or derive from `requirements.payTo`)
- if destination ATA doesn't exist, create it (the sender pays the small rent)

`createAssociatedTokenAccountIdempotentInstruction` is the safe version - if the ATA already exists, it's a no-op. if it doesn't, it's created. this avoids race conditions where two clients try to create the same ATA simultaneously.

## the memo v2 program

Memo v2 (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`) is a Solana program whose only purpose is to put text on-chain in a tx. it's the canonical way to attach metadata to a payment.

x402 `exact` SVM scheme uses Memo v2 to record the **nonce** (replay protection) and any caller-supplied memo. the server (or its facilitator) reads the memo to verify nonce uniqueness before settling.

memo content is JSON-encoded for forward compatibility - if we want to add fields (e.g. caller pubkey, ttl), we can without breaking parsers that only read `nonce` + `memo`.

## the blockhash freshness rule

Solana txs include a recent blockhash; the network rejects txs whose blockhash is more than 150 blocks (~60 seconds) old. so:

- chromatika fetches the blockhash inside the build flow, **right before** signing
- the signed tx must be submitted within ~60s or it expires
- x402 servers settle synchronously after receiving `payment-signature`, so this window is comfortable

if signing takes longer than 60s (e.g. user reads the popup carefully + slow MPC), the tx may expire. the user retries; chromatika fetches a fresh blockhash and rebuilds.

## the WC vs ika MPC fork

both signers receive the same `messageBytes`. they differ in **how** the signature is produced:

```ts
// ika MPC path (default)
async function x402SolanaIkaSign(messageBytes, ...) {
  const { signature } = await signMessageSol(messageBytes);   // ika ED25519_EDDSA
  // signature is 64 bytes ed25519
  return assembleHeader(messageBytes, signature, dwalletAddress);
}

// WalletConnect path (when session.solanaWcAccount is set)
async function x402WalletConnectSign(messageBytes, ...) {
  const signature = await enqueueHardwareSign({
    vendor: 'walletconnect',
    kind: 'solanaTx',
    txBytes: serializedTx,   // WC signs the full tx, not just the message
  });
  return assembleHeader(messageBytes, signature, wcAccountAddress);
}
```

ika MPC: chromatika holds half the share, ika network the other; collaboratively produce the ed25519 sig. the dWallet's Solana address is the signer.

WalletConnect: a phone wallet (Seeker / Phantom / Solflare) signs in its own Seed Vault. the ed25519 key never leaves the phone. the WC-paired account address is the signer.

both produce the same byte-shape signature; the server doesn't know which path was used.

## library

- `@solana/web3.js` `Connection`, `PublicKey`, `TransactionMessage`, `VersionedTransaction`
- `@solana/spl-token` `getAssociatedTokenAddressSync`, `createTransferInstruction`, `createAssociatedTokenAccountIdempotentInstruction`
- internal: `wallet-extension/src/background/x402/x402-solana-build.ts`

## related

- [x402-spec-svm-exact.md](/library/tech/x402-spec-svm-exact) - what `PaymentRequirements` looks like
- [x402-fetch-interception.md](/library/tech/x402-fetch-interception) - the page-side fetch wrapper that triggers this
- [x402-caps-receipts.md](/library/tech/x402-caps-receipts) - the spending controls that gate this
