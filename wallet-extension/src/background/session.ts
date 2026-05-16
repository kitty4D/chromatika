import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { IkaClient } from '@ika.xyz/sdk';
import type { UserShareEncryptionKeys } from '@ika.xyz/sdk';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { SuiNetworkId } from '@/config/sui';
import type { BaseChain } from '@/background/ika/ika-adapter';
import type { Connection } from '@solana/web3.js';
import type { SolanaIkaGrpcClient } from '@/background/ika/solana-grpc-client';
import type { VaultKdfMeta } from '@/background/vault';

export type CurveKey = 'SECP256K1' | 'ED25519';

/**
 * HD = mnemonic-derived fee payer.
 * importedKey / hardware / dwalletAnchored = material in vault blob (see vault-types).
 * passkey / waap / lazor = primary v1 onboarding paths (see vault-types):
 *  - passkey: sui base, webauthn prf-derived ika seed
 *  - waap   : sui base, waap-signature-or-recovery-words seed
 *  - lazor  : solana base, ika seed via deterministic lazor session key (passkey prf -> ed25519)
 */
export type AccountKind =
  | 'hd'
  | 'importedKey'
  | 'hardware'
  | 'dwalletAnchored'
  | 'passkey'
  | 'waap'
  | 'lazor';

/**
 * per-dWallet metadata. `baseChain` tells signing flows which IkaAdapter to use.
 * - 'sui'     - dWallet is a Sui object (0x... id), fee paid with suiKeypair
 * - 'solana'  - dWallet is a Solana PDA (base58 addr), fee paid with solanaFeePayer
 *               (solana support: awaiting @ika.xyz/sdk Solana release)
 */
export interface DWalletMeta {
  baseChain: BaseChain;
  /** optional parent dWallet id for nested UX (local hint; sync from chain when possible). */
  parentDwalletId?: string;
  dwalletId?: string;
  encryptedUserSecretKeyShareId?: string;
  /**
   * cached `(encryptionKeyIndex, legacy)` tuple + serialized key material that
   * `signMessageSolCore`'s recovery scan matched for this dWallet's on-chain
   * `encryption_key_address`. avoids both the 0..15 × {legacy, post-fix} scan AND the
   * per-sign WASM classgroup keypair regeneration that `fromRootSeedKey` runs.
   *
   * - **`encryptionKeyIndex` + `legacy`** are the diagnostic identifiers (which seed index
   *   was used, whether the curve-byte-0 legacy hash matched). useful for debugging and
   *   for falling back to re-derivation if `serializedB64` is missing or stale.
   * - **`serializedB64`** is the base64-encoded output of
   *   `UserShareEncryptionKeys.toShareEncryptionKeysBytes()`. on subsequent signs we restore
   *   with `fromShareEncryptionKeysBytes` (BCS deserialize, ~5ms) instead of re-running
   *   `fromRootSeedKey*` (WASM classgroup keygen, ~15-20s in MV3 service worker).
   *
   * matters because Solana blockhashes expire in ~60-90s and ika MPC sign cycles run
   * 30-100s; trimming ~17s off every sign by skipping the WASM regen is the difference
   * between fitting inside the blockhash validity window and getting "Blockhash not found"
   * at broadcast.
   */
  signingKeyDerivation?: {
    encryptionKeyIndex: number;
    /** true when the SDK 0.3.x curve-byte=0 derivation produced the match. */
    legacy: boolean;
    /** base64 of `UserShareEncryptionKeys.toShareEncryptionKeysBytes()`. lets us deserialize
     * the matched keys directly without re-running `fromRootSeedKey*`. */
    serializedB64?: string;
  };
  /** base64 of `userPublicOutput` from DKG prep, required for `acceptEncryptedUserShare` after restart */
  dkgUserPublicOutputB64?: string;
  registeredEncryptionKey?: boolean;
  /**
   * ika Solana base only: base64 of full BCS `NetworkSignedAttestation` bytes returned by DKG gRPC.
   * replayed verbatim on every Presign / Sign request (schema >= 0.1.1); validators derive the curve
   * and dWallet identity from this blob. do not truncate.
   */
  dwalletAttestationBytesB64?: string;
  /**
   * ika Solana base only: base64 of raw dWallet public-key bytes (32 for Curve25519, 33 compressed
   * or 65 uncompressed for Secp256k1). used for `PresignForDWallet.dwallet_public_key` and to
   * re-derive the dWallet PDA seeds `(curve_u16_le || public_key)`.
   */
  dwalletPublicKeyB64?: string;
  /**
   * optional encrypted label for this dWallet stored as real Encrypt ciphertexts on Solana
   * devnet. labels chunk across multiple `EUint128` ciphertexts (16 utf-8 bytes per chunk);
   * `ciphertextIdentifierHexes[i]` is the i-th chunk's identifier and the array is ordered
   * (chunk 0 = first 16 bytes, chunk 1 = next 16, etc.). reveal calls `ReadCiphertext` for
   * every chunk, concatenates the value bytes, and trims to `utf8Len` before utf-8 decoding.
   * lab-grade pre-alpha only: the Encrypt program disclaimer says ciphertexts can be
   * plaintext on-chain; never use for real secrets. see `wallet-extension/docs/STATUS.md` and
   * the `encrypt-solana-prealpha` skill. pre-release: schema break vs single-id v1, no
   * migration shim, clear extension storage to re-onboard if you upgrade across this.
   */
  encryptedLabel?: {
    ciphertextIdentifierHexes: string[];
    fheType: number;
    createdAtMs: number;
    programId: string;
    utf8Len: number;
    /**
     * opt-in plaintext cache used by the encrypt-label auto-rebuild flow. when set, a
     * subsequent `getDwalletEncryptedLabelOnChainStatus` returning `'missing'` (typical
     * after an Encrypt devnet wipe) lets `rebuildDwalletLabelAfterDevnetWipe` re-run
     * `createDwalletLabelCiphertext` with this exact plaintext and rotate
     * `ciphertextIdentifierHexes` in place. only populated when the user enables auto
     * rebuild via Settings. lab-grade pre-alpha labels are explicitly NOT for secrets, so
     * locally caching the plaintext is consistent with the existing security boundary
     * (the docs say "never use for real secrets"). toggle storage key:
     * `chromatika_label_auto_rebuild_v1`.
     */
    cachedPlaintext?: string;
  };
}

