/**
 * hardware vault onboarding paths. supports four hardware vendors via three transports:
 *   - **Ledger** (WebHID) on Sui or Solana - native USB device.
 *   - **Trezor** (TrezorConnect) on Solana only (TrezorConnect doesn't support Sui).
 *   - **MWA** (Solana Mobile Wallet Adapter) - local intent (Android same-device) OR remote
 *     reflector (desktop ↔ Seeker via QR pair). vendor field is `mwa` either way; transport is
 *     stored on the record so signing dispatch picks the right path.
 *   - **WalletConnect v2** (Phantom / Solflare / Jupiter on iOS, etc.) on Solana - same role
 *     as MWA but via WC relay session.
 *
 * three exports:
 *   - `createInitialHardwareVault`: first-vault path. currently Solana-only (MWA / WC). Sui /
 *     Ledger / Trezor first-vault need a different auto-seed pattern that hasn't shipped.
 *   - `addHardwareVault`: sibling-add path. supports all four vendors + Sui-base Ledger when
 *     copying ika keys from an existing vault.
 *   - `refreshMwaAuthToken`: small mutation for MWA-remote re-pair when the reflector token
 *     gets invalidated upstream.
 */

import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Keypair } from '@solana/web3.js';
import {
  IKA_USK_DOMAIN,
  solanaFeeKeypairFromWalletSignature,
} from '@/background/keyring/hd';
import {
  defaultIkaFeeSettings,
  setIkaFeeSettings,
  type IkaFeeMode,
} from '@/background/ika/fee-settings';
import { getHardwareAccountById } from '@/background/hardware/accounts';
import type { BaseChain } from '@/background/ika/ika-adapter';
import { getSession, setSession, type SessionState } from '@/background/session';
import {
  buildPasswordEnvelope,
  buildWalletSignatureEnvelope,
  createInitialVaultBlobV4,
  loadVaultPayloadWithKey,
  storeEncryptedPayloadWithKey,
  walletExists,
} from '@/background/vault-store';
import type { VaultPayloadV3, VaultRecord } from '@/background/vault-types';
import {
  buildIkaShareKeys,
  fromB64,
  makeSeedFromMwaSignature,
  makeSeedFromSolanaKeypair,
  makeSeedFromSuiKeypair,
  nextIkaEncryptionIndex,
  solanaKeypairFromB64,
} from '@/background/vault-keys';
import { resolveCredentialOrUnlock } from '@/background/vault-credentials';
import { sessionStateFromRecord } from '@/background/vault-session-builder';
import {
  defaultSuiNetworkForNewVault,
  kickDiscoveryForVault,
  persistVaultFromSession,
  type VaultEnvelopeForCreate,
} from '@/background/wallet-service-helpers';

/**
 * MWA-remote re-pair: rewrite the persisted `auth_token` on a hardware vault so subsequent
 * signs skip QR re-scan. used when the prior token has been invalidated upstream (e.g. user
 * removed Chromatika from trusted apps on the phone, or the wallet's session storage was
 * wiped). the UI runs a new QR pairing, gets a new token, and writes it back here. vault
 * must already be a hardware MWA-remote record.
 */
export async function refreshMwaAuthToken(
  password: string | undefined,
  vaultId: string,
  authToken: string,
  reflectorHost?: string,
): Promise<void> {
  if (getSession()) await persistVaultFromSession();
  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);
  const idx = payload.vaults.findIndex((v) => v.id === vaultId);
  if (idx === -1) throw new Error('Vault not found');
  const v = payload.vaults[idx]!;
  if (v.accountKind !== 'hardware') throw new Error('Vault is not a hardware vault');
  payload.vaults[idx] = {
    ...v,
    mwaAuthToken: authToken,
    mwaTransport: 'remote',
    mwaPairedAtEpochMs: Date.now(),
    ...(reflectorHost ? { mwaReflectorHost: reflectorHost } : {}),
  };
  await storeEncryptedPayloadWithKey(cred, payload);
}

