import { z } from 'zod';
import { publicProcedure } from '../trpc';
import { runScan } from '@/background/scan/scan-orchestrator';
import { SUPER_PRO_CHAINS } from '@/config/scan-chains';
import type { ScanResult } from '@/background/scan/scan-types';
import { getSession } from '@/background/session';
import { loadVaultPayloadWithKey } from '@/background/vault-store';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import { mergeDwalletMeta } from '@/background/wallet-service';
import { loadDwalletMeta } from '@/background/storage-meta';
import { matchCapsToSiblings, type SiblingDwalletMetaSummary } from '@/background/scan/dwallet-cap-match';
import type { VaultRecord } from '@/background/vault-types';

/**
 * tRPC surface for the "scan for additional accounts" flow. one mutation per onboarding
 * method, keeps zod schemas tight + makes the call sites self-documenting.
 *
 * each mutation returns a `ScanResult` with rows the UI displays in a table; the user picks
 * which to import. the picking + import is a separate flow (vault-router's `addVault` /
 * `addPasskeyVault` / etc.).
 */
export const scanProcedures = {
  /** static metadata for the super-pro chain picker UI. */
  scanListSuperProChains: publicProcedure.query(() => SUPER_PRO_CHAINS),

  /**
   * dwallet inventory for the active vault. enumerates owned dwallet caps with curve + state +
   * cross-chain-derived addresses, and now matches each cap **precisely** against the local
   * sibling vault (if any) that owns it.
   *
   * **how the match works**: each sibling vault's `dwalletMeta` (per-curve) records the
   * `dwalletId` it knows about, this is the local truth set written when DKG completes or when
   * the user accepts an encrypted share. for each owned cap on chain we look up
   * `cap.dwalletId` in the union of all siblings' `dwalletId`s. match -> annotated with the
   * sibling that owns it. miss -> truly orphan (cap exists on chain at our identity address but
   * no local vault references it).
   *
   * we merge each sibling's vault-blob dwalletMeta with its `chrome.storage` overlay
   * (`chromatika_dwallet_meta_v2_<vaultId>`) so freshly-discovered ids that haven't been
   * persisted back to the blob are also counted. matches the read pattern used by
   * `kickDiscoveryForVault`.
   */
  dwalletInventoryForActiveVault: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) return null;
    const payload = await loadVaultPayloadWithKey(s.vaultKey);
    const active = payload.vaults.find((v) => v.id === s.activeVaultId);
    if (!active) return null;

    /** records that share the same on-chain identity as the active vault. */
    const isSameIdentity = (v: VaultRecord): boolean => {
      if (v.accountKind !== active.accountKind) return false;
      if (active.accountKind === 'passkey' && v.accountKind === 'passkey') {
        return v.passkeyCredentialId === active.passkeyCredentialId;
      }
      if (active.accountKind === 'hardware' && v.accountKind === 'hardware') {
        return v.hardwareAccountId === active.hardwareAccountId;
      }
      if (active.accountKind === 'waap' && v.accountKind === 'waap') {
        return v.waapSuiAddress === active.waapSuiAddress;
      }
      if (active.accountKind === 'lazor' && v.accountKind === 'lazor') {
        return v.lazorSmartWalletPubkeyB58 === active.lazorSmartWalletPubkeyB58;
      }
      // HD: sibling = same mnemonic + same accountIndex is a duplicate (not a sibling); same
      // mnemonic + different accountIndex = different sui address = different identity. so HD
      // siblings under "same identity" is exactly the active record itself.
      if (active.accountKind === 'hd' && v.accountKind === 'hd') {
        return v.id === active.id;
      }
      return v.id === active.id;
    };

    const localSiblings = payload.vaults.filter(isSameIdentity);

    /**
     * build sibling summaries with merged dwalletMeta (vault blob + chrome.storage overlay).
     * each sibling can own up to 2 dwallets (one per curve).
     */
    const siblingDescriptors: SiblingDwalletMetaSummary[] = [];
    for (const v of localSiblings) {
      const ikaIndex =
        (v.accountKind === 'passkey'
          ? v.passkeyEncryptionIndex
          : (v as { ikaEncryptionIndex?: number }).ikaEncryptionIndex)
        ?? 0;

      let overlay: Awaited<ReturnType<typeof loadDwalletMeta>> = {};
      try {
        overlay = await loadDwalletMeta(v.id);
      } catch {
        overlay = {};
      }
      const merged = mergeDwalletMeta(v.dwalletMeta, overlay, v.baseChain);

      const knownDwalletIds: string[] = [];
      for (const curve of ['SECP256K1', 'ED25519'] as const) {
        const id = merged[curve]?.dwalletId?.trim();
        if (id) knownDwalletIds.push(id);
      }

      siblingDescriptors.push({
        vaultId: v.id,
        label: v.label,
        ikaIndex,
        isActive: v.id === active.id,
        knownDwalletIds,
      });
    }

    /** owned caps for the active vault. fails open: empty list on error so UI doesn't crash. */
    let caps: Awaited<ReturnType<typeof listOwnedDWalletCapsForVault>> = [];
    try {
      caps = await listOwnedDWalletCapsForVault(active.id);
    } catch {
      caps = [];
    }

    // pure cap-to-sibling matcher. testable in isolation (see dwallet-cap-match.test.ts).
    const matchInput = caps.map((c) => ({
      capObjectId: c.capObjectId,
      dwalletId: c.dwalletId,
      curve: c.curve,
      status: c.status,
      needsZeroTrustCompletion: c.needsZeroTrustCompletion,
      chainAddresses: c.chainAddresses,
    }));
    const matched = matchCapsToSiblings(matchInput, siblingDescriptors);

    return {
      activeVaultId: active.id,
      activeAccountKind: active.accountKind,
      activeBaseChain: active.baseChain,
      siblings: siblingDescriptors,
      caps: matched.caps.map((c) => ({
        capObjectId: c.capObjectId,
        dwalletId: c.dwalletId,
        curve: c.curve,
        status: c.status,
        needsZeroTrustCompletion: c.needsZeroTrustCompletion,
        chainAddresses: c.chainAddresses ?? null,
        matchedVaultId: c.matchedVaultId,
        matchedVaultLabel: c.matchedVaultLabel,
        matchedIkaIndex: c.matchedIkaIndex,
      })),
      capCount: matched.capCount,
      siblingCount: matched.siblingCount,
      /** precise: caps that don't appear in any sibling's local dwalletMeta. */
      orphanCount: matched.orphanCount,
    };
  }),

  /**
   * read scan-relevant context for the currently-active vault. used by the post-unlock "find
   * more accounts" panel to choose the right scan tRPC + show the active identity address.
   * returns null when locked.
   */
  scanContextForActiveVault: publicProcedure.query(async () => {
    const s = getSession();
    if (!s) return null;
    const payload = await loadVaultPayloadWithKey(s.vaultKey);
    const active = payload.vaults.find((v) => v.id === s.activeVaultId);
    if (!active) return null;
    let suiAddress: string | undefined;
    let solanaAddress: string | undefined;
    switch (active.accountKind) {
      case 'passkey':
        suiAddress = s.dWalletDiscoverySuiAddress;
        break;
      case 'waap':
        suiAddress = active.waapSuiAddress;
        break;
      case 'lazor':
        solanaAddress = active.lazorSmartWalletPubkeyB58;
        break;
      case 'hardware':
        // hardware vault: solana-base = the seeker / wc / ledger pubkey from the linked account.
        // sui-base hardware = sui address from the fee key. exposing what we have on the record.
        if (active.baseChain === 'solana') solanaAddress = active.ledgerFeePayerSolPubkeyB58;
        break;
      default:
        break;
    }
    // surface the per-method seed source when the active vault has one (passkey / waap / lazor).
    // lets diagnostic tooling + e2e assertions verify which seed-source path produced this vault
    // without exposing the full record. union narrows when accountKind is one of the discriminants
    // that carries `seedSource`.
    let seedSource: string | undefined;
    if (
      active.accountKind === 'passkey'
      || active.accountKind === 'waap'
      || active.accountKind === 'lazor'
    ) {
      seedSource = active.seedSource;
    }
    return {
      vaultId: active.id,
      accountKind: active.accountKind,
      baseChain: active.baseChain,
      suiAddress,
      solanaAddress,
      seedSource,
    };
  }),

  /** HD bip44 account-index scan. results contain one row per accountIndex 0..N. */
  scanForHd: publicProcedure
    .input(
      z.object({
        mnemonic: z.string().min(1),
        defaults: z.boolean().default(true),
        superProChainIds: z.array(z.string()).optional(),
        accountIndexGap: z.number().int().min(1).max(10).optional(),
        maxIndexHardLimit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ScanResult> => {
      return runScan(
        { method: 'hd', mnemonic: input.mnemonic },
        { defaults: input.defaults, superProChainIds: input.superProChainIds },
        { accountIndexGap: input.accountIndexGap, maxIndexHardLimit: input.maxIndexHardLimit },
      );
    }),

  /** passkey single-identity scan. probes the passkey sui address across opted-in chains. */
  scanForPasskey: publicProcedure
    .input(
      z.object({
        suiAddress: z.string().min(1),
        defaults: z.boolean().default(true),
        superProChainIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ScanResult> => {
      return runScan(
        { method: 'passkey', suiAddress: input.suiAddress },
        { defaults: input.defaults, superProChainIds: input.superProChainIds },
      );
    }),

  /** seeker (mwa) single-identity scan. probes the seeker solana pubkey across opted-in chains. */
  scanForSeeker: publicProcedure
    .input(
      z.object({
        solanaAddress: z.string().min(1),
        defaults: z.boolean().default(true),
        superProChainIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ScanResult> => {
      return runScan(
        { method: 'seeker', solanaAddress: input.solanaAddress },
        { defaults: input.defaults, superProChainIds: input.superProChainIds },
      );
    }),

  /** waap single-identity scan. probes the waap-returned sui address across opted-in chains. */
  scanForWaap: publicProcedure
    .input(
      z.object({
        suiAddress: z.string().min(1),
        defaults: z.boolean().default(true),
        superProChainIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ScanResult> => {
      return runScan(
        { method: 'waap', suiAddress: input.suiAddress },
        { defaults: input.defaults, superProChainIds: input.superProChainIds },
      );
    }),

  /** lazor single-identity scan. probes the lazor smart-wallet pda across opted-in chains. */
  scanForLazor: publicProcedure
    .input(
      z.object({
        lazorSmartWalletPubkeyB58: z.string().min(1),
        defaults: z.boolean().default(true),
        superProChainIds: z.array(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }): Promise<ScanResult> => {
      return runScan(
        { method: 'lazor', lazorSmartWalletPubkeyB58: input.lazorSmartWalletPubkeyB58 },
        { defaults: input.defaults, superProChainIds: input.superProChainIds },
      );
    }),
};
