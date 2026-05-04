/**
 * shared wallet-app state hook used by both popup `App` and `SidePanelApp`.
 *
 * owns: walletExists / lockState probes, balances + networks + advanced + uiHelpHints +
 * vault-summary loading, biometric enrollment, ika base mode + appearance + theme
 * document, shared bus subscription, ika-gate-missing-chain bookkeeping, ika mode
 * auto-correction, and the unlock action pair.
 *
 * surfaces consume the returned `unlocked` / `vaultExists` / `balances` etc. and own
 * their own routing on top.
 */

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { trpc } from '@/lib/trpc';
import { useSharedBus } from '@/lib/use-shared-bus';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { useAppearanceMode } from '@/lib/use-appearance-mode';
import { useChromatikaThemeDocument } from '@/lib/use-theme-document';
import { runChromatikaThemeFlash } from '@/lib/run-chromatika-theme-flash';
import { markLocalThemeChangeFromThisDocument } from '@/lib/theme-flash-storage-suppress';
import { ikaModeFromActiveVault } from '@/lib/derive-ika-mode-from-vault';
import { hasBiometricUnlockEnrollment, unlockPasswordWithBiometric } from '@/lib/biometric-unlock';
import type { VaultSummary } from '@/ui/VaultPicker';
import type { Balances, Networks } from '@/ui/types';
import type { IkaBaseMode } from '@/background/ika-base-mode';
import type { AppearanceMode } from '@/background/appearance-mode';

const DEFAULT_AUTO_LOCK_MINUTES = 30;

export interface UseWalletAppStateOpts {
  devMode: boolean;
  dev?: {
    vaultExists?: boolean | null;
    unlocked?: boolean | null;
    balances?: Balances | null;
    networks?: Networks | null;
    vaultSummaries?: VaultSummary[] | null;
    activeVaultId?: string | null;
    advanced?: boolean;
  };
  /** when true, skip walletExists probe + lockState + balance refresh + visibility refresh.
   *  popup approval surfaces (hwsign / txapprove) own routing entirely and do not need this work. */
  skipLifecycle?: boolean;
  autoLockMinutes?: number;
}

export type RefreshOpts = { clearStaleBalanceError?: boolean };

export interface WalletAppState {
  // probe / lifecycle
  vaultExists: boolean | null;
  setVaultExists: Dispatch<SetStateAction<boolean | null>>;
  vaultPresenceError: string | null;
  setVaultPresenceError: Dispatch<SetStateAction<string | null>>;
  vaultProbeNonce: number;
  retryVaultProbe: () => void;

  // unlock
  unlocked: boolean | null;
  setUnlocked: Dispatch<SetStateAction<boolean | null>>;
  password: string;
  setPassword: Dispatch<SetStateAction<string>>;
  bioEnrolled: boolean;
  bioBusy: boolean;
  unlockError: string | null;
  setUnlockError: Dispatch<SetStateAction<string | null>>;
  onUnlock: () => Promise<void>;
  onUnlockWithBiometric: () => Promise<void>;

  // wallet data
  balances: Balances | null;
  setBalances: Dispatch<SetStateAction<Balances | null>>;
  balanceError: string | null;
  setBalanceError: Dispatch<SetStateAction<string | null>>;
  networks: Networks | null;
  advanced: boolean;
  setAdvanced: Dispatch<SetStateAction<boolean>>;
  uiHelpHints: boolean;
  setUiHelpHints: Dispatch<SetStateAction<boolean>>;
  vaultSummaries: VaultSummary[] | null;
  activeVaultId: string | null;

  // ika mode + theme
  ikaModeRaw: IkaBaseMode | null;
  ikaBaseDisplay: IkaBaseMode;
  ikaGateMissingChain: IkaBaseMode | null;
  setIkaGateMissingChain: Dispatch<SetStateAction<IkaBaseMode | null>>;
  ikaGateEffective: IkaBaseMode | null;
  handleIkaModeSelect: (m: IkaBaseMode) => Promise<void>;
  setIkaModePersist: (m: IkaBaseMode) => Promise<void> | void;

