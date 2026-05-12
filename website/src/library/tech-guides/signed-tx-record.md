# signed-tx record store + activity feed merge

`SignedTxRecord` is chromatika's local-first metadata about every transaction **this wallet** signed. captures stuff explorers don't expose (like dapp origin at sign time) plus pointer slots for encrypted user notes. lives in `chrome.storage.local['chromatika_signed_txs_v1']`, scoped per vault, FIFO-capped at 500. activity-feed merges these records onto explorer rows by tx hash.

## the record shape

```ts
type SignedTxKind =
  | 'evm-send'
  | 'evm-message-sign'           // future
  | 'evm-typed-data'             // future
  | 'sui-send'                   // future
  | 'sui-message-sign'           // future
  | 'sol-send'                   // future
  | 'sol-message-sign'           // future
  | 'sol-tx-sign'                // future
  | 'btc-send'                   // future
  | 'apt-send';                  // future

type SignedTxChainId = number | string;   // number for EVM (chainId), string for others ('sui-mainnet', 'sol-mainnet', etc.)

interface SignedTxRecord {
  txHash: string;                // EVM tx hash, Sui digest, Solana signature, BTC txid, Aptos tx hash
  origin: string | null;         // dapp origin at sign time, or null for wallet-UI sends
  chainId: SignedTxChainId;
  vaultId: string;               // vault that signed
  timestampMs: number;           // local clock at broadcast (authoritative ordering)
  kind: SignedTxKind;
  encryptedNote?: EncryptedRef;  // optional encrypted user note (see activity-notes-encrypt-decrypt.md)
}
```

`origin` is the load-bearing field: it captures **where the tx came from** (which dapp) - information no chain explorer can give you back later. when you look at your activity feed weeks later and see "sent USDC on Polygon," `origin` tells you "this was from uniswap.org" vs "this was from a phishing clone you don't remember."

## the storage shape

```jsonc
chrome.storage.local["chromatika_signed_txs_v1"] = {
  "<vaultId-A>": [
    { txHash: "0x...", origin: "https://uniswap.org", chainId: 137, vaultId: "vault-A-id", timestampMs: ..., kind: "evm-send", encryptedNote: {...} },
    // ... up to 500 records, oldest pruned ...
  ],
  "<vaultId-B>": [
    // ... independent FIFO queue per vault ...
  ]
}
```

per-vault scoping means switching active vaults loads a different record set. records from vault A are invisible while vault B is active.

## the API

```ts
// write a record after broadcast success
async function recordSignedTx(rec: SignedTxRecord): Promise<void> {
  const all = await loadAll();
  const list = all[rec.vaultId] ?? [];
  list.unshift(rec);                       // newest first
  if (list.length > 500) list.length = 500; // FIFO cap
  all[rec.vaultId] = list;
  await chrome.storage.local.set({ chromatika_signed_txs_v1: all });
}

// look up a single record by hash for the active vault
async function getSignedTxByHash(txHash: string, vaultId: string): Promise<SignedTxRecord | null> {
  const all = await loadAll();
  const list = all[vaultId] ?? [];
  return list.find(r => r.txHash === txHash) ?? null;
}

// build a fast lookup map for the activity feed merge
async function getSignedTxsMap(vaultId: string): Promise<Map<string, SignedTxRecord>> {
  const all = await loadAll();
  const list = all[vaultId] ?? [];
  return new Map(list.map(r => [r.txHash, r]));
}

// patch the encryptedNote field (replace or clear)
async function updateSignedTxNote(txHash: string, vaultId: string, ref: EncryptedRef | null): Promise<boolean> {
  const all = await loadAll();
  const list = all[vaultId] ?? [];
  const rec = list.find(r => r.txHash === txHash);
  if (!rec) return false;
  if (ref === null) delete rec.encryptedNote;
  else rec.encryptedNote = ref;
  await chrome.storage.local.set({ chromatika_signed_txs_v1: all });
  return true;
}
```

## who writes records

today: **EVM send paths only**.

- `signAndBroadcastEvmTxForLedgerWithApprovalFlow` in `evm-send.ts` (line 649): after broadcast success for a Ledger-signed EVM tx
- `signAndBroadcastEvmTxForIkaWithApprovalFlow` in `evm-send.ts` (line 713): after broadcast success for an ika-signed EVM tx

```ts
// after broadcast success, both paths call:
await recordSignedTx({
  txHash: txHashOut,
  origin: params.dappOrigin ?? null,    // dapp-bridge sets this; null for wallet-UI sends
  chainId: filled.chainId,
  vaultId: ikaSession.activeVaultId,
  timestampMs: Date.now(),
  kind: 'evm-send',
});
```