/**
 * first-vault hardware path: pair Seeker / MWA-Solana wallet, OR pair a Solana wallet over
 * WalletConnect v2; either path captures a wallet signature over `IKA_USK_DERIVATION_MESSAGE`
 * during pairing, derives the user-share encryption keys deterministically from that
 * signature, and writes the initial encrypted vault blob.
 *
 * phase 1 scope: **Solana hardware (MWA or WalletConnect) only**. Ledger Sui / Ledger Solana
 * / Trezor first-vault need a separate auto-seed pattern (extension-generated hot ika keypair
 * with consent UX) that does not exist yet - see `createVault`/`importVault` for the HD-vault
 * path users can take instead.
 *
 * restore parity: re-running this on a different device with the same Seeker (or same WC-paired
 * wallet) signing the same `IKA_USK_DERIVATION_MESSAGE` re-derives the same ika seed and lands
 * on the same dWallet - which is the entire point of pinning the seed to the wallet's signature
 * instead of a randomly generated keypair. WC's `solana_signMessage` returns a raw 64-byte
 * Ed25519 signature (no MWA-style suffix), so we hash it directly.
 *
 * **idempotent against existing vaults.** if `walletExists()` is already true (e.g. the
 * onboarding tab raced its `walletExists` probe, or the user has a leftover dev vault from
 * prior testing), we delegate to `addHardwareVault` so the WC vault lands as a sibling of
 * the existing vaults instead of dead-ending with a confusing error. the user's password
 * must match the existing vault to decrypt the blob - that's the only failure mode and it
 * surfaces as a normal decryption error from `unlockVaultBytes`.
 */
