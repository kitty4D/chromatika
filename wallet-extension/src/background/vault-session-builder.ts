/**
 * builds a `SessionState` from a `VaultRecord` + unlocked `VaultCredential`. extracted from
 * `wallet-service.ts` because this is the meatiest "pure transform" in that file (~600 lines)
 * and it kept growing - every new onboarding method (passkey, waap, lazor, hardware variants)
 * adds a branch in `feeMaterialFromVaultRecord` and `sessionStateFromRecord`. owning it in its
 * own module keeps wallet-service focused on lifecycle (create/import/unlock/switch).
 *
 * the public surface is just `sessionStateFromRecord`. `feeMaterialFromVaultRecord` is an
 * internal helper (resolving the in-memory fee keypair / Solana keypair material the session
 * holds; only `sessionStateFromRecord` calls it).
 *
 * the function is pure-ish: it does NOT mutate global session state, it CONSUMES a record +
 * credential and CONSTRUCTS a new SessionState. unlock paths in wallet-service.ts then
 * `setSession(...)` the result.
 */

import { getNetworkConfig, IkaClient } from '@ika.xyz/sdk';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { deriveSolanaKeypair, deriveSuiKeypair } from '@/background/keyring/hd';
import { getIkaFeeSettings } from '@/background/ika/fee-settings';
import { getHardwareAccountById } from '@/background/hardware/accounts';
import { solanaClusterLabelForNetworkId, wcSolanaChainIdForCluster } from '@/config/wc';
import { resolveAnchoredDiscoverySuiAddress } from '@/background/ika/anchored-discovery-address';
import {
  SolanaIkaGrpcClient,
  SOLANA_PREALPHA_GRPC_URL,
  solanaGrpcFeeFromKeypair,
} from '@/background/ika/solana-grpc-client';
import { enqueueHardwareSign } from '@/background/hardware/pending-queue';
import { hexNo0xToUint8, uint8ToHexNo0x } from '@/background/util/bytes-hex';
import { createSuiGraphQLClientFromRegistryNetworkId } from '@/background/sui-client';
import { type SessionState } from '@/background/session';
import { registrySuiIdToSuiNetworkId } from '@/config/sui';
import { loadDwalletMeta } from '@/background/storage-meta';
import {
  ensureTierNetworkSettingsForVault,
  getDwalletNetworkSettings,
  getVaultNetworkSettings,
  normalizeSolanaIkaVaultNetworksIfNeeded,
  resolveSolanaRpcUrl,
  syncLegacyActiveNetworksFromDwallet,
} from '@/background/network/tier-network-settings';
import { type VaultRecord } from '@/background/vault-types';
import { type VaultCredential } from '@/background/vault-store';
import { mergeDwalletMeta } from '@/background/dwallet-meta-service';
import {
  buildIkaShareKeys,
  makeSeedFromSolanaKeypair,
  makeSeedFromSuiKeypair,
  solanaKeypairFromB64,
} from '@/background/vault-keys';

/**
 * resolve the in-memory fee material for a vault record. branches on `baseChain`:
 *
 * - **Sui base** still requires a Sui Ed25519 keypair (the fee payer for ika PTBs). the Solana
 *   field is unused.
 * - **Solana base** requires a Solana keypair (the fee payer for ika gRPC + `ApprovalProof::Solana`)
 *   and **does not** require a Sui privkey. `suiKeypair` is set to a throwaway generated key,
 *   nothing on the Solana ika base path uses it. Sui-base call sites read from
 *   `s.suiKeypair` directly; those should never run when `activeVaultBaseChain === 'solana'`.
 */
