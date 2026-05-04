/**
 * versioned Chromatika vault blob (`chromatika_vault_v2` key): discriminated vault records.
 * v2 payloads are migrated to v3 on read; saves always persist v3.
 */

import type { BaseChain } from '@/background/ika/ika-adapter';
import type { SuiNetworkId } from '@/config/sui';
import type { CurveKey, SessionState } from '@/background/session';

/** matches session `AccountKind`: single source, extend both together. */
export type VaultAccountKind =
  | 'hd'
  | 'importedKey'
  | 'hardware'
  | 'dwalletAnchored'
  | 'passkey'
  | 'waap'
  | 'lazor';

export interface VaultRecordBase {
  id: string;
  label: string;
  baseChain: BaseChain;
  network: SuiNetworkId;
  ikaShareKeysB64: Partial<Record<CurveKey, string>>;
  dwalletMeta: SessionState['dwalletMeta'];
  createdAtMs: number;
}

export type HdVaultRecord = VaultRecordBase & {
  accountKind: 'hd';
  mnemonic: string;
  /**
   * bip44 account index used when deriving the sui / solana / evm keypairs from this mnemonic.
   * absent on records persisted before this field was added; treat `undefined` as `0` so old
   * single-account vaults continue to work. multi-account creates / imports write the actual
   * index here so signing + sending derive the right keypair.
   */
  accountIndex?: number;
};

/** Sui: Mysten Bech32 secret (`suiprivkey...`). Solana: base64 of 64-byte secret key JSON bytes. */
export type ImportedKeyVaultRecord = VaultRecordBase & {
  accountKind: 'importedKey';
  suiPrivateKeyBech32?: string;
  solanaSecretKeyB64?: string;
};

export type HardwareVaultRecord = VaultRecordBase & {
  accountKind: 'hardware';
  hardwareAccountId: string;
  /**
   * bip44-style ika encryption-key index. defaults to 0; sibling vaults from the SAME hardware
   * identity (same `hardwareAccountId` + same wallet signature over `IKA_USK_DERIVATION_MESSAGE`)
   * increment to produce different dwallets at the same on-chain solana / sui address.
   * absent on records persisted before this field was added; treat `undefined` as `0`.
   */
  ikaEncryptionIndex?: number;
  /** until Ledger Sui signs PTBs in-app, ika fee payer uses this material (same as imported). */
  suiPrivateKeyBech32?: string;
  /**
   * Ledger-only fee payer: Ed25519 pubkey (32 bytes) base64, must match linked `hardwareAccountId` Sui address.
   * requires both `ikaShareKeysB64` curves populated (no fresh ika root derivation without a fee secret).
   */
  ledgerFeePayerEd25519PublicKeyB64?: string;
  /** Solana-base Ledger fee: base58 pubkey string, must match linked Ledger `hardwareAccountId` (chain `solana`). */
  ledgerFeePayerSolPubkeyB58?: string;
  solanaSecretKeyB64?: string;
  /**
   * MWA + Solana base: in-extension Solana keypair (base64 canonical 64-byte `Keypair.secretKey`)
   * that signs `approve_message` requests for the ika gRPC fee payer in `solana-grpc-client.ts`.
   *
   * **fee payer ONLY.** unlike the deprecated `ikaEncryptionOnlySolSecretKeyB64`, this keypair is
   * NOT the source of the ika `UserShareEncryptionKeys` seed: those are derived from the Seeker's
   * `signMessages` over `IKA_USK_DOMAIN` so the dWallet survives a re-install on a new device.
   * regenerated per install; the user funds it with devnet SOL after vault create / restore.
   */
  ikaGrpcFeePayerSolSecretKeyB64?: string;
  /**
   * @deprecated since the Seeker-signature-derived ika seed landed. old dev installs may still
   * carry this field, `feeMaterialFromVaultRecord` reads it as a fallback when
   * `ikaGrpcFeePayerSolSecretKeyB64` is absent. **no new writes.** will be removed after a stable
   * cycle (per CLAUDE.md "pre-release: no obligation to migrate older dev profiles").
   *
   * original semantics: blended ika seed source + ika gRPC fee payer (auto-generated keypair).
   * the blend made restore impossible: fresh install = fresh keypair = different dWallet.
   */
  ikaEncryptionOnlySolSecretKeyB64?: string;
  /** MWA: which transport produced this vault. `local` = Android intent, `remote` = wss reflector + QR. */
  mwaTransport?: 'local' | 'remote';
  /** MWA remote: opaque `auth_token` from `wallet.authorize()`, used to skip QR rescan on subsequent signs. */
  mwaAuthToken?: string;
  /** MWA remote: host authority pinned at pairing time (e.g. `reflect.solanamobile.com`). */
  mwaReflectorHost?: string;
  /** MWA remote: pairing timestamp for diagnostics. */
  mwaPairedAtEpochMs?: number;
  /**
   * WalletConnect v2 (Solana) session, persisted at pair time and replayed on subsequent
   * signs via `signClient.request({ topic: sessionTopic, ... })`. mutually exclusive with
   * the `mwa*` fields on a single record - a hardware vault is either MWA or WC, not both.
   *
   * nested intentionally: signals direction toward a vendor-discriminated union for
   * `HardwareVaultRecord` without forcing that refactor in this PR. when we do flatten
   * out the discriminant the WC fields stay grouped which keeps the diff small.
   */
  walletconnect?: {
    /** opaque relay topic returned by `signClient.connect().approval()`. */
    sessionTopic: string;
    /** base58 Solana pubkey the wallet authorized at pair time. */
    accountAddress: string;
    /** CAIP-2 chain id frozen at pair time (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). */
    chainId: string;
    pairedAtEpochMs: number;
  };
};