export async function createInitialHardwareVault(
  password: string,
  input: {
    hardwareAccountId: string;
    /** required for MWA / WC Solana auto-seed: base64 of the wallet's signature over `IKA_USK_DERIVATION_MESSAGE`. */
    ikaUskSignatureB64: string;
    baseChain?: BaseChain;
    label?: string;
    mwaTransport?: 'local' | 'remote';
    mwaAuthToken?: string;
    mwaReflectorHost?: string;
    /** WalletConnect v2: persisted relay session captured at pair time. */
    walletConnect?: {
      sessionTopic: string;
      accountAddress: string;
      chainId: string;
    };
    /**
     * ika protocol fee model. `in_extension` (default) generates a deterministic in-extension
     * Solana keypair (derived from the same wallet signature, different index) that pays
     * `approve_message` gRPC fees automatically. `seeker_direct` skips the keypair entirely
     * and routes every gRPC sign through the phone wallet (~3-5 prompts per signed tx). the
     * choice is persisted via `setIkaFeeSettings` and can be flipped later from settings.
     */
    feeMode?: IkaFeeMode;
    feeAutoRefill?: boolean;
    feeRefillLamports?: bigint;
    feeThresholdLamports?: bigint;
  },
): Promise<{ vaultId: string; ikaGrpcFeePayerAddress?: string }> {
  if (!password || password.length < 8) throw new Error('Password required');
  if (await walletExists()) {
    // wallet already exists - add this hardware pair as a sibling vault rather than failing.
    // `addHardwareVault` decrypts the existing blob with `password`; if the password mismatches
    // the user gets a normal decryption error which is the correct failure mode.
    return addHardwareVault(password, {
      hardwareAccountId: input.hardwareAccountId,
      ikaUskSignatureB64: input.ikaUskSignatureB64,
      baseChain: input.baseChain ?? 'solana',
      label: input.label,
      mwaTransport: input.mwaTransport,
      mwaAuthToken: input.mwaAuthToken,
      mwaReflectorHost: input.mwaReflectorHost,
      walletConnect: input.walletConnect,
      feeMode: input.feeMode,
      feeAutoRefill: input.feeAutoRefill,
      feeRefillLamports: input.feeRefillLamports,
      feeThresholdLamports: input.feeThresholdLamports,
    });
  }
  const baseChain = input.baseChain ?? 'solana';
  if (baseChain !== 'solana') {
    throw new Error(
      'first-vault hardware setup currently supports Solana ika base + Solana Mobile (MWA / Seeker) or WalletConnect only. for Sui-base hardware, create an HD vault first then add a Ledger Sui hardware vault from settings.',
    );
  }
  const hw = await getHardwareAccountById(input.hardwareAccountId);
  if (!hw) throw new Error('Hardware account not found');
  const isWcVendor = hw.vendor === 'walletconnect';
  const isMwaVendor = hw.vendor === 'mwa';
  if ((!isMwaVendor && !isWcVendor) || hw.chain !== 'solana') {
    throw new Error(
      'first-vault hardware setup currently supports Solana Mobile (MWA / Seeker) or WalletConnect only. Ledger / Trezor first-vault needs a different auto-seed pattern that has not shipped yet - pair via Solana Mobile or WalletConnect, or create an HD vault first.',
    );
  }
  if (isWcVendor) {
    if (!input.walletConnect?.sessionTopic?.trim()
      || !input.walletConnect?.accountAddress?.trim()
      || !input.walletConnect?.chainId?.trim()
    ) {
      throw new Error('WalletConnect first-vault requires `walletConnect: { sessionTopic, accountAddress, chainId }`');
    }
    if (input.walletConnect.accountAddress !== hw.address) {
      throw new Error('WalletConnect accountAddress does not match the linked hardware account');
    }
  }
  const sigB64 = input.ikaUskSignatureB64?.trim();
  if (!sigB64) {
    throw new Error(
      `${isWcVendor ? 'WalletConnect' : 'MWA'}-Solana hardware vault requires a wallet signature over the ika USK derivation message ("${IKA_USK_DOMAIN}"). Repair: re-pair the wallet so the signature is captured during the pairing step.`,
    );
  }
  // `ikaRootSeedFromMwaSignature` is protocol-agnostic - it hashes any 64-byte Ed25519 signature
  // over IKA_USK_DERIVATION_MESSAGE. re-used here for WC. the function name is historical.
  const sigBytes = fromB64(sigB64);
  const seedFactory = makeSeedFromMwaSignature(sigBytes);
  const { ikaShareKeysB64 } = await buildIkaShareKeys(seedFactory, {});

  const feeMode: IkaFeeMode = input.feeMode ?? 'in_extension';
  // deterministic fee-payer keypair derived from the SAME wallet signature, at a different
  // index. restoring on a new device with the same Seeker re-derives the same address - SOL
  // on the prior install's fee payer is reused, not stranded. skipped entirely when the user
  // chose `seeker_direct` (every gRPC sign goes through the phone via the unlock-time
  // fallthrough in `solanaIkaGrpc` builder).
  let ikaGrpcFeePayerSolSecretKeyB64: string | undefined;
  let ikaGrpcFeePayerAddressOut: string | undefined;
  if (feeMode === 'in_extension') {
    const feePayer = solanaFeeKeypairFromWalletSignature(sigBytes);
    ikaGrpcFeePayerSolSecretKeyB64 = btoa(String.fromCharCode(...feePayer.secretKey));
    ikaGrpcFeePayerAddressOut = feePayer.publicKey.toBase58();
  }

  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const isMwaRemote = isMwaVendor && (input.mwaTransport === 'remote' || Boolean(input.mwaAuthToken));
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || 'default',
    baseChain,
    accountKind: 'hardware',
    hardwareAccountId: input.hardwareAccountId,
    ledgerFeePayerSolPubkeyB58: hw.address,
    ...(ikaGrpcFeePayerSolSecretKeyB64 ? { ikaGrpcFeePayerSolSecretKeyB64 } : {}),
    ...(isMwaVendor
      ? {
          mwaTransport: input.mwaTransport ?? 'local',
          ...(input.mwaAuthToken ? { mwaAuthToken: input.mwaAuthToken } : {}),
          ...(input.mwaReflectorHost ? { mwaReflectorHost: input.mwaReflectorHost } : {}),
          ...(isMwaRemote ? { mwaPairedAtEpochMs: Date.now() } : {}),
        }
      : {}),
    ...(isWcVendor
      ? {
          walletconnect: {
            sessionTopic: input.walletConnect!.sessionTopic,
            accountAddress: input.walletConnect!.accountAddress,
            chainId: input.walletConnect!.chainId,
            pairedAtEpochMs: Date.now(),
          },
        }
      : {}),
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  const payload: VaultPayloadV3 = { v: 3, vaults: [record], activeVaultId: id };
  // v4 multi-envelope: bootstrap with a password envelope AND a wallet-signature envelope so
  // the user can unlock the wallet next time by re-running the seeker / wc / mwa signing
  // dance, no password retype required. ED25519 deterministic signatures (RFC8032) mean
  // the same seeker on any device produces the same signature -> same HKDF KEK -> same master
  // key. Seeker-only restore on a new device works exactly the same way.
  const created = await createInitialVaultBlobV4(
    async (mk) => {
      const envs: VaultEnvelopeForCreate[] = [
        await buildPasswordEnvelope(mk, password, { label: 'password' }),
      ];
      const walletSigSource: 'seeker' | 'walletconnect' = isWcVendor ? 'walletconnect' : 'seeker';
      const walletSigLabel =
        walletSigSource === 'walletconnect'
          ? `walletconnect · ${(input.label?.trim() || 'default').slice(0, 24)}`
          : `seeker · ${(input.label?.trim() || 'default').slice(0, 24)}`;
      envs.push(
        await buildWalletSignatureEnvelope(mk, sigBytes, {
          source: walletSigSource,
          address: hw.address,
          label: walletSigLabel,
          hint: walletSigSource,
        }),
      );
      return envs;
    },
    payload,
  );
  created.masterKeyBytes.fill(0);
  // persist the fee model + tunables. defaults are sensible (auto-refill on, 0.01 SOL refill,
  // 0.001 SOL threshold) but the user can override at pair time or later from settings.
  const baseDefaults = defaultIkaFeeSettings();
  await setIkaFeeSettings(id, {
    mode: feeMode,
    autoRefill: input.feeAutoRefill ?? baseDefaults.autoRefill,
    refillLamports: input.feeRefillLamports ?? baseDefaults.refillLamports,
    thresholdLamports: input.feeThresholdLamports ?? baseDefaults.thresholdLamports,
  });
  return {
    vaultId: id,
    ...(ikaGrpcFeePayerAddressOut ? { ikaGrpcFeePayerAddress: ikaGrpcFeePayerAddressOut } : {}),
  };
}