async function feeMaterialFromVaultRecord(record: VaultRecord): Promise<{
  suiKeypair: Ed25519Keypair;
  solanaFeePayer?: Keypair;
  mnemonic: string;
  vaultPersistSecrets: SessionState['vaultPersistSecrets'];
}> {
  // ika fee mode honored at unlock: if the user has flipped a Solana hardware vault to
  // `seeker_direct` after the vault was created, the in-extension keypair may still live in
  // the encrypted blob (we keep it so the user can drain residual balance later from settings).
  // don't load it into the session - that would silently route gRPC fees through it instead of
  // through the phone, contradicting the user's explicit choice.
  let suppressInExtensionFeePayer = false;
  if (record.accountKind === 'hardware' && record.baseChain === 'solana') {
    try {
      const settings = await getIkaFeeSettings(record.id);
      if (settings.mode === 'seeker_direct') suppressInExtensionFeePayer = true;
    } catch {
      // settings read failed - default to using the keypair (the established behavior).
    }
  }

  if (record.accountKind === 'hd') {
    const idx = record.accountIndex ?? 0;
    return {
      suiKeypair:
        record.baseChain === 'solana' ? Ed25519Keypair.generate() : deriveSuiKeypair(record.mnemonic, idx),
      solanaFeePayer: record.baseChain === 'solana' ? deriveSolanaKeypair(record.mnemonic, idx) : undefined,
      mnemonic: record.mnemonic,
      vaultPersistSecrets: undefined,
    };
  }

  const persist: NonNullable<SessionState['vaultPersistSecrets']> = {};

  if (record.accountKind === 'importedKey') {
    if (record.baseChain === 'solana') {
      const sB64 = record.solanaSecretKeyB64?.trim();
      if (!sB64) {
        throw new Error('Solana ika vault needs base64 Solana secret key (64 bytes) for the fee payer');
      }
      const solanaFeePayer = solanaKeypairFromB64(sB64);
      persist.solanaSecretKeyB64 = sB64;
      return {
        suiKeypair: Ed25519Keypair.generate(),
        solanaFeePayer,
        mnemonic: '',
        vaultPersistSecrets: persist,
      };
    }
    const suiBech = record.suiPrivateKeyBech32?.trim();
    if (!suiBech) throw new Error('This vault needs a Sui Ed25519 private key (suiprivkey…) for ika fee payer');
    persist.suiPrivateKeyBech32 = suiBech;
    const suiKeypair = Ed25519Keypair.fromSecretKey(suiBech);
    return { suiKeypair, mnemonic: '', vaultPersistSecrets: persist };
  }

  if (record.accountKind === 'hardware') {
    const hw = await getHardwareAccountById(record.hardwareAccountId);
    if (!hw) throw new Error('Linked hardware account not found');
    const suiBech = record.suiPrivateKeyBech32?.trim();
    const ledgerPkB64 =
      'ledgerFeePayerEd25519PublicKeyB64' in record
        ? record.ledgerFeePayerEd25519PublicKeyB64?.trim()
        : undefined;
    if (suiBech) {
      persist.suiPrivateKeyBech32 = suiBech;
      const suiKeypair = Ed25519Keypair.fromSecretKey(suiBech);
      let solanaFeePayer: Keypair | undefined;
      if (record.baseChain === 'solana') {
        const sB64 = record.solanaSecretKeyB64?.trim();
        if (!sB64) throw new Error('Solana ika hardware vault needs solanaSecretKeyB64');
        solanaFeePayer = solanaKeypairFromB64(sB64);
        persist.solanaSecretKeyB64 = sB64;
      }
      return { suiKeypair, solanaFeePayer, mnemonic: '', vaultPersistSecrets: persist };
    }
    if (
      ledgerPkB64
      && hw.vendor === 'ledger'
      && hw.chain === 'sui'
      && record.ikaShareKeysB64.SECP256K1
      && record.ikaShareKeysB64.ED25519
    ) {
      const pk = new Ed25519PublicKey(ledgerPkB64);
      if (pk.toSuiAddress() !== hw.address) {
        throw new Error('ledgerFeePayerEd25519PublicKeyB64 does not match linked Ledger Sui hardware address');
      }
      let solanaFeePayer: Keypair | undefined;
      if (record.baseChain === 'solana') {
        const sB64 = record.solanaSecretKeyB64?.trim();
        if (sB64) {
          solanaFeePayer = solanaKeypairFromB64(sB64);
          persist.solanaSecretKeyB64 = sB64;
        }
      }
      return {
        suiKeypair: Ed25519Keypair.generate(),
        solanaFeePayer,
        mnemonic: '',
        vaultPersistSecrets: Object.keys(persist).length ? persist : undefined,
      };
    }
    const solLedgerPk =
      'ledgerFeePayerSolPubkeyB58' in record ? record.ledgerFeePayerSolPubkeyB58?.trim() : undefined;
    // MWA + Solana / WC + Solana: a local in-extension keypair pays ika gRPC `approve_message`
    // fees. since the Seeker-signature-derived seed landed, the canonical field is
    // `ikaGrpcFeePayerSolSecretKeyB64`. older dev installs (pre-Seeker-restore) wrote the
    // blended `ikaEncryptionOnlySolSecretKeyB64` instead; we still read it as a fallback so
    // those vaults can sign, but no new code writes to that field.
    // the phone's wallet address (`solLedgerPk` / `hw.address`) is the user-facing chain
    // key - it never reaches Chromatika and is NOT loaded as `solanaFeePayer`.
    const grpcFeePayerB64 =
      'ikaGrpcFeePayerSolSecretKeyB64' in record
        ? record.ikaGrpcFeePayerSolSecretKeyB64?.trim()
        : undefined;
    const legacyIkaEncOnlyB64 =
      'ikaEncryptionOnlySolSecretKeyB64' in record
        ? record.ikaEncryptionOnlySolSecretKeyB64?.trim()
        : undefined;
    const phoneFeePayerB64 = grpcFeePayerB64 ?? legacyIkaEncOnlyB64;
    if (
      record.baseChain === 'solana'
      && (hw.vendor === 'mwa' || hw.vendor === 'walletconnect')
      && hw.chain === 'solana'
      && solLedgerPk
      && hw.address === solLedgerPk
      && phoneFeePayerB64
      && !suppressInExtensionFeePayer
      && record.ikaShareKeysB64.SECP256K1
      && record.ikaShareKeysB64.ED25519
    ) {
      if (!grpcFeePayerB64 && legacyIkaEncOnlyB64) {
        // OK to log - pre-release dev installs only; surfaces the migration prompt to clear storage.
        console.warn(
          '[chromatika] vault still uses deprecated ikaEncryptionOnlySolSecretKeyB64 for ika gRPC fees. Restore on a different device may not match this dWallet - re-onboard with Seeker-signature derivation when convenient.',
        );
      }
      const solanaFeePayer = solanaKeypairFromB64(phoneFeePayerB64);
      // not added to `vaultPersistSecrets`, fee-payer field is record-level, not a generic
      // re-encrypt secret. unlock paths read it directly from the record.
      return {
        suiKeypair: Ed25519Keypair.generate(),
        solanaFeePayer,
        mnemonic: '',
        vaultPersistSecrets: undefined,
      };
    }
    if (
      record.baseChain === 'solana'
      && solLedgerPk
      && (hw.vendor === 'ledger' || hw.vendor === 'trezor' || hw.vendor === 'mwa' || hw.vendor === 'walletconnect')
      && hw.chain === 'solana'
      && hw.address === solLedgerPk
      && record.ikaShareKeysB64.SECP256K1
      && record.ikaShareKeysB64.ED25519
    ) {
      return {
        suiKeypair: Ed25519Keypair.generate(),
        solanaFeePayer: undefined,
        mnemonic: '',
        vaultPersistSecrets: undefined,
      };
    }
    throw new Error(
      'Hardware vault needs suiPrivateKeyBech32 for ika fees, or Ledger Sui / Solana fee fields with both ika curves and a matching hardware account',
    );
  }

  if (record.accountKind === 'dwalletAnchored') {
    if (record.baseChain === 'solana') {
      const sB64 = record.solanaSecretKeyB64?.trim();
      if (!sB64) throw new Error('Solana-base anchored vault needs solanaSecretKeyB64');
      const solanaFeePayer = solanaKeypairFromB64(sB64);
      persist.solanaSecretKeyB64 = sB64;
      return {
        suiKeypair: Ed25519Keypair.generate(),
        solanaFeePayer,
        mnemonic: '',
        vaultPersistSecrets: persist,
      };
    }
    const suiBech = record.suiPrivateKeyBech32?.trim();
    if (!suiBech) throw new Error('dWallet-anchored vault needs suiPrivateKeyBech32 for ika fee payer');
    persist.suiPrivateKeyBech32 = suiBech;
    const suiKeypair = Ed25519Keypair.fromSecretKey(suiBech);
    return { suiKeypair, mnemonic: '', vaultPersistSecrets: persist };
  }

  if (record.accountKind === 'passkey') {
    // passkey signs Sui PTBs in a popup (`?passkeysign=ID`); the SW never holds a hot keypair.
    // ika share keys are already populated at vault create from the PRF-derived seed, so the
    // throwaway suiKeypair here is never used for actual signing, same pattern as the
    // ledger-sui-only fee branch above.
    if (!record.ikaShareKeysB64.SECP256K1 || !record.ikaShareKeysB64.ED25519) {
      throw new Error(
        'passkey vault is missing ika UserShareEncryptionKeys for one or more curves - re-onboard with the same passkey or restore from a recovery code.',
      );
    }
    return {
      suiKeypair: Ed25519Keypair.generate(),
      mnemonic: '',
      vaultPersistSecrets: undefined,
    };
  }

  if (record.accountKind === 'waap') {
    // waap signs Sui PTBs in side-panel + popup contexts via `@human.tech/waap-sdk`. the SW
    // never holds the user's secret material, waap's sovereign + security shares live in
    // their human network / TEE. ika share keys derive at vault-create time from the
    // determinism-probe signature (or recovery words), so the throwaway suiKeypair here is
    // a placeholder used only for the cached session shape. mirrors the passkey branch above.
    if (!record.ikaShareKeysB64.SECP256K1 || !record.ikaShareKeysB64.ED25519) {
      throw new Error(
        'waap vault is missing ika UserShareEncryptionKeys for one or more curves - re-onboard with the same waap login or restore from a recovery code.',
      );
    }
    return {
      suiKeypair: Ed25519Keypair.generate(),
      mnemonic: '',
      vaultPersistSecrets: undefined,
    };
  }

  if (record.accountKind === 'lazor') {
    // lazor vault: Solana-base ika dWallet seeded by the user's 24-word recovery phrase.
    // the in-extension fee payer keypair (also derived from the phrase via SLIP10) signs
    // ika `approve_message` gRPC fees + serves as the seed source for `ikaRootSeedFromSolanaKeypair`
    // at unlock-time `buildIkaShareKeys`. user-driven Solana sends route through the Lazor
    // portal in a future signing slice; the throwaway suiKeypair here is a placeholder.
    const sB64 = record.lazorIkaFeePayerSolSecretKeyB64?.trim();
    if (!sB64) {
      throw new Error(
        'lazor vault is missing the ika fee payer keypair - re-onboard with the same recovery phrase to rebuild it.',
      );
    }
    if (!record.ikaShareKeysB64.SECP256K1 || !record.ikaShareKeysB64.ED25519) {
      throw new Error(
        'lazor vault is missing ika UserShareEncryptionKeys for one or more curves - re-onboard with the same recovery phrase.',
      );
    }
    const solanaFeePayer = solanaKeypairFromB64(sB64);
    persist.solanaSecretKeyB64 = sB64;
    return {
      suiKeypair: Ed25519Keypair.generate(),
      solanaFeePayer,
      mnemonic: '',
      vaultPersistSecrets: persist,
    };
  }

  throw new Error('Unsupported vault kind');
}