export type DwalletAnchoredVaultRecord = VaultRecordBase & {
  accountKind: 'dwalletAnchored';
  anchorDwalletId: string;
  /** fee payer for ika Sui PTBs until MPC-only fee ships. */
  suiPrivateKeyBech32?: string;
  solanaSecretKeyB64?: string;
};

/**
 * Sui passkey vault: secp256r1 / SIP-9 (`blake2b_256(0x06 || pk_compressed)` -> Sui address).
 * WebAuthn PRF hmac-secret extension provides the deterministic 32-byte secret that seeds
 * `UserShareEncryptionKeys` via `ikaRootSeedFromPasskeyPRF`.
 *
 * **prfSalt is a chromatika-wide constant** (`keccak256("chromatika.passkey.prf-salt.v1")`,
 * via `chromatikaPrfSaltB64()` in `passkey-derive.ts`). NOT a per-vault random anymore - random
 * salts couldn't be recovered from a passkey alone after extension reinstall, breaking the
 * "same passkey = same dWallet" promise. with a constant salt, the PRF output depends only on
 * the per-credential authenticator secret (which lives on-device + survives platform passkey
 * sync), so reinstalling chromatika and selecting the same passkey re-derives the identical ika
 * seed -> identical UserShareEncryptionKeys -> existing dWallet caps re-discovered automatically
 * via `kickDiscoveryForVault` after persist. the salt is not a secret per WebAuthn spec.
 *
 * **multi-vault from one passkey**: `passkeyEncryptionIndex` is BIP44-style account index. one
 * passkey credential = one Sui address (passkey pubkey is fixed) but many ika seeds via
 * `ikaRootSeedFromPasskeyPRF(prfSecret, encryptionKeyIndex)` = many dWallets = many cross-chain
 * (EVM/BTC/Solana/Aptos) identities. `addPasskeyVault` for the SAME credentialId picks
 * `max(existingIndices) + 1`; new credentialId resets to 0.
 *
 * `baseChain` is forced to `'sui'` at vault creation; Solana addresses come from dWallet MPC.
 *
 * **stored fields are NOT secrets**: pk + credentialId + rpId + prfSalt + index are pointers
 * to "which passkey, which derivation slot." the secret is the PRF output, fetched fresh on
 * every unlock by invoking the authenticator. that's why the vault key derives from PRF rather
 * than from any field on this record.
 */