errors are caught + logged via console.warn but don't block the txHash return. the broadcast already happened; failing to record is non-fatal.

**not** writing records yet:
- `signEvmTxOnly` (sign-without-broadcast for relayer / bundler / abstract-wallet flows) - reserves nonce but doesn't broadcast, so recording would mislead the activity feed
- Sui sends (`sendSuiNative`)
- Solana sends (`sendSolanaNative`)
- Bitcoin sends (`sendBtcNative`)
- Aptos sends (`sendAptosNative`)
- message signing paths (evm-message-sign, sol-message-sign, etc.)
- dapp-bridge sign-only flows

filling these in is **tracked future hardening** per STATUS.md line 89. when those paths add `recordSignedTx` calls, encrypted-note attachments will work for them too.

## the activity feed merge

`src/background/services/activity.ts` merges signed-tx records onto explorer-fetched rows:

```ts
async function getMultiChainActivity(s: Session, limitPerChain = 12): Promise<ActivityItem[]> {
  // 1. fetch chain-specific rows in parallel
  const [suiRows, evmRows, solRows, btcRows] = await Promise.all([
    fetchSuiActivity(s, limitPerChain),
    fetchEvmActivity(s, limitPerChain),
    fetchSolanaActivity(s, limitPerChain),
    fetchBitcoinActivity(s, limitPerChain),
  ]);

  // 2. merge into a single list
  const merged: ActivityItem[] = [...suiRows, ...evmRows, ...solRows, ...btcRows];

  // 3. fetch local signed-tx records for the active vault
  const txMap = await getSignedTxsMap(s.activeVaultId);

  // 4. join: for each merged row, look up by digest === txHash
  for (const item of merged) {
    const rec = txMap.get(item.id);   // item.id is the tx digest
    if (rec) {
      item.origin = rec.origin;
      item.signedByThisWallet = true;
      if (rec.encryptedNote) item.hasEncryptedNote = true;
    }
  }

  // 5. sort newest-first, cap at 24-30 items
  merged.sort((a, b) => b.timestampMs - a.timestampMs);
  return merged.slice(0, Math.max(limitPerChain * 2, 30));
}
```

key fields the merge populates:
- `item.origin` (string | null | undefined) - dapp origin URL if known
- `item.signedByThisWallet` (boolean) - true if there's a local record for this digest
- `item.hasEncryptedNote` (boolean) - true if the record has an `encryptedNote` field

UI uses these to:
- render dapp origin hostname under each tx ("via uniswap.org")
- gate the "+ note" / "view note" buttons (only for `signedByThisWallet === true`)
- render the lock badge (only when `hasEncryptedNote === true`)

incoming transfers (txs from someone else to you) don't have a local record → `signedByThisWallet` is undefined → no note buttons. correct semantics: you can only attach notes to txs you signed.

## chain-specific quirks

- **Sui** (`activity.ts` lines 80-84): primary path is `queryTransactionBlocksGraphQL(client, { filter: { affectedAddress }, limit })` using `@mysten/sui` 2.13.2's hand-rolled `transactionBlocks` doc. JSON-RPC fallback is still live per STATUS.md (no GraphQL list wrapper for filtered/scoped queries yet)
- **EVM** (lines 204-231): only Blockscout v2 API is wired today. other explorers (Etherscan, etc.) return `[]`. tracked future
- **Solana** (lines 136-162): `getSignaturesForAddress` + optional Encrypt program label detection on top 12 results (when vault is on Solana ika base)
- **Bitcoin** (lines 169-190): Esplora API for address tx history

## what doesn't merge

- the merged list **drops** records that don't have a corresponding explorer row. so if you signed a tx that the explorer hasn't indexed yet (stale RPC), you won't see it in activity until the explorer catches up. a separate "drain analysis" / "panic forensics" view could surface these orphaned records (tracked future)
- records older than the explorer's window also drop. if you signed a tx 6 months ago and the explorer only returns last 100, the record is lost from the activity view (still in the local store, but unjoined)

## library

- internal: `src/background/services/tx-record.ts` for the store API
- internal: `src/background/services/activity.ts` for the merge
- internal: `src/background/chains/evm-send.ts` for the write hooks (lines 647, 711)
- `chrome.storage.local` for persistence

## related

- [encryption-backend-abstraction.md](/library/tech/encryption-backend-abstraction) - the `EncryptedRef` shape on `encryptedNote`
- [activity-notes-encrypt-decrypt.md](/library/tech/activity-notes-encrypt-decrypt) - how encryptedNote is set + read
- [view-activity-and-portfolio.md](/library/user/view-activity-and-portfolio) (user-guides) - the user-facing surface
