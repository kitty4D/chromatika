import { describe, expect, it, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';

/**
 * `pnpm test:fast` skips the 9 heavy multi-vault flow tests in this file because
 * they spin up multiple Argon2id derivations + ika share key constructions (noble
 * curves scalar mults, pure JS) - each lands at 15-56s even with cheap KDF params,
 * so the file alone is the entire ~270s wall clock of the fast suite. CI's
 * `pnpm test` (`.github/workflows/ci.yml`) runs them without skipping, so the
 * merge gate still covers create / unlock / import / hardware-vault paths.
 *
 * validation / rejection tests stay on plain `it`: they fail before any heavy
 * crypto runs and clear in single-digit ms. ✨ KDF-skipped flows = sub-second pre-push,
 * full-fat coverage where it counts.
 */
const slowIt = it.skipIf(process.env.CHROMATIKA_TEST_FAST_KDF === '1');
import {
  addHardwareVault,
  addVault,
  createInitialHardwareVault,
  createVault,
  importVaultFromSuiPrivateKey,
  listVaultSummaries,
  lockWallet,
  mergeDwalletMeta,
  removeVault,
  renameVault,
  unlockVault,
  walletExists,
} from '@/background/wallet-service';
import { addHardwareAccount } from '@/background/hardware/accounts';
import { deriveSuiKeypair } from '@/background/keyring/hd';
import { unlockVaultCredential } from '@/background/vault-store';
import { MWA_REMOTE_HOST_AUTHORITY } from '@/background/hardware/mwa-remote';

const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const store: Record<string, string> = {};

function installChromeStorageMock() {
  const g = globalThis as unknown as {
    chrome: {
      storage: {
        local: {
          get: (keys: string | string[], cb: (r: Record<string, unknown>) => void) => void;
          set: (items: Record<string, string>, cb?: () => void) => void;
          remove: (keys: string | string[], cb?: () => void) => void;
        };
        session?: unknown;
      };
      runtime: { lastError?: { message: string } };
      alarms?: unknown;
    };
  };
  g.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const ks = Array.isArray(keys) ? keys : [keys];
          const r: Record<string, unknown> = {};
          for (const k of ks) {
            if (store[k]) r[k] = store[k];
          }
          cb(r);
        },
        set(items, cb) {
          Object.assign(store, items);
          cb?.();
        },
        remove(keys, cb) {
          const ks = Array.isArray(keys) ? keys : [keys];
          for (const k of ks) delete store[k];
          cb?.();
        },
      },
    },
    runtime: { lastError: undefined },
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  installChromeStorageMock();
  // module-level session in `wallet-service` survives across tests. storage was just wiped,
  // so any in-memory session refers to a now-deleted blob - lock to avoid stale-session
  // foot-guns where `resolveCredentialOrUnlock` short-circuits and decrypts the new blob with
  // the old key.
  lockWallet();
});