export type PasskeyVaultRecord = VaultRecordBase & {
  accountKind: 'passkey';
  /** base64url(`credential.rawId`); constrains `provider.get()` so the right passkey is used. */
  passkeyCredentialId: string;
  /** base64(33-byte compressed secp256r1 public key). */
  passkeyPublicKeyB64: string;
  /** `chrome.runtime.id` at registration; pinned for diagnostics if the extension id changes. */
  passkeyRpId: string;
  /** base64(32 bytes) fed to the WebAuthn PRF extension on every assertion. now always the chromatika constant. */
  passkeyPrfSaltB64: string;
  /**
   * BIP44-style derivation index for the ika `UserShareEncryptionKeys` seed. defaults to `0`
   * for the first vault from a credential; sibling vaults from the SAME credentialId increment.
   * absent on records persisted before this field was added; treat `undefined` as `0`.
   */
  passkeyEncryptionIndex?: number;
  /**
   * which path produced the active ika seed.
   * - `'passkey-prf'`: seed = `keccak256(prfOutput || index_le)`. recovery via platform sync.
   * - `'recovery-words'`: seed = `keccak256(bip39Seed || index_le)`. passkey is unlock convenience only;
   *   the 24-word phrase can rebuild the dWallet on any device.
   */
  seedSource: 'passkey-prf' | 'recovery-words';
  /** opt-in only. encrypted under the vault key. user-facing "show recovery code" walks through unlock first. */
  recoveryWordsEncryptedB64?: string;
};

/**
 * waap vault: `@human.tech/waap-sdk` modal + Sui wallet-standard. user signs in with email /
 * phone / social; waap returns a Sui Ed25519 public key + address. ika seed derives from a
 * deterministic signature over `IKA_USK_DERIVATION_MESSAGE` IF waap signatures are deterministic
 * (verified at pairing). otherwise falls back to a 24-word recovery phrase.
 *
 * `baseChain` is forced to `'sui'`; Solana via dWallet MPC.
 */
export type WaapVaultRecord = VaultRecordBase & {
  accountKind: 'waap';
  /** Sui address waap returned at login. shown as the vault address. */
  waapSuiAddress: string;
  /**
   * BIP44-style ika encryption-key index. sibling vaults from the SAME waap login (same
   * `waapSuiAddress` + same pairing signature OR same recovery words) increment to produce
   * different dWallets at the same waap Sui address. absent = 0.
   */
  ikaEncryptionIndex?: number;
  /** Sui-side Ed25519 public key, base64. needed for sender / signature verification. */
  waapSuiPublicKeyB64: string;
  /** which login the user used at pairing; diagnostic only, user re-logs on every unlock anyway. */
  waapAuthMethod: 'email' | 'phone' | 'social';
  /** if `waapAuthMethod === 'social'`, which provider. */
  waapSocialProvider?: 'google' | 'discord' | 'twitter' | 'github' | 'bluesky';
  /**
   * - `'waap-signature'`: waap is deterministic; ika seed = `keccak256(sig || index_le)`. signature persisted.
   * - `'recovery-words'`: waap is non-deterministic; BIP39 phrase is the seed source.
   */
  seedSource: 'waap-signature' | 'recovery-words';
  /** only if `seedSource === 'waap-signature'`. encrypted under the vault key, owning it derives the ika seed. */
  waapPairingSignatureB64?: string;
  /** only if `seedSource === 'recovery-words'`. */
  recoveryWordsEncryptedB64?: string;
};