export interface SessionState {
  /** active dWallet Vault (owner identity) within the encrypted vault blob. */
  activeVaultId: string;
  activeVaultLabel: string;
  activeVaultBaseChain: BaseChain;
  /**
   * non-extractable AES-GCM `CryptoKey` derived once at unlock from the user password.
   * used for in-session re-encrypt (switchVault, dWallet meta saves, share-key updates).
   * replaces the prior plaintext `vaultPassword` so the password string never lives in SW memory.
   */
  vaultKey: CryptoKey;
  /**
   * Argon2id salt + params used to derive `vaultKey`. persisted into the unlock cache so a
   * cold SW restart can re-import the cached key bytes against the same blob.
   */
  vaultKdfMeta: VaultKdfMeta;

  accountKind: AccountKind;
  /** empty when `accountKind !== 'hd'` (no BIP39 phrase for that vault). */
  mnemonic: string;
  /**
   * non-HD secrets mirrored from the vault record for `persistVaultFromSession` round-trip.
   * same trust boundary as `mnemonic` (memory only while unlocked).
   */
  vaultPersistSecrets?: {
    suiPrivateKeyBech32?: string;
    solanaSecretKeyB64?: string;
  };
  /** Sui address for ika cap discovery; defaults to fee payer when unset. */
  dWalletDiscoverySuiAddress?: string;
  /** dWallet-anchored vault: ika object id (0x...) when `accountKind === 'dwalletAnchored'`. */
  anchorDwalletId?: string;
  network: SuiNetworkId;

