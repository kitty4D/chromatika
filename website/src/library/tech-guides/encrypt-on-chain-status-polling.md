# Encrypt on-chain status polling (4s pill)

after writing an encrypted label, chromatika polls Solana every 4 seconds to read the **status byte** of each chunk's on-chain ciphertext account. the UI surfaces a status pill: `verified` ✓ / `encrypting` / `missing`. this lets the user know whether the label landed on chain (devnet wipe → `missing`; executor still committing → `encrypting`; happy path → `verified`).

## the on-chain layout

per Encrypt's account layout:

```
Encrypt ciphertext account = 100 bytes total
[... 98 bytes of executor-internal data ...] [fheType (1 byte)] [statusByte (1 byte)]
                                              offset 98          offset 99
```

the last byte is the **status byte**; the second-to-last is the `fheType` echo. the rest is opaque executor state.

## status byte values

```
0 = pending  (executor still committing; ciphertext written but not yet verifiable)
1 = verified (ciphertext is on-chain and reading is allowed)
null (account missing) = devnet wipe (or never written)
```

other values are reserved for future states. chromatika treats anything outside `{0, 1, null}` as "unknown" (display falls back to `pending`).

## the per-chunk poll

```ts
async function getChunkStatus(connection, identifierHex, programId): Promise<ChunkStatus> {
  const id = hexToBytes(identifierHex);
  // identifier is the on-chain account public key; just use it directly
  const accountPk = new PublicKey(id);
  const accountInfo = await connection.getAccountInfo(accountPk);

  if (!accountInfo) {
    return { accountExists: false, statusByte: null, fheType: null };
  }
  if (accountInfo.data.length < 100) {
    return { accountExists: true, statusByte: null, fheType: null };   // unexpected layout
  }
  return {
    accountExists: true,
    statusByte: accountInfo.data[99],
    fheType: accountInfo.data[98],
  };
}
```

just one Solana `getAccountInfo` call per chunk. accounts that don't exist → `accountExists: false`. accounts that exist but have unexpected layout → `statusByte: null` (defensive).

## the multi-chunk aggregation

```ts
async function getDwalletEncryptedLabelOnChainStatus({ curve }): Promise<{
  status: 'verified' | 'pending' | 'missing' | 'no-label',
  chunks: Array<{
    ciphertextIdentifierHex: string,
    accountExists: boolean,
    statusByte: number | null,
    fheType: number | null,
  }>,
}> {
  const meta = readDwalletMeta(activeVaultId, curve);
  if (!meta?.encryptedLabel) return { status: 'no-label', chunks: [] };

  const connection = new Connection(SOLANA_RPC_URL);
  const programId = new PublicKey(meta.encryptedLabel.programId);

  const chunks = await Promise.all(
    meta.encryptedLabel.ciphertextIdentifierHexes.map(idHex =>
      getChunkStatus(connection, idHex, programId)
    )
  );

  // aggregation:
  // - any chunk missing → overall 'missing'
  // - any chunk pending → overall 'pending'
  // - all chunks verified → overall 'verified'
  if (chunks.some(c => !c.accountExists)) return { status: 'missing', chunks };
  if (chunks.some(c => c.statusByte === 0)) return { status: 'pending', chunks };
  if (chunks.every(c => c.statusByte === 1)) return { status: 'verified', chunks };
  return { status: 'pending', chunks };   // catch-all
}
```

aggregation rules:
- **any** chunk missing → label is `missing` overall (devnet wipe scenario)
- **any** chunk pending → label is `encrypting` overall (executor still committing)
- **all** chunks verified → label is `verified` ✓

## the polling loop

UI uses `setInterval` with 4-second cadence:

```tsx
// in DwalletEncryptedLabel.tsx
useEffect(() => {
  if (!status?.hasLabel || !status.enabledForSession) return;

  const id = window.setInterval(() => {
    void trpc.getDwalletLabelOnChainStatus
      .query({ curve })
      .then(setOnChainStatus)
      .catch(() => {
        // silent fail - keep showing previous state
      });
  }, 4000);

  return () => window.clearInterval(id);
}, [curve, status?.hasLabel, status?.enabledForSession]);
```

silent error handling: if the RPC call fails (network blip, RPC down), keep showing the last known state rather than flipping to `missing` or `pending` based on a transient failure.

## why 4 seconds

executor commit latency is typically <1 second on devnet but can spike to several seconds under load. polling every 4 seconds:
- catches the `pending → verified` transition within ~4 seconds of completion (acceptable UX)
- doesn't hammer the RPC (one call per chunk per 4 seconds × N chunks × M dWallets)
- gives the executor breathing room before the next poll

faster polling (1 second) would be more responsive but uses more RPC budget. slower (10 seconds) would feel laggy. 4 seconds is the chosen middle.

## the polling lifecycle

```
1. user creates a label → encrypt flow runs → ciphertextIdentifierHexes persisted → UI shows 'encrypting'
2. polling alarm fires every 4s
3. each poll:
   - aggregate status across all chunks
   - if it changed since last poll, update UI state
4. user sees pill flip from 'encrypting' to 'verified' typically within 4-12 seconds
5. polling continues as long as the component is mounted and label exists
6. unmount → cleanup → polling stops
```

## the devnet wipe scenario

solana ika devnet gets **wiped periodically** (per CLAUDE.md disclaimer: "the Solana program and all on-chain data will be wiped periodically"). after a wipe:
- chromatika's local `record.dwalletMeta.encryptedLabel.ciphertextIdentifierHexes` still points at on-chain accounts
- those accounts no longer exist (they were wiped)
- polling returns `accountExists: false` for each chunk
- aggregated status becomes `missing`
- UI shows the alert pill: "missing on-chain"
- the reveal button auto-disables (you can't read a missing ciphertext)
- user must `clearDwalletLabel` (drops the local pointer) and re-encrypt

automated rebuild on first reveal failure (regenerate ciphertext from cached plaintext) is **tracked future**. today the user does it manually, since chromatika doesn't cache the original plaintext label after encryption.

## the no-label case

if the user has never encrypted a label for this dWallet:
- `record.dwalletMeta.encryptedLabel` is undefined
- `status: 'no-label'`, `chunks: []`
- UI shows no pill (just the encrypt button)

## library

- `@solana/web3.js` `Connection`, `PublicKey`, `getAccountInfo`
- internal: `getDwalletEncryptedLabelOnChainStatus` in `encrypt-lab-service.ts`
- internal: `DwalletEncryptedLabel.tsx` for the React polling hook

## related

- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the write that produces ciphertextIdentifierHexes
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the reveal path
- [encrypt-multi-chunk-labels.md](/library/tech/encrypt-multi-chunk-labels) - the chunking that produces multiple identifiers per label