describe('mergeDwalletMeta', () => {
  it('merges per curve with storage winning overlaps', () => {
    const a = { SECP256K1: { baseChain: 'sui' as const, dwalletId: '0xaaa' } };
    const b = { SECP256K1: { baseChain: 'sui' as const, dwalletId: '0xbbb' } };
    const m = mergeDwalletMeta(a, b);
    expect(m.SECP256K1?.dwalletId).toBe('0xbbb');
  });

  it('defaults solana vault meta to solana when dwallet id is base58 and baseChain was omitted', () => {
    const vault = {} as const;
    const storage = {
      ED25519: { dwalletId: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
    } as Parameters<typeof mergeDwalletMeta>[1];
    const m = mergeDwalletMeta(vault, storage, 'solana');
    expect(m.ED25519?.baseChain).toBe('solana');
    expect(m.ED25519?.dwalletId).toBe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
  });

  it('infers solana from base58 id even when vault record said sui (stale baseChain)', () => {
    const vault = {
      ED25519: { baseChain: 'sui' as const, dwalletId: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
    };
    const m = mergeDwalletMeta(vault, {}, 'sui');
    expect(m.ED25519?.baseChain).toBe('solana');
  });
});

describe('multi-vault storage', () => {
  slowIt('create, unlock, add, list, rename, remove (argon2id v3 blob)', async () => {
    const pw = 'correct horse battery staple';
    await createVault(pw, TEST_MNEMONIC);
    await unlockVault(pw);
    let list = await listVaultSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.label).toBe('default');

    await addVault(undefined, { label: 'trading' });
    list = await listVaultSummaries();
    expect(list).toHaveLength(2);

    const firstId = list.find((v) => v.label === 'default')!.id;
    await renameVault(undefined, firstId, 'primary');
    list = await listVaultSummaries();
    expect(list.find((v) => v.id === firstId)!.label).toBe('primary');

    const secondId = list.find((v) => v.label === 'trading')!.id;
    await removeVault(undefined, secondId);
    list = await listVaultSummaries();
    expect(list).toHaveLength(1);
  }, 120_000);

  slowIt('importVaultFromSuiPrivateKey creates importedKey vault (v3 blob)', async () => {
    const pw = 'correct horse battery staple';
    const bech = deriveSuiKeypair(TEST_MNEMONIC, 0).getSecretKey();
    await importVaultFromSuiPrivateKey(pw, { suiPrivateKeyBech32: bech, label: 'pk' });
    await unlockVault(pw);
    const list = await listVaultSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.accountKind).toBe('importedKey');
    expect(list[0]!.label).toBe('pk');
  }, 120_000);

  slowIt('importVaultFromSuiPrivateKey creates Solana-base importedKey vault from solanaSecretKeyB64 alone', async () => {
    const pw = 'correct horse battery staple';
    const solKp = Keypair.generate();
    const solB64 = btoa(String.fromCharCode(...solKp.secretKey));
    await importVaultFromSuiPrivateKey(pw, {
      baseChain: 'solana',
      solanaSecretKeyB64: solB64,
      label: 'seeker',
    });
    await unlockVault(pw);
    const list = await listVaultSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.accountKind).toBe('importedKey');
    expect(list[0]!.label).toBe('seeker');
  }, 120_000);

  slowIt('addHardwareVault creates a remote-MWA Seeker vault with Seeker-signature-derived ika seed and a separate fee-payer keypair', async () => {
    const pw = 'correct horse battery staple';
    await createVault(pw, TEST_MNEMONIC);
    await unlockVault(pw);

    // pretend the user paired a Seeker over the wss reflector: the address is a real
    // Solana Ed25519 pubkey (Seed Vault would have produced one), the auth_token is the
    // opaque blob the wallet returned from `wallet.authorize()`. the ika USK derivation
    // signature is what `wallet.signMessages([IKA_USK_DERIVATION_MESSAGE])` would return
    // during pairing, fixture bytes are fine; the background fn just hashes them.
    const seekerKp = Keypair.generate();
    const seekerB58 = seekerKp.publicKey.toBase58();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerB58,
    });

    const fakeSeekerSig = new Uint8Array(64).fill(0xab);
    const fakeSeekerSigB64 = btoa(String.fromCharCode(...fakeSeekerSig));

    const res = await addHardwareVault(undefined, {
      hardwareAccountId: hwAcct.id,
      baseChain: 'solana',
      label: 'seeker-remote',
      mwaTransport: 'remote',
      mwaAuthToken: 'opaque-token-blob',
      mwaReflectorHost: MWA_REMOTE_HOST_AUTHORITY,
      ikaUskSignatureB64: fakeSeekerSigB64,
    });
    expect(res.vaultId).toBeTruthy();

    const list = await listVaultSummaries();
    const seekerSummary = list.find((v) => v.id === res.vaultId);
    expect(seekerSummary?.accountKind).toBe('hardware');
    expect(seekerSummary?.baseChain).toBe('solana');
    // auto-seed branch must build BOTH curves from the Seeker signature, without this
    // ika DKG / sign would later fail with "Missing ika encryption key material".
    expect(seekerSummary?.ikaKeysReady).toBe(true);

    // decrypt the persisted blob and assert the fields the public summary doesn't surface.
    const { payload } = await unlockVaultCredential(pw);
    const rec = payload.vaults.find((v) => v.id === res.vaultId);
    expect(rec).toBeTruthy();
    if (!rec || rec.accountKind !== 'hardware') throw new Error('expected hardware vault');
    expect(rec.label).toBe('seeker-remote');
    expect(rec.mwaTransport).toBe('remote');
    expect(rec.mwaAuthToken).toBe('opaque-token-blob');
    expect(rec.mwaReflectorHost).toBe(MWA_REMOTE_HOST_AUTHORITY);
    expect(typeof rec.mwaPairedAtEpochMs).toBe('number');
    expect(rec.ledgerFeePayerSolPubkeyB58).toBe(seekerB58);
    // the fee-payer keypair is local to this install, pays ika gRPC fees only, never
    // participates in ika seed derivation. the ika seed comes from the Seeker signature,
    // so the deprecated blended field must NOT be written by new code.
    expect(rec.ikaGrpcFeePayerSolSecretKeyB64).toBeTruthy();
    const decoded = Uint8Array.from(atob(rec.ikaGrpcFeePayerSolSecretKeyB64!), (c) => c.charCodeAt(0));
    expect(decoded.length).toBe(64);
    expect(rec.ikaEncryptionOnlySolSecretKeyB64).toBeUndefined();
    // no companion vault was passed and none should have been required.
    expect(rec.suiPrivateKeyBech32).toBeUndefined();
    expect(rec.solanaSecretKeyB64).toBeUndefined();
  }, 120_000);

  slowIt('addHardwareVault throws when MWA-Solana auto-seed input lacks the Seeker derivation signature', async () => {
    const pw = 'correct horse battery staple';
    await createVault(pw, TEST_MNEMONIC);
    await unlockVault(pw);
    const seekerKp = Keypair.generate();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerKp.publicKey.toBase58(),
    });
    // no `ikaUskSignatureB64`, must fail with a Repair-style error pointing at re-pairing.
    // error wording is protocol-agnostic ("wallet signature") since the same code path now
    // covers WalletConnect + Solana too.
    await expect(
      addHardwareVault(undefined, {
        hardwareAccountId: hwAcct.id,
        baseChain: 'solana',
        mwaTransport: 'remote',
      }),
    ).rejects.toThrow(/wallet signature/i);
  }, 120_000);

  slowIt('createInitialHardwareVault: fresh install + Seeker-MWA-Solana lands on a hardware vault as the only vault', async () => {
    expect(await walletExists()).toBe(false);

    const seekerKp = Keypair.generate();
    const seekerB58 = seekerKp.publicKey.toBase58();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerB58,
    });

    const fakeSig = new Uint8Array(64).fill(0xcd);
    const fakeSigB64 = btoa(String.fromCharCode(...fakeSig));

    const pw = 'correct horse battery staple';
    const res = await createInitialHardwareVault(pw, {
      hardwareAccountId: hwAcct.id,
      ikaUskSignatureB64: fakeSigB64,
      baseChain: 'solana',
      label: 'first-seeker',
      mwaTransport: 'remote',
      mwaAuthToken: 'opaque-blob',
      mwaReflectorHost: MWA_REMOTE_HOST_AUTHORITY,
    });
    expect(res.vaultId).toBeTruthy();
    expect(res.ikaGrpcFeePayerAddress).toBeTruthy();
    expect(await walletExists()).toBe(true);

    await unlockVault(pw);
    const list = await listVaultSummaries();
    expect(list).toHaveLength(1);
    expect(list[0]!.accountKind).toBe('hardware');
    expect(list[0]!.baseChain).toBe('solana');
    expect(list[0]!.ikaKeysReady).toBe(true);

    const { payload } = await unlockVaultCredential(pw);
    const rec = payload.vaults.find((v) => v.id === res.vaultId);
    if (!rec || rec.accountKind !== 'hardware') throw new Error('expected hardware vault');
    expect(rec.label).toBe('first-seeker');
    expect(rec.mwaTransport).toBe('remote');
    expect(rec.mwaAuthToken).toBe('opaque-blob');
    expect(rec.mwaReflectorHost).toBe(MWA_REMOTE_HOST_AUTHORITY);
    expect(typeof rec.mwaPairedAtEpochMs).toBe('number');
    expect(rec.ledgerFeePayerSolPubkeyB58).toBe(seekerB58);
    expect(rec.ikaGrpcFeePayerSolSecretKeyB64).toBeTruthy();
    expect(rec.ikaEncryptionOnlySolSecretKeyB64).toBeUndefined();
    // no companion vault, no hot fee key, purely Seeker-derived.
    expect(rec.suiPrivateKeyBech32).toBeUndefined();
    expect(rec.solanaSecretKeyB64).toBeUndefined();
  }, 120_000);

  slowIt('createInitialHardwareVault: idempotent - when a wallet already exists, lands as a sibling vault', async () => {
    // scenario: user opens onboarding, OnboardingPage races its `walletExists` probe and
    // shows the bootstrap setup, but a vault already exists from prior testing. the user
    // walks through WC pairing and submits with their existing-vault password.
    // expected: the WC vault is added as a sibling, not rejected with "already exists".
    const pw = 'correct horse battery staple';
    const first = await createVault(pw, TEST_MNEMONIC);
    const seekerKp = Keypair.generate();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerKp.publicKey.toBase58(),
    });
    const res = await createInitialHardwareVault(pw, {
      hardwareAccountId: hwAcct.id,
      ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x01))),
      baseChain: 'solana',
      label: 'WC sibling',
    });
    expect(res.vaultId).toBeTruthy();
    expect(res.vaultId).not.toBe(first.vaultId);
    // auto-seed branch generates an in-extension fee payer; `addHardwareVault` surfaces it.
    expect(res.ikaGrpcFeePayerAddress).toBeTruthy();
    // both vaults are now present in the blob.
    await unlockVault(pw);
    const list = await listVaultSummaries();
    expect(list).toHaveLength(2);
    const wc = list.find((v) => v.id === res.vaultId);
    if (!wc) throw new Error('expected the WC sibling vault to be in the list');
    expect(wc.accountKind).toBe('hardware');
    expect(wc.baseChain).toBe('solana');
    expect(wc.label).toBe('WC sibling');
  }, 120_000);

  slowIt('createInitialHardwareVault: surfaces a clear error when the existing-vault password is wrong', async () => {
    // the idempotent fallthrough decrypts the existing blob with the supplied password.
    // a mismatch must produce a normal "Wrong password" error, not silently corrupt anything.
    // (`beforeEach` locks the wallet so `resolveCredentialOrUnlock` actually exercises the
    // typed password instead of short-circuiting on a stale in-memory session.)
    await createVault('correct horse battery staple', TEST_MNEMONIC);
    const seekerKp = Keypair.generate();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerKp.publicKey.toBase58(),
    });
    await expect(
      createInitialHardwareVault('totally different password', {
        hardwareAccountId: hwAcct.id,
        ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x01))),
        baseChain: 'solana',
      }),
    ).rejects.toThrow(/wrong password/i);
  }, 120_000);

  it('createInitialHardwareVault: rejects Sui base + Ledger Sui (Phase 1 = MWA-Solana only)', async () => {
    const hwAcct = await addHardwareAccount({
      vendor: 'ledger',
      chain: 'sui',
      derivationPath: "m/44'/784'/0'/0'/0'",
      address: '0x1111111111111111111111111111111111111111111111111111111111111111',
      ed25519PublicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    });
    await expect(
      createInitialHardwareVault('correct horse battery staple', {
        hardwareAccountId: hwAcct.id,
        ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x02))),
        baseChain: 'sui',
      }),
    ).rejects.toThrow(/Solana ika base/i);
  }, 120_000);

  it('createInitialHardwareVault: rejects Solana-base Ledger / Trezor first-vault (Phase 1 = MWA only)', async () => {
    const ledger = await addHardwareAccount({
      vendor: 'ledger',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: 'LedgerSolanaAddrPlaceholder1111111111111111',
    });
    await expect(
      createInitialHardwareVault('correct horse battery staple', {
        hardwareAccountId: ledger.id,
        ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x03))),
        baseChain: 'solana',
      }),
    ).rejects.toThrow(/Solana Mobile/i);

    const trezor = await addHardwareAccount({
      vendor: 'trezor',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: 'TrezorSolanaAddrPlaceholder1111111111111111',
    });
    await expect(
      createInitialHardwareVault('correct horse battery staple', {
        hardwareAccountId: trezor.id,
        ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x04))),
        baseChain: 'solana',
      }),
    ).rejects.toThrow(/Solana Mobile/i);
  }, 120_000);

  it('createInitialHardwareVault: rejects missing Seeker derivation signature', async () => {
    const seekerKp = Keypair.generate();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerKp.publicKey.toBase58(),
    });
    await expect(
      createInitialHardwareVault('correct horse battery staple', {
        hardwareAccountId: hwAcct.id,
        ikaUskSignatureB64: '',
        baseChain: 'solana',
      }),
    ).rejects.toThrow(/wallet signature/i);
  }, 120_000);

  it('createInitialHardwareVault: rejects weak password', async () => {
    const seekerKp = Keypair.generate();
    const hwAcct = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerKp.publicKey.toBase58(),
    });
    await expect(
      createInitialHardwareVault('short', {
        hardwareAccountId: hwAcct.id,
        ikaUskSignatureB64: btoa(String.fromCharCode(...new Uint8Array(64).fill(0x05))),
        baseChain: 'solana',
      }),
    ).rejects.toThrow(/password required/i);
  }, 120_000);

  slowIt('addHardwareVault siblings: same Seeker identity, two adds, auto-picked ika encryption indices = different ikaShareKeysB64', async () => {
    // sibling-add semantics: when the user calls `addHardwareVault` twice for the SAME hardware
    // identity (same Seeker pubkey -> same dedup'd hwAccountId), chromatika treats the second add
    // as a sibling vault at the next ika encryption index. same on-chain seeker address, but a
    // different dWallet (= different cross-chain addresses). this matches the
    // `passkeyEncryptionIndex` contract on `addPasskeyVault`.
    //
    // restore-on-fresh-install (different scenario) goes through `createInitialHardwareVault`
    // which always uses index 0 - so re-adding the same Seeker on a wiped extension lands on
    // the same dWallet there. that path is exercised by the existing seeker-restore tests.
    const pw = 'correct horse battery staple';
    await createVault(pw, TEST_MNEMONIC);
    await unlockVault(pw);

    const seekerKp = Keypair.generate();
    const seekerB58 = seekerKp.publicKey.toBase58();
    // both addHardwareAccount calls dedupe on `address` so hwA.id === hwB.id; that's how the
    // user sees a single "linked Seeker" with multiple sibling vaults under it.
    const hwA = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
      address: seekerB58,
    });
    const hwB = await addHardwareAccount({
      vendor: 'mwa',
      chain: 'solana',
      derivationPath: "m/44'/501'/1'/0'",
      address: seekerB58,
    });
    expect(hwA.id).toBe(hwB.id);

    const fixtureSig = new Uint8Array(64);
    for (let i = 0; i < fixtureSig.length; i += 1) fixtureSig[i] = (i * 31 + 7) & 0xff;
    const fixtureSigB64 = btoa(String.fromCharCode(...fixtureSig));

    const a = await addHardwareVault(undefined, {
      hardwareAccountId: hwA.id,
      baseChain: 'solana',
      label: 'a',
      mwaTransport: 'local',
      ikaUskSignatureB64: fixtureSigB64,
    });
    const b = await addHardwareVault(undefined, {
      hardwareAccountId: hwB.id,
      baseChain: 'solana',
      label: 'b',
      mwaTransport: 'local',
      ikaUskSignatureB64: fixtureSigB64,
    });

    // auto-pick contract: first add lands on index 0, second on index 1.
    expect(a.ikaEncryptionIndex).toBe(0);
    expect(b.ikaEncryptionIndex).toBe(1);

    const { payload } = await unlockVaultCredential(pw);
    const recA = payload.vaults.find((v) => v.id === a.vaultId);
    const recB = payload.vaults.find((v) => v.id === b.vaultId);
    if (recA?.accountKind !== 'hardware' || recB?.accountKind !== 'hardware') {
      throw new Error('expected hardware vaults');
    }
    expect(recA.ikaShareKeysB64.SECP256K1).toBeTruthy();
    expect(recA.ikaShareKeysB64.ED25519).toBeTruthy();
    // sibling vaults at different encryption indices => different ika user-share keys
    // => different dWallets at the same on-chain Seeker address. that's the whole point.
    expect(recA.ikaShareKeysB64.SECP256K1).not.toBe(recB.ikaShareKeysB64.SECP256K1);
    expect(recA.ikaShareKeysB64.ED25519).not.toBe(recB.ikaShareKeysB64.ED25519);
    // fee-payer keypair is derived from the wallet signature WITHOUT the encryption index, so
    // siblings share a single fee-payer account (funded once). if this flips, the fee-payer
    // derivation has been (incorrectly) coupled to the encryption index.
    expect(recA.ikaGrpcFeePayerSolSecretKeyB64).toBe(recB.ikaGrpcFeePayerSolSecretKeyB64);
    // the persisted record reflects the auto-picked index. recA at 0 may be omitted from the
    // record (we only persist when > 0) - normalize via `?? 0` for the assertion.
    expect(recA.ikaEncryptionIndex ?? 0).toBe(0);
    expect(recB.ikaEncryptionIndex).toBe(1);
  }, 180_000);
});
