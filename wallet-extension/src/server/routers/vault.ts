import { z } from 'zod';
import { captureException } from '@/background/analytics/sentry';
import { publicProcedure } from '../trpc';
import {
  addDwalletAnchoredVault,
  addHardwareVault,
  addLazorVault,
  addPasskeyVault,
  addVault,
  addVaultImportedFromPrivateKey,
  addWaapVault,
  createInitialHardwareVault,
  createLazorVault,
  createPasskeyVault,
  createVault,
  createWaapVault,
  ensureUnlockedSessionFromCache,
  generateSetupMnemonic,
  getActiveVaultId,
  getLockState,
  getMnemonicForCrossChainReuse,
  importVault,
  importVaultFromSuiPrivateKey,
  listVaultEnvelopes,
  listVaultSummaries,
  lockWallet,
  persistVaultFromSession,
  removeVault,
  renameVault,
  switchVault,
  unlockVault,
  unlockVaultByPasskey,
  unlockVaultByRecoveryWords,
  unlockVaultByWalletSignature,
  walletExists,
} from '@/background/wallet-service';
import { getTrpcBalanceSummary } from '@/background/balances';
import { getSession } from '@/background/session';
import { getActiveTabContext } from '@/background/browser-tab-context';
import {
  getAptosAddress,
  getAptosNetworkInfoForDapp,
} from '@/background/chains/aptos';
import { getEvmAddress } from '@/background/chains/evm';
import { chainAddressesForDwalletId } from '@/background/chains/dwallet-derived-addresses';
import { broadcastToTabs } from '@/background/broadcast';
import { graphqlUrlForNetwork } from '@/config/sui';
import { findEvmNetwork } from '@/config/networks';
import { getActiveNetworks } from '@/background/network/active-network';
import { getCustomNetworks } from '@/background/network/custom-networks';
import { getPermission } from '@/background/dapp-permissions';
import { clearLockSchedule, scheduleLock } from '@/background/lock-manager';
import {
  getGraphqlPaginationDebugSnapshot,
  resetGraphqlPaginationDebug,
} from '@/background/sui-graphql-pagination-debug';
import {
  clearVaultTotalCache as clearVaultTotalCacheStorage,
  isStaleSnapshot,
} from '@/background/services/vault-total-cache';
import {
  computeVaultTotal,
  getCachedVaultTotal,
  refreshVaultTotalsBatch,
} from '@/background/services/vault-total-value';

/** push the active EVM/Aptos addresses to dapp tabs after a vault lifecycle event. */
async function pushDappAccountAndAptosHints(): Promise<void> {
  try {
    const addr = await getEvmAddress();
    broadcastToTabs('accountsChanged', [addr]);
  } catch {
    broadcastToTabs('accountsChanged', []);
  }
  try {
    const aptAddr = await getAptosAddress();
    broadcastToTabs('aptosAccountChange', { address: aptAddr });
  } catch {
    broadcastToTabs('aptosAccountChange', null);
  }
  try {
    const net = await getAptosNetworkInfoForDapp();
    broadcastToTabs('aptosNetworkChange', net);
  } catch {
    /* ignore */
  }
}