/**
 * Lazor vault: Solana-native passkey smart wallet (`@lazorkit/wallet`). Lazor's anchor program
 * verifies WebAuthn secp256r1 signatures via the Solana precompile and gates a PDA smart account.
 * authentication happens at Lazor's hosted portal (`https://portal.lazor.sh`), the user's
 * passkey is bound to lazor.sh's rpId, not chrome-extension://..., so chromatika doesn't run
 * `navigator.credentials` directly and cannot opt into the WebAuthn PRF extension.
 *
 * because we can't get a deterministic 32-byte secret out of a portal-hosted assertion, v1 uses
 * a **24-word recovery phrase** as the seed source. the user writes it down at pairing, and the
 * phrase drives both:
 *   - the ika `UserShareEncryptionKeys` seed via `ikaRootSeedFromRecoveryWords`
 *   - the deterministic Ed25519 fee payer keypair via SLIP10 (`deriveSolanaKeypair`) for ika
 *     `approve_message` calls
 *
 * Lazor's smart-wallet PDA is the **user-facing Solana address** (where SOL / SPL live, signed
 * via passkey at Lazor portal). cross-chain addresses (Sui / EVM / BTC / Aptos) come from the
 * ika dWallet seeded by the phrase. on a fresh install, the user types the phrase + re-pairs
 * the same Lazor passkey to recover both surfaces.
 *
 * `baseChain` is forced to `'solana'`. `ikaShareKeysB64` and `dwalletMeta` are populated like
 * every other vault kind, Lazor vaults DO drive an ika dWallet.
 *
 * **future**: if Lazor exposes PRF or chromatika ships password-free unlock with a portable
 * deterministic key, the phrase requirement can be relaxed.
 */
export type LazorVaultRecord = VaultRecordBase & {
  accountKind: 'lazor';
  /**
   * base58 Solana smart-wallet PDA resolved via Lazor's anchor program
   * (`LazorkitClient.getSmartWalletByCredentialHash` -> `result.smartWallet.toBase58()`). this
   * is the user-facing Solana address where SOL / SPL live.
   *
   * **historical note**: chromatika v1 incorrectly stored the WebAuthn passkey P-256 pubkey
   * (base64) here as a placeholder. v2 (this slice) calls the resolver before persist so the
   * field actually holds a valid base58 PDA. dev installs with the placeholder value need to
   * clear extension storage + re-onboard (per the pre-release policy in CLAUDE.md); the scan
   * service detects the placeholder and surfaces a setup-time note pointing here.
   */
  lazorSmartWalletPubkeyB58: string;
  /**
   * BIP44-style ika encryption-key index. sibling vaults from the SAME Lazor smart wallet (same
   * `lazorSmartWalletPubkeyB58` + same recovery phrase) increment to produce different dWallets
   * at the same Lazor smart-wallet PDA. absent = 0.
   */
  ikaEncryptionIndex?: number;
  /** base64 of the credential id portal returned (passkey identity at lazor.sh). */
  lazorCredentialIdB64: string;
  /** base64 of the raw secp256r1 passkey public key returned by Lazor portal. */
  lazorPasskeyPubkeyB64: string;
  /**
   * base58 wallet device PDA - links the credential to the smart wallet on chain. populated by
   * the same `getSmartWalletByCredentialHash` lookup that resolves `lazorSmartWalletPubkeyB58`.
   */
  lazorWalletDevicePubkeyB58?: string;
  /** rpId at pairing (e.g. `portal.lazor.sh`); diagnostic only, chromatika doesn't run WebAuthn here. */
  lazorPortalUrl: string;
  /** base58 Lazor anchor program id pinned at pairing (devnet vs mainnet). */
  lazorProgramId: string;
  /** Solana cluster the smart account lives on. */
  lazorNetwork: 'mainnet' | 'devnet';
  /**
   * which path produced the active ika seed.
   * - `'lazor-signature'` (recommended): Lazor passkey signed `IKA_USK_DERIVATION_MESSAGE_LAZOR_V1`
   *   at pairing - deterministic per RFC 6979 ECDSA on supported authenticators (apple platform,
   *   most hardware tokens). seed = `keccak256(signature || index_le)`. restore via "log into
   *   existing" at portal.lazor.sh - same passkey -> same signature -> same seed -> same dWallet.
   * - `'recovery-words'`: 24-word phrase; works on any authenticator including non-deterministic
   *   ones. fee payer also derives from the phrase via SLIP10 so a chromatika reinstall + same
   *   phrase reuses the funded fee account. seed = `keccak256(bip39Seed || index_le)`.
   */
  seedSource: 'lazor-signature' | 'recovery-words';
  /**
   * only when `seedSource === 'lazor-signature'`. encrypted (under the vault key) base64 of the
   * pairing-time signature. retained so subsequent ika operations (e.g. sibling-add at higher
   * encryption index) can re-derive seeds without re-prompting the Lazor portal. NOT required
   * for unlock - the password envelope handles that today.
   */
  lazorPairingSignatureB64?: string;
  /**
   * required when `seedSource === 'recovery-words'`. encrypted 24-word phrase; re-deriving the
   * ika seed on demand. lazor-signature path leaves this absent.
   */
  recoveryWordsEncryptedB64?: string;
  /**
   * encrypted base64 of the 64-byte Ed25519 secret key derived from the recovery phrase via
   * SLIP10 (`m/44'/501'/0'/0'`). pays ika `approve_message` gRPC fees + serves as the seed
   * source for `ikaRootSeedFromSolanaKeypair`. fund this address with ~0.01 SOL after vault
   * creation, same pattern as MWA hardware vaults' `ikaGrpcFeePayerSolSecretKeyB64`.
   */
  lazorIkaFeePayerSolSecretKeyB64: string;
};