  // --- Sui base chain ---
  suiKeypair: Ed25519Keypair;
  /**
   * when the fee payer signs Sui PTBs on Ledger (no suiprivkey in vault), WebHID runs in the popup.
   * `suiKeypair` may be a throwaway keypair; use `getSuiFeePayerSuiAddress` / dry-run sender from `feePayerAddress` here.
   */
  suiLedgerFee?: {
    derivationPath: string;
    publicKeyB64: string;
    feePayerAddress: string;
  };
  /** fee payer + owner reads when vault Sui network differs from dWallet Sui. */
  vaultSuiClient: SuiGraphQLClient;
  /** ika PTBs, signing, dWallet discovery: same as `suiClient` when tiers match. */
  suiClient: SuiGraphQLClient;
  ikaClient: IkaClient;

  /**
   * Solana fee payer keypair, derived from mnemonic at m/44'/501'/0'/0' (standard Solana path).
   * set when the active vault uses ika Solana as base chain.
   */
  solanaFeePayer?: import('@solana/web3.js').Keypair;

  /**
   * when ika base is Solana and fees are signed on Ledger (no `solanaSecretKeyB64` in vault).
   * WebHID runs in the hardware popup; gRPC + `approve_message` enqueue `solanaTx` / `solanaOffchain`.
   */
  solanaLedgerFee?: {
    derivationPath: string;
    feePayerPubkeyB58: string;
  };

  /**
   * when the Solana fee payer is a phone running an MWA-compliant wallet (Phantom Mobile etc.).
   * the popup either fires an Android intent (`transport: 'local'`) or runs the remote
   * reflector + QR pairing path (`transport: 'remote'`). for remote, `authToken` skips QR
   * rescan on subsequent signs by passing it through `wallet.authorize({ auth_token })`.
   */
  solanaMwaAccount?: {
    address: string;
    derivationPath: string;
    transport: 'local' | 'remote';
    authToken?: string;
    reflectorHost?: string;
  };

  /**
   * when the Solana fee payer / chain key is a phone wallet paired over WalletConnect v2.
   * mutually exclusive with `solanaMwaAccount` on a single session. the signer popup uses
   * `sessionTopic` to route every subsequent `solana_signTransaction` / `solana_signMessage`
   * through the persisted relay session: if the wallet has revoked the session the request
   * rejects and the popup surfaces a needs-repair message (analog of MWA's revoked auth_token).
   */
  solanaWcAccount?: {
    /** base58 Solana pubkey the wallet authorized at pair time. */
    address: string;
    /** opaque relay topic returned by `signClient.connect().approval()`. */
    sessionTopic: string;
    /** CAIP-2 chain id frozen at pair time (e.g. `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). */
    chainId: string;
  };

  /**
   * when the Bitcoin fee payer / owner key is stored on a Ledger device.
   * WebHID runs in the hardware popup; `btcTx` kind carries the full PSBT.
   */
  bitcoinLedgerFee?: {
    derivationPath: string;
    address: string;
  };

  /** ika Solana base: vault owner / fee payer RPC. */
  solanaConnection?: Connection;
  /**
   * active-network registry id paired with `solanaConnection` (e.g. `'sol-devnet'`,
   * `'sol-mainnet'`). captured at session build so sign sites can derive the
   * matching WC CAIP-2 chain id without re-reading chrome.storage. set when
   * `solanaConnection` is set; undefined for non-Solana-base vaults.
   */
  solanaNetworkId?: string;
  /** dWallet-facing Solana RPC (portfolio rails, native send, discovery reads). */
  dwalletSolanaConnection: Connection;

  /** gRPC client for ika pre-alpha DWalletService (Solana base). */
  solanaIkaGrpc?: SolanaIkaGrpcClient;

  // --- shared across base chains ---
  ikaShareKeys: Record<CurveKey, UserShareEncryptionKeys>;
  /** serialized UserShareEncryptionKeys bytes (base64), persisted in vault */
  ikaShareKeysB64: Partial<Record<CurveKey, string>>;
  /**
   * one dWallet per curve per base chain.
   * key = CurveKey; value includes `baseChain` so signing can route to the right adapter.
   * for multi-dWallet persona support (Phase N), this becomes an array.
   */
  dwalletMeta: Partial<Record<CurveKey, DWalletMeta>>;
}

let session: SessionState | null = null;

export function getSession(): SessionState | null {
  return session;
}

export function setSession(next: SessionState | null): void {
  session = next;
}

export function isUnlocked(): boolean {
  return session !== null;
}