export async function addHardwareVault(
  password: string | undefined,
  input: {
    hardwareAccountId: string;
    /** hot Sui fee key, optional when using Ledger Sui fee + ika keys copied from another vault. */
    suiPrivateKeyBech32?: string;
    /** required for Ledger-first Sui vault: vault id to copy `ikaShareKeysB64` from (same Chromatika password). */
    ikaShareKeysSourceVaultId?: string;
    solanaSecretKeyB64?: string;
    baseChain?: BaseChain;
    label?: string;
    /** MWA: which transport produced this vault. persisted on the record so the signer popup picks the right path. */
    mwaTransport?: 'local' | 'remote';
    /** MWA remote: opaque auth_token from the initial `wallet.authorize()`, lets later signs skip the QR scan. */
    mwaAuthToken?: string;
    /** MWA remote: host authority pinned at pairing time. */
    mwaReflectorHost?: string;
    /**
     * MWA + Solana / WC + Solana base auto-seed input: base64 of the wallet's signature over
     * `IKA_USK_DERIVATION_MESSAGE`. required when `vendor === 'mwa'` or `vendor === 'walletconnect'`
     * with `chain === 'solana'`, and no `ikaShareKeysSourceVaultId` is provided. the signature
     * seeds ika `UserShareEncryptionKeys` deterministically so the same wallet on a different
     * device re-derives the same keys and lands on the same dWallet.
     */
    ikaUskSignatureB64?: string;
    /**
     * WalletConnect v2 + Solana base: persisted relay session captured at pair time.
     * required when `vendor === 'walletconnect'`. WC's `sessionTopic` plays the role of MWA's
     * `auth_token` - both let the signer popup skip the pairing handshake on subsequent signs.
     */
    walletConnect?: {
      sessionTopic: string;
      accountAddress: string;
      chainId: string;
    };
    /**
     * ika protocol fee model, see `createInitialHardwareVault` for the full doc. default
     * `in_extension` derives a deterministic fee payer from the wallet signature; `seeker_direct`
     * skips the keypair so every gRPC sign goes through the phone.
     */
    feeMode?: IkaFeeMode;
    feeAutoRefill?: boolean;
    feeRefillLamports?: bigint;
    feeThresholdLamports?: bigint;
    /**
     * BIP44-style ika encryption-key index. defaults to 0; when adding a sibling vault from the
     * SAME hardware identity (e.g. multi-account UX surfaced by scan results), pass `1`, `2`, ...
     * different indices produce different ika `UserShareEncryptionKeys` from the same wallet
     * signature, so different dWallets land at the same on-chain seeker / WC address.
     */
    ikaEncryptionIndex?: number;
  },
): Promise<{ vaultId: string; ikaGrpcFeePayerAddress?: string; ikaEncryptionIndex: number }> {
  const hw = await getHardwareAccountById(input.hardwareAccountId);
  if (!hw) throw new Error('Hardware account not found');
  const baseChain = input.baseChain ?? 'sui';
  const suiHot = input.suiPrivateKeyBech32?.trim();
  const solHot = input.solanaSecretKeyB64?.trim();

  // auto-detect the next sibling-vault index for the auto-seed branch when the caller didn't
  // supply one explicitly. when the caller DID supply an index (e.g. they picked it from scan
  // results), honor it verbatim. for the hot-fee + copy-from-source branches we leave the index
  // at 0: those branches don't go through `makeSeedFromMwaSignature`, so an index would be a
  // no-op there.
  let resolvedIkaEncryptionIndex: number;
  if (typeof input.ikaEncryptionIndex === 'number') {
    resolvedIkaEncryptionIndex = Math.max(0, Math.floor(input.ikaEncryptionIndex));
  } else {
    const credForScan = await resolveCredentialOrUnlock(password);
    const payloadForScan = await loadVaultPayloadWithKey(credForScan.key);
    resolvedIkaEncryptionIndex = nextIkaEncryptionIndex(
      payloadForScan,
      (v) => v.accountKind === 'hardware' && v.hardwareAccountId === input.hardwareAccountId,
    );
  }
  const ikaEncryptionIndex = resolvedIkaEncryptionIndex;

  let ikaShareKeysB64: SessionState['ikaShareKeysB64'];
  let ledgerFeePayerEd25519PublicKeyB64: string | undefined;
  let ledgerFeePayerSolPubkeyB58: string | undefined;
  let persistSuiBech: string | undefined;
  let persistSolB64: string | undefined;
  /**
   * MWA + Solana auto-seed: in-extension fee-payer keypair (regenerated per install). pays
   * ika gRPC `approve_message` fees only, never participates in ika seed derivation. the
   * ika seed itself derives from the Seeker's MWA signature over `IKA_USK_DERIVATION_MESSAGE`.
   */
  let ikaGrpcFeePayerSolSecretKeyB64: string | undefined;
  /** surfaced in the return so callers (onboarding UI) can show the funding hint without re-deriving. */
  let ikaGrpcFeePayerAddressOut: string | undefined;

  // hot-fee path: at least one chain-matching hot key.
  const hasMatchingHotKey =
    (baseChain === 'sui' && Boolean(suiHot)) || (baseChain === 'solana' && Boolean(solHot));
  if (hasMatchingHotKey) {
    if (suiHot) Ed25519Keypair.fromSecretKey(suiHot);
    let solFee: Keypair | undefined;
    if (solHot) {
      solFee = solanaKeypairFromB64(solHot);
      persistSolB64 = solHot;
    }
    const seedFactory =
      baseChain === 'solana' && solFee
        ? makeSeedFromSolanaKeypair(solFee)
        : makeSeedFromSuiKeypair(Ed25519Keypair.fromSecretKey(suiHot!));
    const built = await buildIkaShareKeys(seedFactory, {});
    ikaShareKeysB64 = built.ikaShareKeysB64;
    if (suiHot) persistSuiBech = suiHot;
  } else if (
    baseChain === 'solana'
    && (hw.vendor === 'mwa' || hw.vendor === 'walletconnect')
    && hw.chain === 'solana'
    && !input.ikaShareKeysSourceVaultId?.trim()
  ) {
    // MWA / WC + Solana base, no source vault: ika seed derives from the wallet's signature over
    // `IKA_USK_DERIVATION_MESSAGE` (ED25519 deterministic per RFC8032), so the same wallet on
    // any device re-derives the same `UserShareEncryptionKeys` and lands on the same dWallet -
    // that property is the foundation of phone-only restore. we generate a SEPARATE local
    // keypair for ika gRPC `approve_message` fees only; that material never participates in
    // ika seed derivation. the user funds the fee-payer address with devnet SOL after vault
    // create. the user's chain signing key is the wallet's Solana address (`hw.address`), stored
    // as `ledgerFeePayerSolPubkeyB58` for display + signing dispatch parity with the Ledger /
    // Trezor Solana paths.
    //
    // **cross-protocol signature reuse:** WC's `solana_signMessage` returns a raw 64-byte
    // ED25519 signature - no MWA-style sigOnly suffix-strip needed. `ikaRootSeedFromMwaSignature`
    // hashes whatever 64 bytes you hand it; it does not care which protocol delivered them. if
    // we ever unify the two flows, do NOT re-introduce a strip-suffix step on the WC path.
    if (hw.vendor === 'walletconnect') {
      if (!input.walletConnect?.sessionTopic?.trim()
        || !input.walletConnect?.accountAddress?.trim()
        || !input.walletConnect?.chainId?.trim()
      ) {
        throw new Error(
          'WalletConnect-Solana hardware vault requires `walletConnect: { sessionTopic, accountAddress, chainId }` from the pairing step.',
        );
      }
      if (input.walletConnect.accountAddress !== hw.address) {
        throw new Error('WalletConnect accountAddress does not match the linked hardware account');
      }
    }
    const sigB64 = input.ikaUskSignatureB64?.trim();
    if (!sigB64) {
      throw new Error(
        `${hw.vendor === 'walletconnect' ? 'WalletConnect' : 'MWA'}-Solana hardware vault requires a wallet signature over the ika USK derivation message ("${IKA_USK_DOMAIN}"). Repair: re-pair the wallet so the signature is captured during the pairing step.`,
      );
    }
    const sigBytes = fromB64(sigB64);
    const seedFactory = makeSeedFromMwaSignature(sigBytes, ikaEncryptionIndex);
    const built = await buildIkaShareKeys(seedFactory, {});
    ikaShareKeysB64 = built.ikaShareKeysB64;
    const feeMode: IkaFeeMode = input.feeMode ?? 'in_extension';
    if (feeMode === 'in_extension') {
      // deterministic from the same wallet signature, different index. same Seeker on any
      // device -> same fee-payer address -> SOL persists across reinstalls.
      const feePayer = solanaFeeKeypairFromWalletSignature(sigBytes);
      ikaGrpcFeePayerSolSecretKeyB64 = btoa(String.fromCharCode(...feePayer.secretKey));
      ikaGrpcFeePayerAddressOut = feePayer.publicKey.toBase58();
    }
    // `seeker_direct`: skip keypair generation. unlock-time fallthrough in the
    // `solanaIkaGrpc` builder will route every gRPC sign through the phone wallet.
    ledgerFeePayerSolPubkeyB58 = hw.address;
  } else {
    const sourceId = input.ikaShareKeysSourceVaultId?.trim();
    if (!sourceId) {
      throw new Error(
        'Pick another vault that already has ika encryption keys for both curves (complete dWallet setup there). we copy those blobs only - no hot fee secret on this path.',
      );
    }
    const credEarly = await resolveCredentialOrUnlock(password);
    const payloadEarly = await loadVaultPayloadWithKey(credEarly.key);
    const source = payloadEarly.vaults.find((v) => v.id === sourceId);
    if (!source) throw new Error('Source vault not found');
    const secp = source.ikaShareKeysB64.SECP256K1;
    const ed = source.ikaShareKeysB64.ED25519;
    if (!secp || !ed) {
      throw new Error(
        'That vault does not have ika UserShareEncryptionKeys for both curves yet - unlock it and finish ika registration / dWallet setup first',
      );
    }
    ikaShareKeysB64 = { SECP256K1: secp, ED25519: ed };

    if (baseChain === 'sui') {
      if (hw.vendor !== 'ledger' || hw.chain !== 'sui' || !hw.ed25519PublicKeyB64?.trim()) {
        throw new Error(
          'Sui hardware-first path requires a Ledger Sui account with a stored Ed25519 pubkey (Trezor and MWA do not support Sui). connect the Sui app in Ledger settings and add the account first.',
        );
      }
      ledgerFeePayerEd25519PublicKeyB64 = hw.ed25519PublicKeyB64.trim();
      const pk = new Ed25519PublicKey(ledgerFeePayerEd25519PublicKeyB64);
      if (pk.toSuiAddress() !== hw.address) {
        throw new Error('Ledger Sui public key on file does not match the hardware account Sui address - re-add the Ledger account');
      }
    } else if (baseChain === 'solana') {
      if (hw.chain !== 'solana') {
        throw new Error(
          'Solana hardware-first path needs a Solana hardware account (Ledger Solana app, Trezor, or Solana Mobile). add the account in settings → hardware first.',
        );
      }
      if (
        hw.vendor !== 'ledger'
        && hw.vendor !== 'trezor'
        && hw.vendor !== 'mwa'
        && hw.vendor !== 'walletconnect'
      ) {
        throw new Error('Unsupported hardware vendor for Solana ika base');
      }
      // all four vendors (Ledger / Trezor / MWA / WalletConnect) store the Solana address in
      // the same field. the vendor on the hw account record distinguishes signing paths at unlock.
      ledgerFeePayerSolPubkeyB58 = hw.address;
    } else {
      throw new Error('Hardware-first vault supports Sui or Solana ika base only');
    }
  }

  if (getSession()) await persistVaultFromSession();
  const cred = await resolveCredentialOrUnlock(password);
  const payload = await loadVaultPayloadWithKey(cred.key);
  const id = crypto.randomUUID();
  const network = defaultSuiNetworkForNewVault();
  const isMwaRemoteSeeker =
    hw.vendor === 'mwa' && (input.mwaTransport === 'remote' || Boolean(input.mwaAuthToken));
  const record: VaultRecord = {
    id,
    label: input.label?.trim() || `hardware ${payload.vaults.length + 1}`,
    baseChain,
    accountKind: 'hardware',
    hardwareAccountId: input.hardwareAccountId,
    ...(ikaEncryptionIndex > 0 ? { ikaEncryptionIndex } : {}),
    suiPrivateKeyBech32: persistSuiBech,
    solanaSecretKeyB64: persistSolB64,
    ledgerFeePayerEd25519PublicKeyB64,
    ledgerFeePayerSolPubkeyB58,
    ikaGrpcFeePayerSolSecretKeyB64,
    ...(hw.vendor === 'mwa'
      ? {
          mwaTransport: input.mwaTransport ?? 'local',
          ...(input.mwaAuthToken ? { mwaAuthToken: input.mwaAuthToken } : {}),
          ...(input.mwaReflectorHost ? { mwaReflectorHost: input.mwaReflectorHost } : {}),
          ...(isMwaRemoteSeeker ? { mwaPairedAtEpochMs: Date.now() } : {}),
        }
      : {}),
    ...(hw.vendor === 'walletconnect' && input.walletConnect
      ? {
          walletconnect: {
            sessionTopic: input.walletConnect.sessionTopic,
            accountAddress: input.walletConnect.accountAddress,
            chainId: input.walletConnect.chainId,
            pairedAtEpochMs: Date.now(),
          },
        }
      : {}),
    network,
    ikaShareKeysB64,
    dwalletMeta: {},
    createdAtMs: Date.now(),
  };
  payload.vaults.push(record);
  payload.activeVaultId = id;
  await storeEncryptedPayloadWithKey(cred, payload);
  // persist ika fee settings for this vault. for Solana hardware vaults the auto-seed branch
  // already decided the mode and (in `in_extension`) generated the keypair; we just record the
  // user-tunable knobs alongside it. for non-hardware-Solana vaults this still runs, defaulting
  // to `in_extension` + auto-refill, but those vaults don't use the fee account today (Sui-base
  // ika has no `approve_message` on Solana). the settings remain harmless.
  const baseDefaults = defaultIkaFeeSettings();
  await setIkaFeeSettings(id, {
    mode: input.feeMode ?? baseDefaults.mode,
    autoRefill: input.feeAutoRefill ?? baseDefaults.autoRefill,
    refillLamports: input.feeRefillLamports ?? baseDefaults.refillLamports,
    thresholdLamports: input.feeThresholdLamports ?? baseDefaults.thresholdLamports,
  });
  if (getSession()) {
    setSession(await sessionStateFromRecord(record, cred));
    void kickDiscoveryForVault(id);
  }
  return {
    vaultId: id,
    ikaEncryptionIndex,
    ...(ikaGrpcFeePayerAddressOut ? { ikaGrpcFeePayerAddress: ikaGrpcFeePayerAddressOut } : {}),
  };
}