export type VaultRecord =
  | HdVaultRecord
  | ImportedKeyVaultRecord
  | HardwareVaultRecord
  | DwalletAnchoredVaultRecord
  | PasskeyVaultRecord
  | WaapVaultRecord
  | LazorVaultRecord;

export type VaultPayloadV3 = {
  v: 3;
  vaults: VaultRecord[];
  activeVaultId: string | null;
};

/** legacy on-disk shape (pre vault kinds). */
type VaultPayloadV2 = {
  v: 2;
  vaults: Array<
    VaultRecordBase & {
      accountKind?: 'hd';
      mnemonic: string;
    }
  >;
  activeVaultId: string | null;
};

export function isHdVault(r: VaultRecord): r is HdVaultRecord {
  return r.accountKind === 'hd';
}

export function vaultHasMnemonic(r: VaultRecord): r is HdVaultRecord {
  return r.accountKind === 'hd' && typeof (r as HdVaultRecord).mnemonic === 'string';
}

function migrateV2Row(
  v: VaultPayloadV2['vaults'][number],
): VaultRecord {
  const base = {
    id: v.id,
    label: v.label,
    baseChain: v.baseChain,
    network: v.network,
    ikaShareKeysB64: v.ikaShareKeysB64 ?? {},
    dwalletMeta: v.dwalletMeta ?? {},
    createdAtMs: v.createdAtMs,
  };
  // v2 on-disk rows were always mnemonic-backed HD.
  return {
    ...base,
    accountKind: 'hd',
    mnemonic: v.mnemonic,
  };
}

export function parseAndMigrateVaultPayload(json: string): VaultPayloadV3 {
  const raw = JSON.parse(json) as VaultPayloadV2 | VaultPayloadV3;
  if (raw.v === 3 && Array.isArray(raw.vaults)) {
    return raw as VaultPayloadV3;
  }
  if (raw.v === 2 && Array.isArray(raw.vaults)) {
    return {
      v: 3,
      activeVaultId: raw.activeVaultId ?? null,
      vaults: raw.vaults.map(migrateV2Row),
    };
  }
  throw new Error('Invalid vault data — clear extension storage and set up again');
}

export function assertVaultPayload(p: VaultPayloadV3): void {
  if (p.v !== 3 || !Array.isArray(p.vaults)) {
    throw new Error('Invalid vault data — clear extension storage and set up again');
  }
  for (const v of p.vaults) {
    if ((v as { accountKind?: string }).accountKind === 'zklogin') {
      throw new Error(
        'zkLogin vaults are no longer supported in Chromatika. Create an HD or imported-key vault, or clear extension storage. If you had a zkLogin dev vault, export any needed keys first (not recoverable here).',
      );
    }
  }
}