  // appearance
  appearance: AppearanceMode;
  setAppearance: (v: AppearanceMode) => Promise<void>;

  // refresh / load
  loadVaults: () => void;
  refresh: (opts?: RefreshOpts) => void;
  refreshBalances: (opts?: { clearStaleError?: boolean }) => void;
}

export function useWalletAppState(opts: UseWalletAppStateOpts): WalletAppState {
  const {
    devMode,
    dev,
    skipLifecycle = false,
    autoLockMinutes = DEFAULT_AUTO_LOCK_MINUTES,
  } = opts;

  // probe / lifecycle state
  const [vaultExists, setVaultExists] = useState<boolean | null>(
    devMode ? dev?.vaultExists ?? null : null,
  );
  const [vaultPresenceError, setVaultPresenceError] = useState<string | null>(null);
  const [vaultProbeNonce, setVaultProbeNonce] = useState(0);

  // unlock state
  const [unlocked, setUnlocked] = useState<boolean | null>(
    devMode ? dev?.unlocked ?? null : null,
  );
  const [password, setPassword] = useState('');
  const [bioEnrolled, setBioEnrolled] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // wallet data state
  const [balances, setBalances] = useState<Balances | null>(
    devMode ? dev?.balances ?? null : null,
  );
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [networks, setNetworks] = useState<Networks | null>(
    devMode ? dev?.networks ?? null : null,
  );
  const [advanced, setAdvanced] = useState<boolean>(
    devMode ? dev?.advanced ?? false : false,
  );
  const [uiHelpHints, setUiHelpHints] = useState(true);
  const [vaultSummaries, setVaultSummaries] = useState<VaultSummary[] | null>(
    devMode ? dev?.vaultSummaries ?? null : null,
  );
  const [activeVaultId, setActiveVaultId] = useState<string | null>(
    devMode ? dev?.activeVaultId ?? null : null,
  );

  // ika gate missing chain (user picked a chain in the header but no vault for it yet)
  const [ikaGateMissingChain, setIkaGateMissingChain] = useState<IkaBaseMode | null>(null);

  const loadVaults = useCallback(() => {
    if (devMode) return;
    trpc.listVaults.query().then(setVaultSummaries).catch(() => setVaultSummaries(null));
    trpc.activeVaultId.query().then(setActiveVaultId).catch(() => setActiveVaultId(null));
  }, [devMode]);

  const refreshBalances = useCallback(
    (rOpts?: { clearStaleError?: boolean }) => {
      if (devMode) return;
      if (rOpts?.clearStaleError) setBalanceError(null);
      trpc.balances
        .query()
        .then((b) => {
          setBalances(b);
          setBalanceError(null);
        })
        .catch((e) => {
          setBalances(null);
          setBalanceError(e instanceof Error ? e.message : String(e));
        });
    },
    [devMode],
  );

  const refresh = useCallback(
    (rOpts?: RefreshOpts) => {
      if (devMode) return;
      refreshBalances({ clearStaleError: rOpts?.clearStaleBalanceError });
      trpc.getNetworks.query().then(setNetworks).catch(() => setNetworks(null));
      trpc.getAdvancedMode.query().then(setAdvanced).catch(() => {});
      trpc.getUiHelpHints.query().then(setUiHelpHints).catch(() => {});
      loadVaults();
    },
    [devMode, refreshBalances, loadVaults],
  );

  const retryVaultProbe = useCallback(() => {
    setVaultPresenceError(null);
    setVaultProbeNonce((n) => n + 1);
  }, []);

  // walletExists probe
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    setVaultPresenceError(null);
    trpc.walletExists
      .query()
      .then((ok) => {
        setVaultExists(ok);
        if (!ok) setUnlocked(false);
      })
      .catch((e) => {
        setVaultPresenceError(e instanceof Error ? e.message : String(e));
        setVaultExists(null);
      });
  }, [devMode, skipLifecycle, vaultProbeNonce]);

  // lockState probe whenever vault exists. session lives only in the SW; if it
  // restarted, lockState will tell us so and the unlock screen will rehydrate.
  // refresh() is driven by the unlocked-transition effect below, not here, so
  // a single code path covers both "SW had session" and "user just unlocked".
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    if (!vaultExists) return;
    trpc.lockState
      .query()
      .then((ls) => setUnlocked(ls.unlocked))
      .catch(() => setUnlocked(false));
  }, [devMode, skipLifecycle, vaultExists]);

  // when unlocked turns true (initial probe rehydrate OR user-driven unlock via
  // password/biometric/passkey/waap/seeker), pull balances + networks + vaults.
  // before this, none of the unlock callbacks fetched balances, so the popup
  // showed "loading wallet… [retry]" until a focus event happened to fire.
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    if (unlocked) refresh();
  }, [devMode, skipLifecycle, unlocked, refresh]);

  // balances came back locked -> SW restarted or auto-lock fired; drop back to unlock
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    if (balances?.locked && vaultExists === true && unlocked === true) {
      setBalances(null);
      setUnlocked(false);
    }
  }, [devMode, skipLifecycle, balances, vaultExists, unlocked]);

  // MV3 SW can restart while side panel / popup stays open - refresh on visibility
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    function onVis() {
      if (document.visibilityState !== 'visible') return;
      if (vaultExists !== true || unlocked !== true) return;
      refreshBalances();
    }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [devMode, skipLifecycle, vaultExists, unlocked, refreshBalances]);

  // biometric enrollment check - only when waiting at unlock
  useEffect(() => {
    if (devMode || skipLifecycle) return;
    if (!vaultExists || unlocked) return;
    void hasBiometricUnlockEnrollment().then(setBioEnrolled);
  }, [devMode, skipLifecycle, vaultExists, unlocked]);

  // shared bus + ika base + appearance hooks
  const { broadcast } = useSharedBus((e) => {
    if (e.type === 'balances_updated' || e.type === 'network_changed' || e.type === 'account_changed') {
      refresh();
    }
  });
  const { mode: ikaModeRaw, setMode: setIkaModePersist } = useIkaBaseMode({ broadcast });
  const { appearance, setAppearance: setAppearancePersist } = useAppearanceMode({ broadcast });

  // ika gate / display chain
  const vaultDerivedIka = ikaModeFromActiveVault(vaultSummaries, activeVaultId);
  const needsIkaBaseVault =
    !devMode &&
    vaultSummaries !== null &&
    ikaModeRaw !== null &&
    !vaultSummaries.some((v) => v.baseChain === ikaModeRaw);
  const ikaGateEffective =
    ikaGateMissingChain ?? (needsIkaBaseVault && ikaModeRaw ? ikaModeRaw : null);
  const ikaBaseDisplay =
    ikaGateEffective !== null ? ikaGateEffective : vaultDerivedIka ?? ikaModeRaw ?? 'sui';
  useChromatikaThemeDocument(ikaBaseDisplay, appearance);

  const handleIkaModeSelect = useCallback(
    async (m: IkaBaseMode) => {
      if (devMode) {
        markLocalThemeChangeFromThisDocument();
        await runChromatikaThemeFlash(() => setIkaModePersist(m));
        return;
      }
      if (vaultSummaries === null) {
        markLocalThemeChangeFromThisDocument();
        await runChromatikaThemeFlash(() => setIkaModePersist(m));
        return;
      }
      const matches = vaultSummaries.filter((v) => v.baseChain === m);
      if (matches.length === 0) {
        markLocalThemeChangeFromThisDocument();
        await runChromatikaThemeFlash(async () => {
          // gate first -> MainWalletShell unmounts in the same flush as the
          // chrome.storage.onChanged listeners' setModeState batch, so there's
          // no intermediate render with ikaModeRaw='solana' but the shell
          // still mounted (which crashed the unmount with removeChild).
          setIkaGateMissingChain(m);
          await setIkaModePersist(m);
        });
        return;
      }
      markLocalThemeChangeFromThisDocument();
      await runChromatikaThemeFlash(async () => {
        setIkaGateMissingChain(null);
        const target = matches.find((v) => v.id === activeVaultId) ?? matches[0]!;
        if (target.id !== activeVaultId) {
          // switchVault needs the cached vault password. SW restarts or auto-lock wipe the session;
          // fall through to the unlock screen instead of surfacing a raw tRPC error.
          let locked = false;
          try {
            const ls = await trpc.lockState.query();
            if (!ls.unlocked) locked = true;
          } catch {
            locked = true;
          }
          if (locked) {
            setUnlocked(false);
            return;
          }
          try {
            await trpc.switchVault.mutate({ vaultId: target.id });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (/Password required|Wallet locked/i.test(msg)) {
              setUnlocked(false);
              return;
            }
            throw e;
          }
          refresh();
        }
        await setIkaModePersist(m);
      });
    },
    [devMode, vaultSummaries, activeVaultId, setIkaModePersist, refresh],
  );

  // ika base auto-correction: if active vault doesn't match the persisted base mode,
  // and we have a vault for the persisted base, leave it; otherwise snap to the active
  // vault's base so the UI doesn't show stale chain data.
  //
  // this runs silently (no `runChromatikaThemeFlash`). the flash overlay covers the
  // viewport with a 620ms blocking veil — when this effect fired on initial popup mount
  // the user's first settings-icon click landed on the veil instead of the button.
  // mark the local-suppress so sibling `useIkaBaseMode` storage listeners in this
  // document also stay quiet, then just persist; the visual flash is reserved for
  // explicit user-driven mode swaps (mode selector / appearance toggle).
  useEffect(() => {
    if (devMode) return;
    if (!vaultSummaries || !activeVaultId || ikaGateMissingChain) return;
    const persistedWants = ikaModeRaw;
    if (persistedWants && !vaultSummaries.some((v) => v.baseChain === persistedWants)) {
      return;
    }
    const vd = ikaModeFromActiveVault(vaultSummaries, activeVaultId);
    if (!vd || vd === ikaModeRaw) return;
    markLocalThemeChangeFromThisDocument();
    void setIkaModePersist(vd);
  }, [devMode, vaultSummaries, activeVaultId, ikaGateMissingChain, ikaModeRaw, setIkaModePersist]);

  const setAppearance = useCallback(
    async (v: AppearanceMode) => {
      if (v === appearance) return;
      markLocalThemeChangeFromThisDocument();
      await runChromatikaThemeFlash(() => setAppearancePersist(v));
    },
    [appearance, setAppearancePersist],
  );

  const onUnlock = useCallback(async () => {
    setUnlockError(null);
    try {
      await trpc.unlockVault.mutate({ password, autoLockMinutes });
      setPassword('');
      setUnlocked(true);
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : String(e));
    }
  }, [password, autoLockMinutes]);

  const onUnlockWithBiometric = useCallback(async () => {
    setUnlockError(null);
    setBioBusy(true);
    try {
      const pwd = await unlockPasswordWithBiometric();
      if (!pwd) {
        setUnlockError('biometric unlock cancelled or unavailable');
        return;
      }
      await trpc.unlockVault.mutate({ password: pwd, autoLockMinutes });
      setUnlocked(true);
    } catch (e) {
      setUnlockError(e instanceof Error ? e.message : String(e));
    } finally {
      setBioBusy(false);
    }
  }, [autoLockMinutes]);

  return {
    vaultExists,
    setVaultExists,
    vaultPresenceError,
    setVaultPresenceError,
    vaultProbeNonce,
    retryVaultProbe,

    unlocked,
    setUnlocked,
    password,
    setPassword,
    bioEnrolled,
    bioBusy,
    unlockError,
    setUnlockError,
    onUnlock,
    onUnlockWithBiometric,

    balances,
    setBalances,
    balanceError,
    setBalanceError,
    networks,
    advanced,
    setAdvanced,
    uiHelpHints,
    setUiHelpHints,
    vaultSummaries,
    activeVaultId,

    ikaModeRaw,
    ikaBaseDisplay,
    ikaGateMissingChain,
    setIkaGateMissingChain,
    ikaGateEffective,
    handleIkaModeSelect,
    setIkaModePersist,

    appearance,
    setAppearance,

    loadVaults,
    refresh,
    refreshBalances,
  };
}
