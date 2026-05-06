# session state + multi-vault model

chromatika's `SessionState` is the in-memory snapshot of "what's unlocked right now". it holds the master AES key (as a non-extractable `CryptoKey`), the active vault id, per-vault dWallet meta, fee material, ika share keys, and pending request queues. switching active vault swaps a chunk of this state without re-prompting the password.

## the shape (high-level)

```ts
type SessionState = {
  // multi-vault
  vaultKey: CryptoKey; // non-extractable AES-GCM master key (decrypts vault blob)
  vaultKdfMeta: KdfMeta; // argon2id salt + params (for re-deriving on switch if needed)
  activeVaultId: string;
  vaults: VaultRecord[]; // all vault records (decrypted)

  // active-vault-scoped
  activeDwalletMeta: DwalletMeta[]; // active vault's dWallet list
  activeIkaShareKeys: { SECP256K1; ED25519 }; // per-curve UserShareEncryptionKeys instances
  activeFeeMaterial: FeeMaterial; // sui keypair + solana fee-payer keypair
  activePresignPools: { SECP256K1_ECDSA; SECP256K1_TAPROOT; ED25519_EDDSA };

  // hardware
  solanaMwaAccount: HardwareVaultRecord | null; // active MWA Seeker account
  solanaWcAccount: HardwareVaultRecord | null; // active WC account (for x402)

  // pending requests (in chrome.storage.session for SW restart survivability)
  pendingTxApprovals: Map<string, PendingTxApproval>;
  pendingHardwareSigns: Map<string, PendingHardwareSign>;
  pendingMcpSigns: Map<string, PendingMcpSign>;
  pendingX402Approvals: Map<string, PendingX402Approval>;
  pendingPasskeyRequests: Map<string, PendingPasskey>;

  // lifecycle
  unlockedAtMs: number;
  lockAtMs: number; // autolock timer end
};
```

## the unlock flow → session populate

```
1. user provides credential (password / passkey / signature / words)
2. derive envelope key
3. unwrap masterKey → import as non-extractable CryptoKey
4. read chromatika_vault_v3 from chrome.storage.local
5. AES-GCM decrypt → JSON.parse → { v: 3, vaults: [...], activeVaultId }
6. populate sessionState:
   - vaultKey, vaultKdfMeta
   - activeVaultId
   - vaults
7. for the active vault, populate scoped fields:
   - activeDwalletMeta (merge in-blob with overlay from chromatika_dwallet_meta_v2_<id>)
   - activeIkaShareKeys (deserialize from record.ikaShareKeysB64, or re-derive via makeSeed if missing)
   - activeFeeMaterial (mnemonic / privkey / hardware-record-derived)
   - activePresignPools (load from chromatika_presign_pools_v3_<id>)
8. write the unlock cache:
   chrome.storage.session.set({
     chromatika_unlock_cache_v1: { masterKeyBytesB64, vaultBlobIvB64, lockAtMs, ... }
   });
9. arm the autolock alarm
10. broadcast 'unlocked' event to all UI ports
```

## the switch-vault flow

```ts
async function switchVault(targetVaultId: string) {
  const targetRecord = sessionState.vaults.find((v) => v.id === targetVaultId);
  if (!targetRecord) throw "vault not found";

  // cleanup old active state
  await persistActiveVaultEphemera(); // flush dwalletMeta + presign pools to storage

  // swap active id
  sessionState.activeVaultId = targetVaultId;

  // populate new active scoped fields
  sessionState.activeDwalletMeta = mergeMeta(
    targetRecord.dwalletMeta,
    await loadDwalletMetaOverlay(targetVaultId)
  );
  sessionState.activeIkaShareKeys = await buildIkaShareKeys(
    makeSeedForRecord(targetRecord),
    targetRecord.ikaShareKeysB64
  );
  sessionState.activeFeeMaterial = await feeMaterialFromVaultRecord(targetRecord);
  sessionState.activePresignPools = await loadPresignPools(targetVaultId);

  // persist activeVaultId in the vault blob
  await persistVaultBlob({ ...sessionState.vaults }, targetVaultId);

  // broadcast 'vault-changed' to UI ports + dapp bridge
  // dapp bridge re-emits accountsChanged to connected origins
}
```

key observation: switchVault **doesn't re-prompt for password**. the masterKey already unwrapped each vault's data. switching just reloads the per-vault scoped fields.

multi-vault is one masterKey wrapping many vault records. each vault has its own credentials (mnemonic, privkey, etc.) but they all sit inside the same AES-GCM-sealed payload, decryptable by the masterKey held in session.

## the "session never has plaintext password" rule

the session holds:

- `vaultKey` (non-extractable `CryptoKey` - the imported AES key, can be used to encrypt / decrypt but bytes can't be extracted via JS)
- `vaultKdfMeta` (Argon2id salt + params - public-equivalent; useful only if combined with a password)

it does **not** hold:

- the password (string)
- any envelope's KDF input (PRF output, signature bytes) after the unwrap completes

if you read the session state via dev tools, you cannot recover the password.

## the unlock cache holds key bytes

the **post-argon2id key bytes** (b64) live in `chrome.storage.session` for cold-SW rehydrate. these are sensitive - anyone who can read session storage can decrypt the vault until lock. mitigations: lock-on-OS-screenlock, manual lock, autolock window. see [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache).

## the dapp-bridge contract

connected origins see a stable mental model:

- `accounts` = the active dWallet's per-curve addresses
- `chainId` (EVM) = the active EVM chain id

switching active dWallet → emit `accountsChanged` to connected origins.
switching active EVM chain → emit `chainChanged`.
switching active vault (which usually changes both) → emit both, plus optionally `disconnect` if the new vault's dWallet doesn't have a permission for that origin.

## the pending request queues

for any flow that needs user approval (TX_APPROVE, HW_SIGN, MCP_APPROVE, X402_APPROVE, passkey ceremonies), chromatika enqueues the request in a `Map<string, ...>` keyed by random UUID. the pending entries live in `chrome.storage.session` so a service worker restart doesn't lose them.

```ts
async function enqueuePending(kind: string, request: any) {
  const id = randomUUID();
  const stored = await chrome.storage.session.get("chromatika_pending");
  stored[kind] = stored[kind] ?? {};
  stored[kind][id] = request;
  await chrome.storage.session.set({ chromatika_pending: stored });
  return id;
}
```

popups read by id (`?txapprove=<id>`, `?hwsign=<id>`, etc.) and call back via tRPC to resolve.

## the dWallet meta merge

`activeDwalletMeta` is the in-memory merge of:

1. **in-blob copy** - in `record.dwalletMeta` inside the vault payload (authoritative)
2. **overlay** - in `chromatika_dwallet_meta_v2_<vaultId>` (potentially fresher for some flows)

merge prefers the overlay timestamp where present. `syncVaultMeta` flushes session state into the overlay on demand.

## library

- internal: `wallet-extension/src/background/session.ts` for session orchestration
- internal: `wallet-extension/src/background/wallet-service.ts` for the unlock + switchVault impls
- internal: `wallet-extension/src/background/keyring/hd.ts` for `feeMaterialFromVaultRecord`, `buildIkaShareKeys`

## related

- [vault-blob-v3-format.md](/library/tech/vault-blob-v3-format) - the on-disk format
- [cold-sw-unlock-cache.md](/library/tech/cold-sw-unlock-cache) - the session-storage rehydrate
- [multi-envelope-design.md](/library/tech/multi-envelope-design) - how unlock unwraps the masterKey
- [ika-seed-derivation-overview.md](/library/tech/ika-seed-derivation-overview) - the seed factories that populate ikaShareKeys