export async function sessionStateFromRecord(
  record: VaultRecord,
  cred: VaultCredential,
): Promise<SessionState> {
  await ensureTierNetworkSettingsForVault(record);
  await normalizeSolanaIkaVaultNetworksIfNeeded(record);
  const vaultNet = await getVaultNetworkSettings(record.id, record);
  const dwalletNet = await getDwalletNetworkSettings(record.id, record);
  await syncLegacyActiveNetworksFromDwallet(dwalletNet);

  const vaultSuiClient = createSuiGraphQLClientFromRegistryNetworkId(vaultNet.suiNetworkId);
  const suiClient =
    vaultNet.suiNetworkId === dwalletNet.suiNetworkId
      ? vaultSuiClient
      : createSuiGraphQLClientFromRegistryNetworkId(dwalletNet.suiNetworkId);

  const fee = await feeMaterialFromVaultRecord(record);
  const hardwareLedgerFeeOnly =
    record.accountKind === 'hardware'
    && 'ledgerFeePayerEd25519PublicKeyB64' in record
    && Boolean(record.ledgerFeePayerEd25519PublicKeyB64?.trim())
    && !record.suiPrivateKeyBech32?.trim();
  // pick the seed source based on baseChain. for Sui-base derive from the Sui fee payer
  // (matches ika CLI `resolve_seed`). for Solana-base derive from the Solana fee payer if we have
  // one. hardware-ledger-only paths (Sui or Solana) have no hot key to derive from, they MUST
  // already have both ika curves stored in the vault record (validated upstream when adding).
  const hardwareSolLedgerFeeOnlyEarly =
    record.accountKind === 'hardware'
    && record.baseChain === 'solana'
    && !record.solanaSecretKeyB64?.trim()
    && 'ledgerFeePayerSolPubkeyB58' in record
    && Boolean(record.ledgerFeePayerSolPubkeyB58?.trim());
  let makeSeed: (() => Uint8Array) | null = null;
  if (!hardwareLedgerFeeOnly && !hardwareSolLedgerFeeOnlyEarly) {
    if (record.baseChain === 'solana') {
      if (fee.solanaFeePayer) makeSeed = makeSeedFromSolanaKeypair(fee.solanaFeePayer);
    } else {
      makeSeed = makeSeedFromSuiKeypair(fee.suiKeypair);
    }
  }
  const { ikaShareKeys, ikaShareKeysB64 } = await buildIkaShareKeys(
    makeSeed,
    record.ikaShareKeysB64,
  );

  const hwAcctEarly = hardwareLedgerFeeOnly ? await getHardwareAccountById(record.hardwareAccountId) : null;
  const feePayerSuiAddressForReads =
    hardwareLedgerFeeOnly && hwAcctEarly?.chain === 'sui'
      ? hwAcctEarly.address
      : fee.suiKeypair.toSuiAddress();

  const dwalletSui = registrySuiIdToSuiNetworkId(dwalletNet.suiNetworkId);
  const ikaClient = new IkaClient({
    suiClient,
    config: getNetworkConfig(dwalletSui),
    cache: true,
  });

  let dWalletDiscoverySuiAddress: string | undefined;
  if (record.accountKind === 'dwalletAnchored' && record.baseChain === 'sui') {
    dWalletDiscoverySuiAddress = await resolveAnchoredDiscoverySuiAddress(
      ikaClient,
      record.anchorDwalletId,
      feePayerSuiAddressForReads,
    );
  } else if (record.accountKind === 'waap' && record.baseChain === 'sui') {
    // WaaP vaults: the SW's `suiKeypair` is a throwaway placeholder (regenerated on every
    // unlock; see the `accountKind === 'waap'` branch in `buildSuiKeypairFromRecord`). The
    // user's REAL on-chain identity is `waapSuiAddress` - that's the address WaaP returned
    // at login and the one that owns any dWallet caps the user has created. Without this
    // override, the dWallet discovery scan would look at the throwaway address and find
    // nothing, breaking re-onboard / restore-via-WaaP. Setting it here is what makes a
    // re-paired WaaP login on a fresh chromatika install adopt the user's existing dWallet
    // instead of running a fresh DKG.
    dWalletDiscoverySuiAddress = record.waapSuiAddress;
  }

  const storedMeta = await loadDwalletMeta(record.id);

  const dwalletSolanaConnection = new Connection(
    resolveSolanaRpcUrl(dwalletNet.solana),
    dwalletNet.solana.commitment,
  );
  const solanaFeePayer = fee.solanaFeePayer;
  const vaultSolRpc = resolveSolanaRpcUrl(vaultNet.solana);
  const sameSol =
    vaultSolRpc === resolveSolanaRpcUrl(dwalletNet.solana) &&
    vaultNet.solana.commitment === dwalletNet.solana.commitment;
  const solanaConnection =
    record.baseChain === 'solana'
      ? sameSol
        ? dwalletSolanaConnection
        : new Connection(vaultSolRpc, vaultNet.solana.commitment)
      : undefined;
  const solanaNetworkId = record.baseChain === 'solana' ? vaultNet.solana.solNetworkId : undefined;

  const hardwareSolLedgerFeeOnly =
    record.accountKind === 'hardware'
    && record.baseChain === 'solana'
    && !record.solanaSecretKeyB64?.trim()
    && 'ledgerFeePayerSolPubkeyB58' in record
    && Boolean(record.ledgerFeePayerSolPubkeyB58?.trim());

  const hwSolEarly = hardwareSolLedgerFeeOnly ? await getHardwareAccountById(record.hardwareAccountId) : null;

  // Ledger and Trezor both route through enqueueHardwareSign (vendor field distinguishes them).
  // MWA routes through its own solanaMwaAccount session field.
  const solanaLedgerFee =
    hardwareSolLedgerFeeOnly
    && hwSolEarly
    && (hwSolEarly.vendor === 'ledger' || hwSolEarly.vendor === 'trezor')
    && hwSolEarly.chain === 'solana'
    && record.ledgerFeePayerSolPubkeyB58?.trim() === hwSolEarly.address
      ? {
          derivationPath: hwSolEarly.derivationPath,
          feePayerPubkeyB58: hwSolEarly.address,
        }
      : undefined;

  const solanaMwaAccount =
    hardwareSolLedgerFeeOnly
    && hwSolEarly
    && hwSolEarly.vendor === 'mwa'
    && hwSolEarly.chain === 'solana'
    && record.ledgerFeePayerSolPubkeyB58?.trim() === hwSolEarly.address
      ? {
          address: hwSolEarly.address,
          derivationPath: hwSolEarly.derivationPath,
          transport: ('mwaTransport' in record && record.mwaTransport === 'remote'
            ? 'remote'
            : 'local') as 'local' | 'remote',
          ...(('mwaAuthToken' in record && typeof record.mwaAuthToken === 'string' && record.mwaAuthToken.trim())
            ? { authToken: record.mwaAuthToken }
            : {}),
          ...(('mwaReflectorHost' in record && typeof record.mwaReflectorHost === 'string' && record.mwaReflectorHost.trim())
            ? { reflectorHost: record.mwaReflectorHost }
            : {}),
        }
      : undefined;

  // WalletConnect v2 sibling of solanaMwaAccount. mutually exclusive on a single record:
  // a hardware vault is either MWA or WC, not both. WC has no derivationPath (WC sessions
  // have no BIP44 concept), no auth_token (the relay sessionTopic is the equivalent), and
  // chainId is frozen at pair time so the popup sends signs on the same CAIP-2 namespace.
  const solanaWcAccount =
    hardwareSolLedgerFeeOnly
    && hwSolEarly
    && hwSolEarly.vendor === 'walletconnect'
    && hwSolEarly.chain === 'solana'
    && record.accountKind === 'hardware'
    && record.walletconnect
    && record.ledgerFeePayerSolPubkeyB58?.trim() === hwSolEarly.address
    && record.walletconnect.accountAddress === hwSolEarly.address
      ? {
          address: hwSolEarly.address,
          sessionTopic: record.walletconnect.sessionTopic,
          chainId: record.walletconnect.chainId,
        }
      : undefined;

  let solanaIkaGrpc: SolanaIkaGrpcClient | undefined;
  if (record.baseChain === 'solana') {
    if (solanaFeePayer) {
      solanaIkaGrpc = new SolanaIkaGrpcClient(
        SOLANA_PREALPHA_GRPC_URL,
        solanaGrpcFeeFromKeypair(solanaFeePayer),
      );
    } else if (solanaLedgerFee) {
      // Ledger or Trezor: both use enqueueHardwareSign; vendor comes from the hw account
      const feePk = new PublicKey(solanaLedgerFee.feePayerPubkeyB58);
      const hwVendor = hwSolEarly?.vendor ?? 'ledger';
      const hwPath = solanaLedgerFee.derivationPath;
      solanaIkaGrpc = new SolanaIkaGrpcClient(SOLANA_PREALPHA_GRPC_URL, {
        publicKey: feePk,
        signEd25519Payload: async (payload) => {
          const sigHex = await enqueueHardwareSign({
            vendor: hwVendor as 'ledger' | 'trezor',
            chain: 'solana',
            derivationPath: hwPath,
            payloadHex: uint8ToHexNo0x(payload),
            kind: 'solanaOffchain',
          });
          const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
          return hexNo0xToUint8(digits);
        },
      });
    } else if (solanaMwaAccount) {
      const feePk = new PublicKey(solanaMwaAccount.address);
      const mwaPath = solanaMwaAccount.derivationPath;
      const mwaTransport = solanaMwaAccount.transport;
      const mwaAuthToken = solanaMwaAccount.authToken;
      const mwaReflectorHost = solanaMwaAccount.reflectorHost;
      const cluster = solanaClusterLabelForNetworkId(solanaNetworkId);
      solanaIkaGrpc = new SolanaIkaGrpcClient(SOLANA_PREALPHA_GRPC_URL, {
        publicKey: feePk,
        signEd25519Payload: async (payload) => {
          const sigHex = await enqueueHardwareSign({
            vendor: 'mwa',
            chain: 'solana',
            derivationPath: mwaPath,
            payloadHex: uint8ToHexNo0x(payload),
            kind: 'solanaOffchain',
            mwaTransport,
            ...(mwaAuthToken ? { mwaAuthToken } : {}),
            ...(mwaReflectorHost ? { mwaReflectorHost } : {}),
            solanaCluster: cluster,
          });
          const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
          return hexNo0xToUint8(digits);
        },
      });
    } else if (solanaWcAccount) {
      // WC has no derivationPath concept, pass a logical label so the type stays happy
      // and the popup has something to display in the "type" row of the sign sheet.
      // derive `wcChainId` from the active Solana cluster (not the pair-time-frozen
      // record value) so the wallet's pre-sign sanity check sees the right cluster -
      // pair-time chainId is mainnet because that's what Phantom-class wallets always
      // bind their account to, but the actual broadcast may target devnet (ika pre-alpha).
      const feePk = new PublicKey(solanaWcAccount.address);
      const wcSessionTopic = solanaWcAccount.sessionTopic;
      const wcChainId = wcSolanaChainIdForCluster(solanaNetworkId);
      const wcAccountAddress = solanaWcAccount.address;
      const cluster = solanaClusterLabelForNetworkId(solanaNetworkId);
      solanaIkaGrpc = new SolanaIkaGrpcClient(SOLANA_PREALPHA_GRPC_URL, {
        publicKey: feePk,
        signEd25519Payload: async (payload) => {
          const sigHex = await enqueueHardwareSign({
            vendor: 'walletconnect',
            chain: 'solana',
            derivationPath: 'wc:solana',
            payloadHex: uint8ToHexNo0x(payload),
            kind: 'solanaOffchain',
            wcSessionTopic,
            wcChainId,
            wcAccountAddress,
            solanaCluster: cluster,
          });
          const digits = sigHex.startsWith('0x') ? sigHex.slice(2) : sigHex;
          return hexNo0xToUint8(digits);
        },
      });
    }
  }

  const hwAcct = hwAcctEarly;
  const suiLedgerFee =
    hardwareLedgerFeeOnly
    && hwAcct
    && hwAcct.vendor === 'ledger'
    && hwAcct.chain === 'sui'
    && 'ledgerFeePayerEd25519PublicKeyB64' in record
    && record.ledgerFeePayerEd25519PublicKeyB64?.trim()
      ? {
          derivationPath: hwAcct.derivationPath,
          publicKeyB64: record.ledgerFeePayerEd25519PublicKeyB64!.trim(),
          feePayerAddress: hwAcct.address,
        }
      : undefined;

  // Bitcoin Ledger fee: hardware vault with a Bitcoin chain Ledger account.
  const hardwareBtcLedgerFeeOnly =
    record.accountKind === 'hardware'
    && !record.suiPrivateKeyBech32?.trim();
  const bitcoinLedgerFee =
    hardwareBtcLedgerFeeOnly
    && hwAcct
    && hwAcct.vendor === 'ledger'
    && hwAcct.chain === 'bitcoin'
      ? { derivationPath: hwAcct.derivationPath, address: hwAcct.address }
      : undefined;

  return {
    activeVaultId: record.id,
    activeVaultLabel: record.label,
    activeVaultBaseChain: record.baseChain,
    vaultKey: cred.key,
    vaultKdfMeta: cred.kdfMeta,
    accountKind: record.accountKind,
    mnemonic: fee.mnemonic,
    vaultPersistSecrets: fee.vaultPersistSecrets,
    dWalletDiscoverySuiAddress,
    anchorDwalletId: record.accountKind === 'dwalletAnchored' ? record.anchorDwalletId : undefined,
    network: dwalletSui,
    suiKeypair: fee.suiKeypair,
    suiLedgerFee,
    vaultSuiClient,
    suiClient,
    ikaClient,
    ikaShareKeys,
    ikaShareKeysB64,
    dwalletMeta: mergeDwalletMeta(record.dwalletMeta, storedMeta, record.baseChain),
    solanaFeePayer,
    solanaLedgerFee,
    solanaMwaAccount,
    solanaWcAccount,
    solanaConnection,
    solanaNetworkId,
    dwalletSolanaConnection,
    solanaIkaGrpc,
    bitcoinLedgerFee,
  };
}