export const vaultProcedures = {
  ping: publicProcedure.query(() => ({ ok: true as const, t: Date.now() })),

  /**
   * debug: vault + `IkaClient` + nft / kiosk / activity / SuiNS all ride the single
   * vault `SuiGraphQLClient`. no JSON-RPC surface area left in the wallet.
   */
  ikaTransportDebug: publicProcedure.query(() => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    return {
      suiGraphqlUrl: graphqlUrlForNetwork(s.network),
      vaultNetwork: s.network,
      ikaCoordinatorObjectId: s.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID,
      ikaSystemObjectId: s.ikaClient.ikaConfig.objects.ikaSystemObject.objectID,
      ikaDwallet2pcMpcPackage: s.ikaClient.ikaConfig.packages.ikaDwallet2pcMpcPackage,
    };
  }),

  /** dev: last `getDynamicFields` pages + per-parent cycle hints (requires pagination debug fetch). */
  graphqlPaginationDebugSnapshot: publicProcedure.query(() => getGraphqlPaginationDebugSnapshot()),

  graphqlPaginationDebugReset: publicProcedure.mutation(() => {
    resetGraphqlPaginationDebug();
    return { ok: true as const };
  }),

  walletExists: publicProcedure.query(() => walletExists()),

  /** cheap: entropy + bip39 only. use before showing backup; persist with `createVault` / `addVault` after user confirms. */
  generateSetupMnemonic: publicProcedure
    .input(z.object({ wordCount: z.union([z.literal(12), z.literal(24)]).optional() }))
    .query(({ input }) => ({ mnemonic: generateSetupMnemonic(input.wordCount ?? 12) })),

  createVault: publicProcedure
    .input(z.object({
      password: z.string().min(8),
      mnemonic: z.string().optional(),
      accountIndex: z.number().int().min(0).max(50).optional(),
      label: z.string().optional(),
    }))
    .mutation(({ input }) => createVault(input.password, input.mnemonic, input.accountIndex, input.label)),

  importVault: publicProcedure
    .input(z.object({
      password: z.string().min(8),
      mnemonic: z.string().min(1),
      accountIndex: z.number().int().min(0).max(50).optional(),
      label: z.string().optional(),
    }))
    .mutation(({ input }) => importVault(input.password, input.mnemonic, input.accountIndex, input.label)),

  /**
   * first-vault hardware path (fresh install). phase 1 covers MWA-Solana only, Ledger / Trezor
   * first-vault is deferred. the hardware account row must exist already (SeekerConnect /
   * pairMwaForHardwareVault writes it during pairing); the `ikaUskSignatureB64` is captured in
   * the same pairing step so the ika seed derives deterministically and Seeker-only restore works.
   */
  createVaultHardware: publicProcedure
    .input(
      z.object({
        password: z.string().min(8),
        hardwareAccountId: z.string().min(1),
        ikaUskSignatureB64: z.string().min(1),
        baseChain: z.enum(['sui', 'solana']).optional(),
        label: z.string().optional(),
        mwaTransport: z.enum(['local', 'remote']).optional(),
        mwaAuthToken: z.string().optional(),
        mwaReflectorHost: z.string().optional(),
        /**
         * WalletConnect v2 + Solana base: persisted relay session captured at pair time.
         * required when the linked hardware account has `vendor === 'walletconnect'`.
         */
        walletConnect: z
          .object({
            sessionTopic: z.string().min(1),
            accountAddress: z.string().min(1),
            chainId: z.string().min(1),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await createInitialHardwareVault(input.password, {
        hardwareAccountId: input.hardwareAccountId,
        ikaUskSignatureB64: input.ikaUskSignatureB64,
        baseChain: input.baseChain,
        label: input.label,
        mwaTransport: input.mwaTransport,
        mwaAuthToken: input.mwaAuthToken,
        mwaReflectorHost: input.mwaReflectorHost,
        walletConnect: input.walletConnect,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  /**
   * sui passkey vault: webauthn / sip-9 + ika dwallet on sui base. caller (popup
   * `?passkeyregister=ID` flow) collects the artifacts via the prf-aware webauthn provider
   * and posts them here. password is required at first-vault to seed the chromatika vault
   * blob's argon2id key, passkey-only unlock can land later (current scope: passkey provides
   * the ika seed, password protects the local blob).
   */
  createVaultPasskey: publicProcedure
    .input(
      z.object({
        // password is OPTIONAL for passkey-only bootstrap. when omitted, the wallet has only
        // the passkey envelope and unlocks exclusively via webauthn, no password to type.
        password: z.string().min(8).optional(),
        credentialIdB64Url: z.string().min(1),
        publicKeyCompressedB64: z.string().min(1),
        prfSecretB64: z.string().min(1),
        prfSaltB64: z.string().min(1),
        rpId: z.string().min(1),
        label: z.string().optional(),
        recoveryWords: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await createPasskeyVault(input.password, {
        credentialIdB64Url: input.credentialIdB64Url,
        publicKeyCompressedB64: input.publicKeyCompressedB64,
        prfSecretB64: input.prfSecretB64,
        prfSaltB64: input.prfSaltB64,
        rpId: input.rpId,
        label: input.label,
        recoveryWords: input.recoveryWords,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  /**
   * waap (`@human.tech/waap-sdk`) vault: ui-collected artifacts include the wallet-standard
   * sui address + public key, the chosen auth method, and either a deterministic pairing
   * signature (over `IKA_USK_DERIVATION_MESSAGE`) or a 24-word recovery phrase. the determinism
   * probe runs in the side panel before this is called; the seedSource discriminator tells the
   * background which path to follow.
   */
  createVaultWaap: publicProcedure
    .input(
      z.object({
        // password is OPTIONAL when waap signatures are deterministic, the waap signature
        // envelope alone unlocks the wallet. non-deterministic waap still requires a password
        // until the recovery-words fallback ships (`createWaapVault` enforces this).
        password: z.string().min(8).optional(),
        waapSuiAddress: z.string().min(1),
        waapSuiPublicKeyB64: z.string().min(1),
        waapAuthMethod: z.enum(['email', 'phone', 'social']),
        waapSocialProvider: z
          .enum(['google', 'discord', 'twitter', 'github', 'bluesky'])
          .optional(),
        seedSource: z.enum(['waap-signature', 'recovery-words']),
        pairingSignatureB64: z.string().optional(),
        recoveryWords: z.string().optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await createWaapVault(input.password, {
        waapSuiAddress: input.waapSuiAddress,
        waapSuiPublicKeyB64: input.waapSuiPublicKeyB64,
        waapAuthMethod: input.waapAuthMethod,
        waapSocialProvider: input.waapSocialProvider,
        seedSource: input.seedSource,
        pairingSignatureB64: input.pairingSignatureB64,
        recoveryWords: input.recoveryWords,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  addVaultWaap: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        waapSuiAddress: z.string().min(1),
        waapSuiPublicKeyB64: z.string().min(1),
        waapAuthMethod: z.enum(['email', 'phone', 'social']),
        waapSocialProvider: z
          .enum(['google', 'discord', 'twitter', 'github', 'bluesky'])
          .optional(),
        seedSource: z.enum(['waap-signature', 'recovery-words']),
        pairingSignatureB64: z.string().optional(),
        recoveryWords: z.string().optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addWaapVault(input.password, {
        waapSuiAddress: input.waapSuiAddress,
        waapSuiPublicKeyB64: input.waapSuiPublicKeyB64,
        waapAuthMethod: input.waapAuthMethod,
        waapSocialProvider: input.waapSocialProvider,
        seedSource: input.seedSource,
        pairingSignatureB64: input.pairingSignatureB64,
        recoveryWords: input.recoveryWords,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  /**
   * lazor (`@lazorkit/wallet`) vault: solana-base passkey smart wallet anchored on lazor's
   * anchor program. ui-collected artifacts include the portal-returned smart wallet pda /
   * credential id / passkey pubkey, plus the user's 24-word recovery phrase (the deterministic
   * seed source for ika since lazor's portal-hosted webauthn doesn't expose prf).
   */
  createVaultLazor: publicProcedure
    .input(
      z.object({
        password: z.string().min(8),
        lazorSmartWalletPubkeyB58: z.string().min(1),
        lazorCredentialIdB64: z.string().min(1),
        lazorPasskeyPubkeyB64: z.string().min(1),
        lazorWalletDevicePubkeyB58: z.string().optional(),
        lazorProgramId: z.string().min(1),
        lazorNetwork: z.enum(['mainnet', 'devnet']),
        lazorPortalUrl: z.string().min(1),
        seedSource: z.enum(['lazor-signature', 'recovery-words']),
        recoveryWords: z.string().optional(),
        pairingSignatureB64: z.string().optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await createLazorVault(input.password, {
        lazorSmartWalletPubkeyB58: input.lazorSmartWalletPubkeyB58,
        lazorCredentialIdB64: input.lazorCredentialIdB64,
        lazorPasskeyPubkeyB64: input.lazorPasskeyPubkeyB64,
        lazorWalletDevicePubkeyB58: input.lazorWalletDevicePubkeyB58,
        lazorProgramId: input.lazorProgramId,
        lazorNetwork: input.lazorNetwork,
        lazorPortalUrl: input.lazorPortalUrl,
        seedSource: input.seedSource,
        recoveryWords: input.recoveryWords,
        pairingSignatureB64: input.pairingSignatureB64,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  addVaultLazor: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        lazorSmartWalletPubkeyB58: z.string().min(1),
        lazorCredentialIdB64: z.string().min(1),
        lazorPasskeyPubkeyB64: z.string().min(1),
        lazorWalletDevicePubkeyB58: z.string().optional(),
        lazorProgramId: z.string().min(1),
        lazorNetwork: z.enum(['mainnet', 'devnet']),
        lazorPortalUrl: z.string().min(1),
        seedSource: z.enum(['lazor-signature', 'recovery-words']),
        recoveryWords: z.string().optional(),
        pairingSignatureB64: z.string().optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addLazorVault(input.password, {
        lazorSmartWalletPubkeyB58: input.lazorSmartWalletPubkeyB58,
        lazorCredentialIdB64: input.lazorCredentialIdB64,
        lazorPasskeyPubkeyB64: input.lazorPasskeyPubkeyB64,
        lazorWalletDevicePubkeyB58: input.lazorWalletDevicePubkeyB58,
        lazorProgramId: input.lazorProgramId,
        lazorNetwork: input.lazorNetwork,
        lazorPortalUrl: input.lazorPortalUrl,
        seedSource: input.seedSource,
        recoveryWords: input.recoveryWords,
        pairingSignatureB64: input.pairingSignatureB64,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  /**
   * sibling passkey vault when a chromatika vault blob already exists. password is optional
   * if the wallet is currently unlocked (re-uses the in-session credential); when locked, the
   * password decrypts the existing blob to merge in the new record.
   */
  addVaultPasskey: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        credentialIdB64Url: z.string().min(1),
        publicKeyCompressedB64: z.string().min(1),
        prfSecretB64: z.string().min(1),
        prfSaltB64: z.string().min(1),
        rpId: z.string().min(1),
        label: z.string().optional(),
        recoveryWords: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addPasskeyVault(input.password, {
        credentialIdB64Url: input.credentialIdB64Url,
        publicKeyCompressedB64: input.publicKeyCompressedB64,
        prfSecretB64: input.prfSecretB64,
        prfSaltB64: input.prfSaltB64,
        rpId: input.rpId,
        label: input.label,
        recoveryWords: input.recoveryWords,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  importVaultFromPrivateKey: publicProcedure
    .input(
      z.object({
        password: z.string().min(8),
        // Sui-base requires `suiPrivateKeyBech32`; Solana-base requires `solanaSecretKeyB64`.
        // backend enforces the baseChain-specific rule and ignores the unused field.
        suiPrivateKeyBech32: z.string().min(1).optional(),
        solanaSecretKeyB64: z.string().optional(),
        baseChain: z.enum(['sui', 'solana']).optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await importVaultFromSuiPrivateKey(input.password, {
        suiPrivateKeyBech32: input.suiPrivateKeyBech32,
        solanaSecretKeyB64: input.solanaSecretKeyB64,
        baseChain: input.baseChain,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  addVaultImportedFromPrivateKey: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        suiPrivateKeyBech32: z.string().min(1).optional(),
        solanaSecretKeyB64: z.string().optional(),
        baseChain: z.enum(['sui', 'solana']).optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addVaultImportedFromPrivateKey(input.password, {
        suiPrivateKeyBech32: input.suiPrivateKeyBech32,
        solanaSecretKeyB64: input.solanaSecretKeyB64,
        baseChain: input.baseChain,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  addVaultHardware: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        hardwareAccountId: z.string().min(1),
        /** optional: Ledger-first Sui vault omits this and sets `ikaShareKeysSourceVaultId`. */
        suiPrivateKeyBech32: z.string().optional(),
        ikaShareKeysSourceVaultId: z.string().optional(),
        solanaSecretKeyB64: z.string().optional(),
        baseChain: z.enum(['sui', 'solana']).optional(),
        label: z.string().optional(),
        /** MWA only: which transport to record. omitted defaults to 'local' (Android intent). */
        mwaTransport: z.enum(['local', 'remote']).optional(),
        /** MWA remote only: opaque auth_token from `wallet.authorize()` to skip QR rescan on later signs. */
        mwaAuthToken: z.string().optional(),
        /** MWA remote only: reflector host authority pinned at pairing time. */
        mwaReflectorHost: z.string().optional(),
        /**
         * MWA + Solana / WC + Solana auto-seed only: base64 of the wallet's signature over
         * `IKA_USK_DERIVATION_MESSAGE`, captured during pairing. required at runtime when the
         * hardware account is MWA + Solana or WalletConnect + Solana and no
         * `ikaShareKeysSourceVaultId` is provided. the background fn validates and throws a
         * repair-style error if missing.
         */
        ikaUskSignatureB64: z.string().optional(),
        /**
         * WalletConnect v2 + Solana base: persisted relay session captured at pair time.
         * required when the linked hardware account has `vendor === 'walletconnect'`.
         */
        walletConnect: z
          .object({
            sessionTopic: z.string().min(1),
            accountAddress: z.string().min(1),
            chainId: z.string().min(1),
          })
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addHardwareVault(input.password, {
        hardwareAccountId: input.hardwareAccountId,
        suiPrivateKeyBech32: input.suiPrivateKeyBech32,
        ikaShareKeysSourceVaultId: input.ikaShareKeysSourceVaultId,
        solanaSecretKeyB64: input.solanaSecretKeyB64,
        baseChain: input.baseChain,
        label: input.label,
        mwaTransport: input.mwaTransport,
        mwaAuthToken: input.mwaAuthToken,
        mwaReflectorHost: input.mwaReflectorHost,
        ikaUskSignatureB64: input.ikaUskSignatureB64,
        walletConnect: input.walletConnect,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  addVaultDwalletAnchored: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        anchorDwalletId: z.string().min(1),
        suiPrivateKeyBech32: z.string().min(1).optional(),
        solanaSecretKeyB64: z.string().optional(),
        baseChain: z.enum(['sui', 'solana']).optional(),
        label: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addDwalletAnchoredVault(input.password, {
        anchorDwalletId: input.anchorDwalletId,
        suiPrivateKeyBech32: input.suiPrivateKeyBech32,
        solanaSecretKeyB64: input.solanaSecretKeyB64,
        baseChain: input.baseChain,
        label: input.label,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  listVaults: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    return listVaultSummaries();
  }),

  // vault total reads chain balances + chrome.storage (no private material), so the
  // tRPC lock-gate here is the only auth surface - computeVaultTotal itself is safe
  // to run without a session.
  getVaultTotal: publicProcedure
    .input(z.object({ vaultId: z.string().min(1) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      return computeVaultTotal(input.vaultId);
    }),

  getVaultTotalsForOthers: publicProcedure
    .input(z.object({ vaultIds: z.array(z.string().min(1)).max(20) }))
    .query(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      const cached = await Promise.all(input.vaultIds.map(getCachedVaultTotal));
      const now = Date.now();
      const staleIds = input.vaultIds.filter((_, i) => isStaleSnapshot(cached[i], now));
      if (staleIds.length > 0) {
        // fire-and-forget; UI re-renders via chrome.storage.onChanged
        void refreshVaultTotalsBatch(staleIds);
      }
      return cached;
    }),

  // intentionally lock-gated even though storage clear is itself safe - callers that
  // race the auto-lock get a clean "Wallet locked" rather than a silent no-op so the
  // UI can decide whether to retry post-unlock.
  clearVaultTotalCache: publicProcedure
    .input(z.object({ vaultId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const s = getSession();
      if (!s) throw new Error('Wallet locked');
      await clearVaultTotalCacheStorage(input.vaultId);
    }),

  /**
   * read HD mnemonic from another vault on the opposite ika base (same chromatika password).
   * does not persist, UI shows backup then calls `addVault` with that mnemonic.
   */
  previewCrossChainReuseMnemonic: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        sourceVaultId: z.string().min(1),
        newBaseChain: z.enum(['sui', 'solana']),
      }),
    )
    .mutation(async ({ input }) => {
      const mnemonic = await getMnemonicForCrossChainReuse(
        input.password,
        input.sourceVaultId,
        input.newBaseChain,
      );
      return { mnemonic };
    }),

  addVault: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        baseChain: z.enum(['sui', 'solana']).optional(),
        mnemonic: z.string().optional(),
        wordCount: z.union([z.literal(12), z.literal(24)]).optional(),
        label: z.string().optional(),
        accountIndex: z.number().int().min(0).max(50).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const out = await addVault(input.password, {
        baseChain: input.baseChain,
        mnemonic: input.mnemonic,
        wordCount: input.wordCount,
        label: input.label,
        accountIndex: input.accountIndex,
      });
      await pushDappAccountAndAptosHints();
      return out;
    }),

  /**
   * batch import: multi-account import from one mnemonic. used by the scan-then-import flow when
   * the user picks multiple bip44 accounts to import as separate vaults from the same phrase.
   * `password` is required for first-vault bootstrap; ignored when a wallet already exists +
   * unlocked (the in-session credential decrypts the existing blob).
   */
  importVaultsBatch: publicProcedure
    .input(
      z.object({
        password: z.string().min(8),
        mnemonic: z.string().min(1),
        accounts: z
          .array(
            z.object({
              accountIndex: z.number().int().min(0).max(50),
              label: z.string().optional(),
            }),
          )
          .min(1)
          .max(20),
      }),
    )
    .mutation(async ({ input }) => {
      const { importVaultsBatch } = await import('@/background/wallet-service');
      const out = await importVaultsBatch(input.password, input.mnemonic, input.accounts);
      await pushDappAccountAndAptosHints();
      return out;
    }),

  removeVault: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        vaultId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await removeVault(input.password, input.vaultId);
      await pushDappAccountAndAptosHints();
    }),

  switchVault: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        vaultId: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      await switchVault(input.password, input.vaultId);
      await pushDappAccountAndAptosHints();
    }),

  renameVault: publicProcedure
    .input(
      z.object({
        password: z.string().min(8).optional(),
        vaultId: z.string().min(1),
        label: z.string().min(1),
      }),
    )
    .mutation(({ input }) => renameVault(input.password, input.vaultId, input.label)),

  activeVaultId: publicProcedure.query(() => getActiveVaultId()),

  syncVaultMeta: publicProcedure.mutation(async () => {
    await persistVaultFromSession();
    return { ok: true as const };
  }),

  unlockVault: publicProcedure
    .input(
      z.object({
        password: z.string(),
        autoLockMinutes: z.number().min(1).max(1440).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const autoLockMinutes = input.autoLockMinutes ?? 30;
      try {
        await unlockVault(input.password, autoLockMinutes);
      } catch (err) {
        captureException(err, { feature: 'vault', chain: 'none' });
        throw err;
      }
      clearLockSchedule();
      scheduleLock(autoLockMinutes);
      try {
        await pushDappAccountAndAptosHints();
        broadcastToTabs('connect', { chainId: '0x1' });
      } catch {
        /* dWallet may not be set up yet */
      }
      return { unlocked: true as const };
    }),

  /**
   * public envelope metadata for the unlock screen, never returns secret material. the unlock
   * screen reads this BEFORE asking the user for any credential, so it knows whether to show
   * a password input, a passkey button, a waap button, etc.
   */
  listVaultEnvelopes: publicProcedure.query(() => listVaultEnvelopes()),

  /** unlock via a webauthn prf hmac-secret (32 bytes, base64). side panel runs the assertion inline. */
  unlockVaultPasskey: publicProcedure
    .input(
      z.object({
        envelopeId: z.string().min(1),
        prfSecretB64: z.string().min(1),
        autoLockMinutes: z.number().min(1).max(1440).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const autoLockMinutes = input.autoLockMinutes ?? 30;
      const bin = atob(input.prfSecretB64);
      const prfSecret = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) prfSecret[i] = bin.charCodeAt(i);
      try {
        await unlockVaultByPasskey(input.envelopeId, prfSecret, autoLockMinutes);
      } finally {
        prfSecret.fill(0);
      }
      clearLockSchedule();
      scheduleLock(autoLockMinutes);
      try {
        await pushDappAccountAndAptosHints();
        broadcastToTabs('connect', { chainId: '0x1' });
      } catch {
        /* ignore */
      }
      return { unlocked: true as const };
    }),

  /** unlock via a deterministic wallet-standard signature (waap / seeker / walletconnect). */
  unlockVaultWalletSignature: publicProcedure
    .input(
      z.object({
        envelopeId: z.string().min(1),
        signatureB64: z.string().min(1),
        autoLockMinutes: z.number().min(1).max(1440).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const autoLockMinutes = input.autoLockMinutes ?? 30;
      const bin = atob(input.signatureB64);
      const sig = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) sig[i] = bin.charCodeAt(i);
      try {
        await unlockVaultByWalletSignature(input.envelopeId, sig, autoLockMinutes);
      } finally {
        sig.fill(0);
      }
      clearLockSchedule();
      scheduleLock(autoLockMinutes);
      try {
        await pushDappAccountAndAptosHints();
        broadcastToTabs('connect', { chainId: '0x1' });
      } catch {
        /* ignore */
      }
      return { unlocked: true as const };
    }),

  /**
   * unlock via a 24/12-word bip39 phrase (lazor recovery, opt-in passkey/waap recovery codes).
   * caller supplies the phrase verbatim; background normalizes + validates + derives the bip39
   * seed itself (we don't want the phrase to round-trip across the tRPC boundary as a hash).
   */
  unlockVaultRecoveryWords: publicProcedure
    .input(
      z.object({
        envelopeId: z.string().min(1),
        words: z.string().min(1),
        autoLockMinutes: z.number().min(1).max(1440).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const autoLockMinutes = input.autoLockMinutes ?? 30;
      const { mnemonicToSeedSync } = await import('@scure/bip39');
      const words = input.words.trim().replace(/\s+/g, ' ');
      const seed = mnemonicToSeedSync(words);
      try {
        await unlockVaultByRecoveryWords(input.envelopeId, seed, autoLockMinutes);
      } finally {
        seed.fill(0);
      }
      clearLockSchedule();
      scheduleLock(autoLockMinutes);
      try {
        await pushDappAccountAndAptosHints();
        broadcastToTabs('connect', { chainId: '0x1' });
      } catch {
        /* ignore */
      }
      return { unlocked: true as const };
    }),

  lock: publicProcedure.mutation(() => {
    lockWallet();
    clearLockSchedule();
    broadcastToTabs('accountsChanged', []);
    broadcastToTabs('disconnect', { code: 4900, message: 'Wallet locked' });
    broadcastToTabs('aptosAccountChange', null);
    return { locked: true as const };
  }),

  lockState: publicProcedure.query(async () => {
    await ensureUnlockedSessionFromCache();
    return getLockState();
  }),

  balances: publicProcedure.query(() => getTrpcBalanceSummary()),

  /**
   * active browser tab + dapp permission for `VaultContextHeader`.
   * used in both side panel and popup chrome (same component, same behavior).
   */
  vaultHeaderDappContext: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) throw new Error('Wallet locked');
    const tab = await getActiveTabContext();
    if (!tab.origin) {
      return { mode: 'no_origin' as const };
    }
    const perm = await getPermission(tab.origin);
    if (!perm?.scope.accounts) {
      return { mode: 'not_connected' as const, origin: tab.origin };
    }
    const siteDisplayName =
      tab.title && tab.title.length > 0
        ? tab.title
        : (() => {
            try {
              return new URL(tab.origin).hostname.replace(/^www\./, '');
            } catch {
              return tab.origin;
            }
          })();
    const active = await getActiveNetworks();
    const { evm: customEvm } = await getCustomNetworks();
    const chainId = active.evmChainId;
    const evmNet = findEvmNetwork(chainId, customEvm);
    let displayAddress = perm.selectedAddress ?? '';
    if (!displayAddress && perm.selectedDwalletId) {
      try {
        const pack = await chainAddressesForDwalletId(perm.selectedDwalletId);
        displayAddress = pack.addresses.evm ?? '';
      } catch {
        /* noop */
      }
    }
    return {
      mode: 'connected' as const,
      origin: tab.origin,
      siteName: siteDisplayName,
      chainName: evmNet?.name ?? `chain ${chainId}`,
      chainId,
      address: displayAddress,
    };
  }),
};
