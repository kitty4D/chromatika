import { useEffect, useState } from 'react';
import TransportWebHID from '@ledgerhq/hw-transport-webhid';
import TrezorConnect from '@trezor/connect-web';
import { transact } from '@solana-mobile/mobile-wallet-adapter-protocol-web3js';
import { PublicKey } from '@solana/web3.js';
import { trpc } from '@/lib/trpc';
import { useIkaBaseMode } from '@/lib/use-ika-base-mode';
import { deriveLedgerSuiAccounts } from '@/ui/hardware/ledger-sui-derive';
import { deriveLedgerSolanaAccounts } from '@/ui/hardware/ledger-solana-derive';
import { MWA_APP_IDENTITY } from '@/config/mwa';
import { isWcEnabled } from '@/config/wc';
import type { SeekerPairResult } from '@/ui/hardware/SeekerConnect';
import type { WalletConnectPairResult } from '@/ui/hardware/WalletConnectConnect';
import { IKA_USK_DERIVATION_MESSAGE, IKA_USK_DOMAIN } from '@/background/keyring/hd';
import { solanaSecretKeyB64FromFlexiblePaste } from '@/lib/solana-import-key-format';
import {
  ensureTrezorSetupInit,
  type HardwareRow,
  type VaultListRow,
  type WalletSetupIntent,
  type WalletSetupMode,
  type WalletSetupStep,
} from './internal';

/**
 * UI device discriminant.
 *  - `mwa`           = local Android intent (`solana-wallet://`); same-device only.
 *  - `mwa-remote`    = desktop <-> phone via Solana Mobile's wss reflector + QR (debug-flag-gated).
 *  - `walletconnect` = WalletConnect v2 (Reown) relay + QR; works on all platforms.
 *  - `ledger` / `trezor` = USB / WebHID hardware vendors.
 */
export type HardwareDeviceSelect = 'ledger' | 'trezor' | 'mwa' | 'mwa-remote' | 'walletconnect';

export type WalletSetupHookProps = {
  mode: WalletSetupMode;
  onVaultReady: () => void;
  initialStep?: WalletSetupStep;
  initialIntent?: WalletSetupIntent;
  initialMnemonicIn?: string;
  initialGeneratedMnemonic?: string;
  initialBackupConfirmed?: boolean;
  vaultBaseChainOverride?: 'sui' | 'solana';
};

export function useWalletSetup(props: WalletSetupHookProps) {
  const {
    mode,
    onVaultReady,
    initialStep,
    initialIntent,
    initialMnemonicIn,
    initialGeneratedMnemonic,
    initialBackupConfirmed,
    vaultBaseChainOverride,
  } = props;

  // bootstrap (first vault) opens with the experience-tier picker; addVault skips it
  // (the user already has a wallet + a chosen tier).
  const [step, setStep] = useState<WalletSetupStep>(
    initialStep ?? (mode === 'bootstrap' ? 'tier' : 'choose'),
  );
  const [intent, setIntent] = useState<WalletSetupIntent | null>(initialIntent ?? null);
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [mnemonicIn, setMnemonicIn] = useState(initialMnemonicIn ?? '');
  const [generatedMnemonic, setGeneratedMnemonic] = useState(initialGeneratedMnemonic ?? '');
  const [backupConfirmed, setBackupConfirmed] = useState(initialBackupConfirmed ?? false);
  const [error, setError] = useState<string | null>(null);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [backupBusy, setBackupBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [privateKeyIn, setPrivateKeyIn] = useState('');
  const [solanaKeyB64In, setSolanaKeyB64In] = useState('');
  const [importKeyBusy, setImportKeyBusy] = useState(false);
  const [hardwareVaultOptions, setHardwareVaultOptions] = useState<VaultListRow[]>([]);
  const [hardwareAccounts, setHardwareAccounts] = useState<HardwareRow[]>([]);
  const [hardwareIkaSourceId, setHardwareIkaSourceId] = useState('');
  const [hardwareAccountSelect, setHardwareAccountSelect] = useState('');
  const [hardwarePairBusy, setHardwarePairBusy] = useState(false);
  const [hardwareSubmitBusy, setHardwareSubmitBusy] = useState(false);
  const [hardwareDeviceSelect, setHardwareDeviceSelect] = useState<HardwareDeviceSelect>(() => {
    // bootstrap mode (first-vault) only supports phone-Solana auto-seed, pre-select the right
    // transport for the current UA. on Android the local MWA intent is fastest. on desktop, prefer
    // WalletConnect when enabled (most reliable today); fall back to MWA-remote only when the
    // legacy debug flag is on, otherwise default to `walletconnect` even if disabled so the user
    // sees the right "set VITE_WC_PROJECT_ID" hint instead of silently picking a hidden option.
    if (mode === 'bootstrap') {
      const isAndroidUa = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
      if (isAndroidUa) return 'mwa';
      if (isWcEnabled()) return 'walletconnect';
      const mwaRemoteEnabled = (import.meta.env.VITE_ENABLE_MWA_REMOTE as string | undefined) === 'true';
      return mwaRemoteEnabled ? 'mwa-remote' : 'walletconnect';
    }
    return 'ledger';
  });
  /** holds the most recent Seeker pair result so `onAddLedgerHardwareVault` can persist `mwaAuthToken`. */
  const [seekerPair, setSeekerPair] = useState<SeekerPairResult | null>(null);
  /** holds the most recent WalletConnect pair result so `onAddLedgerHardwareVault` can persist `walletconnect.sessionTopic`. */
  const [walletConnectPair, setWalletConnectPair] = useState<WalletConnectPairResult | null>(null);
  /**
   * captured during pairing for both MWA transports (local Android intent + remote Seeker QR).
   * the wallet signs `IKA_USK_DERIVATION_MESSAGE` so the background can derive the ika seed
   * deterministically on any device, this is what makes Seeker-only restore work, since the
   * same Seeker on a new install produces the same signature -> same ika seed -> same dWallet.
   * cleared after `onAddLedgerHardwareVault` succeeds.
   */
  const [mwaIkaUskSignatureB64, setMwaIkaUskSignatureB64] = useState<string | null>(null);
  const [mnemonicWordCount, setMnemonicWordCount] = useState<12 | 24>(12);
  const [otherChainHdVaults, setOtherChainHdVaults] = useState<VaultListRow[]>([]);
  const [reuseVaultSelect, setReuseVaultSelect] = useState('');
  const [crossChainReuseVaultId, setCrossChainReuseVaultId] = useState<string | null>(null);

  const [chooseIkaBaseDraft, setChooseIkaBaseDraft] = useState<'sui' | 'solana' | null>(null);
  const [addVaultAllVaults, setAddVaultAllVaults] = useState<VaultListRow[]>([]);
  const [solanaKeyImportFormat, setSolanaKeyImportFormat] = useState<'base64' | 'jsonArray'>('base64');

  const { mode: ikaMode, ready: ikaModeReady } = useIkaBaseMode();
  /** prefer storage-backed ika mode before defaulting to sui so cross-chain reuse matches the header. */
  const ikaBaseReady = vaultBaseChainOverride != null || ikaModeReady;
  const effectiveIkaBase: 'sui' | 'solana' =
    vaultBaseChainOverride ?? chooseIkaBaseDraft ?? ikaMode ?? 'sui';
  const ikaChainLabel = effectiveIkaBase === 'solana' ? 'Solana' : 'Sui';

  /**
   * addVault mode runs while the wallet is already unlocked (every entry point - the side
   * panel ika base gate, vault management screen, vaults settings - mounts the flow only
   * after unlock). the background's `resolveCredentialOrUnlock` reuses the in-session
   * vault key on that path, so the UI password input is unnecessary and would block
   * passkey / waap / lazor / seeker users (they have no password to type). bootstrap
   * (first-vault) still needs a password to seed the encrypted blob.
   *
   * `passwordField` exists so we omit the key entirely from tRPC payloads in addVault mode
   * - sending `password: ''` would trip `z.string().min(8).optional()` (an empty string
   * still hits the min check), but undefined / missing slips through cleanly.
   */
  const passwordRequired = mode === 'bootstrap';
  const passwordField = passwordRequired ? { password } : {};

  useEffect(() => {
    setChooseIkaBaseDraft(null);
  }, [vaultBaseChainOverride]);

  useEffect(() => {
    if (mode !== 'addVault') {
      setOtherChainHdVaults([]);
      setAddVaultAllVaults([]);
      return;
    }
    let cancelled = false;
    void trpc.listVaults
      .query()
      .then((list) => {
        if (cancelled) return;
        setAddVaultAllVaults(list);
        setOtherChainHdVaults(
          list.filter((v) => v.baseChain !== effectiveIkaBase && v.accountKind === 'hd'),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setOtherChainHdVaults([]);
          setAddVaultAllVaults([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode, effectiveIkaBase]);

  useEffect(() => {
    if (reuseVaultSelect && !otherChainHdVaults.some((v) => v.id === reuseVaultSelect)) {
      setReuseVaultSelect('');
    }
  }, [otherChainHdVaults, reuseVaultSelect]);

  useEffect(() => {
    if (step === 'password' && intent === null) setStep('choose');
  }, [step, intent]);

  useEffect(() => {
    if (step !== 'hardware') return;
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        // listVaults requires an unlocked session, only meaningful in addVault mode.
        // bootstrap (first-vault) has no session yet; hardware accounts come from the global
        // chrome.storage row, which getHardwareAccounts reads without a session.
        const vaultsPromise = mode === 'addVault'
          ? trpc.listVaults.query().catch(() => [] as VaultListRow[])
          : Promise.resolve([] as VaultListRow[]);
        const [vaults, hw] = await Promise.all([
          vaultsPromise,
          trpc.getHardwareAccounts.query(),
        ]);
        if (cancelled) return;
        setHardwareVaultOptions(vaults);
        setHardwareAccounts(hw);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, mode]);

  /** create path: only fetch a preview mnemonic (fast). PBKDF2 + ika keys + storage run in `afterBackupUnlock` after user confirms backup. */
  async function onCreateFinal() {
    setError(null);
    if (passwordRequired) {
      if (password.length < 8) {
        setError('password must be at least 8 characters');
        return;
      }
      if (mode === 'bootstrap' && password !== password2) {
        setError('passwords do not match');
        return;
      }
    }
    try {
      if (mode === 'addVault' && !ikaBaseReady) {
        setError('loading ika base chain — wait a moment and try again');
        return;
      }
      if (crossChainReuseVaultId) {
        const { mnemonic } = await trpc.previewCrossChainReuseMnemonic.mutate({
          ...passwordField,
          sourceVaultId: crossChainReuseVaultId,
          newBaseChain: effectiveIkaBase,
        });
        setGeneratedMnemonic(mnemonic);
        setStep('backup');
        setBackupConfirmed(false);
        return;
      }
      const { mnemonic } = await trpc.generateSetupMnemonic.query({ wordCount: mnemonicWordCount });
      setGeneratedMnemonic(mnemonic);
      setStep('backup');
      setBackupConfirmed(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function afterBackupUnlock() {
    setError(null);
    if (!backupConfirmed) {
      setError('confirm you saved your seed/mnemonic phrase');
      return;
    }
    if (!generatedMnemonic.trim()) {
      setError('no phrase to save - go back and try again');
      return;
    }
    try {
      setBackupBusy(true);
      if (mode === 'addVault') {
        await trpc.addVault.mutate({ ...passwordField, mnemonic: generatedMnemonic, baseChain: effectiveIkaBase });
        setPassword('');
        setPassword2('');
        setGeneratedMnemonic('');
        setCrossChainReuseVaultId(null);
        onVaultReady();
        return;
      }
      await trpc.createVault.mutate({ password, mnemonic: generatedMnemonic });
      await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      setPassword('');
      setPassword2('');
      setGeneratedMnemonic('');
      onVaultReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBackupBusy(false);
    }
  }

  function backFromBackup() {
    setError(null);
    setBackupConfirmed(false);
    setGeneratedMnemonic('');
    setStep('password');
  }

  async function onImportPrivateKey() {
    setError(null);
    if (passwordRequired && password.length < 8) {
      setError('password must be at least 8 characters');
      return;
    }
    const pk = privateKeyIn.trim();
    const s64raw = solanaKeyB64In.trim();
    let s64 = s64raw;
    if (effectiveIkaBase === 'solana') {
      if (!s64raw) {
        setError(
          solanaKeyImportFormat === 'jsonArray'
            ? 'paste your Solana secret key as a JSON byte array or keypair file'
            : 'paste your Solana keypair as base64 (64 bytes — same as solana-keygen / Phantom export)',
        );
        return;
      }
      if (solanaKeyImportFormat === 'jsonArray') {
        try {
          s64 = solanaSecretKeyB64FromFlexiblePaste(s64raw);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
    } else {
      if (!pk) {
        setError('paste your Sui private key (suiprivkey… bech32 from Sui Wallet / CLI)');
        return;
      }
    }
    setImportKeyBusy(true);
    try {
      const payloadSui = effectiveIkaBase === 'solana' ? (pk || undefined) : pk;
      const payloadSol = effectiveIkaBase === 'solana' ? s64 : undefined;
      if (mode === 'addVault') {
        await trpc.addVaultImportedFromPrivateKey.mutate({
          ...passwordField,
          suiPrivateKeyBech32: payloadSui,
          solanaSecretKeyB64: payloadSol,
          baseChain: effectiveIkaBase,
        });
        setPassword('');
        setPrivateKeyIn('');
        setSolanaKeyB64In('');
        onVaultReady();
        return;
      }
      await trpc.importVaultFromPrivateKey.mutate({
        password,
        suiPrivateKeyBech32: payloadSui,
        solanaSecretKeyB64: payloadSol,
        baseChain: effectiveIkaBase,
      });
      await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      setPassword('');
      setPrivateKeyIn('');
      setSolanaKeyB64In('');
      onVaultReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportKeyBusy(false);
    }
  }

  async function pairLedgerSuiForHardwareVault() {
    setError(null);
    setHardwarePairBusy(true);
    try {
      const transport = await TransportWebHID.create();
      const rows = await deriveLedgerSuiAccounts(transport);
      await transport.close();
      for (const row of rows) {
        await trpc.addHardwareAccount.mutate({
          vendor: 'ledger',
          chain: 'sui',
          derivationPath: row.path,
          address: row.address,
          ed25519PublicKeyB64: row.ed25519PublicKeyB64,
        });
      }
      const hw = await trpc.getHardwareAccounts.query();
      setHardwareAccounts(hw);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHardwarePairBusy(false);
    }
  }

  async function pairLedgerSolanaForHardwareVault() {
    setError(null);
    setHardwarePairBusy(true);
    try {
      const transport = await TransportWebHID.create();
      const rows = await deriveLedgerSolanaAccounts(transport);
      await transport.close();
      for (const row of rows) {
        await trpc.addHardwareAccount.mutate({
          vendor: 'ledger',
          chain: 'solana',
          derivationPath: row.path,
          address: row.address,
        });
      }
      const hw = await trpc.getHardwareAccounts.query();
      setHardwareAccounts(hw);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHardwarePairBusy(false);
    }
  }

  async function pairTrezorSolanaForHardwareVault() {
    setError(null);
    setHardwarePairBusy(true);
    try {
      await ensureTrezorSetupInit();
      const paths = ["m/44'/501'/0'/0'", "m/44'/501'/1'/0'"];
      for (const path of paths) {
        const result = await TrezorConnect.solanaGetAddress({ path, showOnTrezor: false });
        if (!result.success) throw new Error(result.payload.error);
        await trpc.addHardwareAccount.mutate({
          vendor: 'trezor',
          chain: 'solana',
          derivationPath: path,
          address: result.payload.address,
        });
      }
      const hw = await trpc.getHardwareAccounts.query();
      setHardwareAccounts(hw);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHardwarePairBusy(false);
    }
  }

  async function pairMwaForHardwareVault() {
    setError(null);
    setHardwarePairBusy(true);
    try {
      await transact(async (wallet) => {
        const auth = await wallet.authorize({
          chain: 'solana:mainnet',
          identity: MWA_APP_IDENTITY,
        });
        if (!auth.accounts.length) throw new Error('no accounts returned from mobile wallet');
        const account = auth.accounts[0]!;
        const pubkey = new PublicKey(account.address);
        // capture the ika USK derivation signature inside the same `transact` session, once
        // it returns, the wallet binding is dropped and a later `signMessages` would open a
        // fresh Android intent. same domain string + same Seeker = same Ed25519 signature
        // (RFC 8032 deterministic) = same ika seed = same dWallet across devices.
        const sigPayloads = await wallet.signMessages({
          addresses: [account.address],
          payloads: [IKA_USK_DERIVATION_MESSAGE],
        });
        if (!sigPayloads.length || !(sigPayloads[0] instanceof Uint8Array)) {
          throw new Error(
            `mobile wallet did not return a signature for the ika derivation message ("${IKA_USK_DOMAIN}")`,
          );
        }
        const sigBytes = sigPayloads[0];
        // MWA returns the signature concatenated with the original payload, strip the
        // payload suffix so the seed derivation hashes only the 64-byte Ed25519 signature.
        const sigOnly =
          sigBytes.length > IKA_USK_DERIVATION_MESSAGE.length
            ? sigBytes.subarray(0, sigBytes.length - IKA_USK_DERIVATION_MESSAGE.length)
            : sigBytes;
        const ikaUskSignatureB64 = btoa(String.fromCharCode(...sigOnly));
        setMwaIkaUskSignatureB64(ikaUskSignatureB64);
        await trpc.addHardwareAccount.mutate({
          vendor: 'mwa',
          chain: 'solana',
          derivationPath: "m/44'/501'/0'/0'",
          address: pubkey.toBase58(),
        });
        const hw = await trpc.getHardwareAccounts.query();
        setHardwareAccounts(hw);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHardwarePairBusy(false);
    }
  }

  /**
   * `addHardwareVault` phone+Solana auto-seed branch (in `wallet-service.ts`) generates the
   * ika `UserShareEncryptionKeys` deterministically from the wallet's signature over
   * `IKA_USK_DERIVATION_MESSAGE`. phone wallets never expose their key bytes, so this
   * signature is the only way phone pairs can produce ika keys without the user setting up
   * a companion HD vault first.
   *
   * both MWA (Seeker / Phantom Android via Solana Mobile) and WalletConnect v2 (any WC-
   * compliant Solana wallet) qualify - both produce a 64-byte Ed25519 sig over the same
   * domain message, and the on-chain effect is identical. the function is named
   * "MWA" for historical reasons; do not rename without auditing every call site.
   */
  function isMwaSolanaAutoSeedEligible(): boolean {
    return (
      effectiveIkaBase === 'solana'
      && (hardwareDeviceSelect === 'mwa'
          || hardwareDeviceSelect === 'mwa-remote'
          || hardwareDeviceSelect === 'walletconnect')
    );
  }

  async function onAddLedgerHardwareVault() {
    setError(null);
    if (passwordRequired) {
      if (password.length < 8) {
        setError('password must be at least 8 characters');
        return;
      }
      if (mode === 'bootstrap' && password !== password2) {
        setError('passwords do not match');
        return;
      }
    }
    if (!hardwareAccountSelect) {
      const deviceLabel =
        hardwareDeviceSelect === 'walletconnect' ? 'WalletConnect'
        : hardwareDeviceSelect === 'mwa-remote' ? 'Seeker / Solana Mobile (remote)'
        : hardwareDeviceSelect === 'mwa' ? 'Solana Mobile'
        : hardwareDeviceSelect === 'trezor' ? 'Trezor'
        : 'Ledger';
      setError(
        effectiveIkaBase === 'solana'
          ? `pick the ${deviceLabel} Solana account that will pay ika fees`
          : `pick the ${deviceLabel} Sui account that will pay ika fees`,
      );
      return;
    }
    const autoSeed = isMwaSolanaAutoSeedEligible();
    const isBootstrap = mode === 'bootstrap';
    if (isBootstrap && !autoSeed) {
      setError(
        'first-vault hardware setup currently supports Solana Mobile (Seeker / Phantom Android / Solflare Android) or WalletConnect only. switch ika base to Solana above and pick "WalletConnect", "Seeker (QR pair)", or "Solana Mobile (this phone)", or create an HD vault first and add Ledger / Trezor from settings.',
      );
      return;
    }
    if (!autoSeed && !hardwareIkaSourceId && !isBootstrap) {
      setError('pick a vault that already has ika keys for both curves (we copy those blobs only — no suiprivkey on this path)');
      return;
    }
    const isMwaTransport = hardwareDeviceSelect === 'mwa' || hardwareDeviceSelect === 'mwa-remote';
    const isWcTransport = hardwareDeviceSelect === 'walletconnect';
    if (autoSeed && !mwaIkaUskSignatureB64) {
      setError(
        `re-pair the wallet so we can capture the ika derivation signature ("${IKA_USK_DOMAIN}") — that signature is what makes the dWallet recoverable on another device.`,
      );
      return;
    }
    if (isWcTransport && !walletConnectPair) {
      setError('re-pair the WalletConnect wallet so we can capture the relay session topic and ika derivation signature.');
      return;
    }
    setHardwareSubmitBusy(true);
    try {
      const isMwaRemote = hardwareDeviceSelect === 'mwa-remote';
      const mwaTransportField = isMwaTransport
        ? { mwaTransport: isMwaRemote ? 'remote' as const : 'local' as const }
        : {};
      const mwaAuthFields = {
        ...(isMwaRemote && seekerPair?.authToken ? { mwaAuthToken: seekerPair.authToken } : {}),
        ...(isMwaRemote && seekerPair?.reflectorHost ? { mwaReflectorHost: seekerPair.reflectorHost } : {}),
      };
      const wcField = isWcTransport && walletConnectPair
        ? {
            walletConnect: {
              sessionTopic: walletConnectPair.sessionTopic,
              accountAddress: walletConnectPair.address,
              chainId: walletConnectPair.chainId,
            },
          }
        : {};
      if (isBootstrap) {
        // phase 1: first-vault hardware = phone-Solana auto-seed (MWA or WalletConnect). the
        // background fn rejects anything else; the UI gate above also enforces this so the user
        // gets a friendlier error first.
        await trpc.createVaultHardware.mutate({
          password,
          hardwareAccountId: hardwareAccountSelect,
          ikaUskSignatureB64: mwaIkaUskSignatureB64!,
          baseChain: 'solana',
          ...mwaTransportField,
          ...mwaAuthFields,
          ...wcField,
        });
        // mirror the createVault -> unlockVault sequence so the session is ready before we
        // hand control back to the wallet UI; otherwise the side panel still reads "locked".
        await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      } else {
        await trpc.addVaultHardware.mutate({
          ...passwordField,
          hardwareAccountId: hardwareAccountSelect,
          ...(hardwareIkaSourceId ? { ikaShareKeysSourceVaultId: hardwareIkaSourceId } : {}),
          baseChain: effectiveIkaBase,
          ...mwaTransportField,
          ...mwaAuthFields,
          ...wcField,
          ...(autoSeed && mwaIkaUskSignatureB64 ? { ikaUskSignatureB64: mwaIkaUskSignatureB64 } : {}),
        });
      }
      setPassword('');
      setPassword2('');
      setHardwareIkaSourceId('');
      setHardwareAccountSelect('');
      setSeekerPair(null);
      setWalletConnectPair(null);
      setMwaIkaUskSignatureB64(null);
      onVaultReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHardwareSubmitBusy(false);
    }
  }

  /** called by `SeekerConnect` once the wallet authorizes - we cache the auth_token until vault add. */
  async function onSeekerPaired(pair: SeekerPairResult) {
    setSeekerPair(pair);
    setMwaIkaUskSignatureB64(pair.ikaUskSignatureB64);
    // SeekerConnect already added the hardware account row; refresh to surface it in the dropdown.
    try {
      const hw = await trpc.getHardwareAccounts.query();
      setHardwareAccounts(hw);
      // auto-select the freshly-paired Seeker account so the user does not have to re-pick it.
      const fresh = hw.find((a) => a.vendor === 'mwa' && a.chain === 'solana' && a.address === pair.address);
      if (fresh) setHardwareAccountSelect(fresh.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * called by `WalletConnectConnect` once the wallet approves the relay session AND signs the
   * ika USK derivation message. sibling of `onSeekerPaired`, same shape, different field names
   * (sessionTopic vs auth_token, chainId vs reflectorHost). the captured signature is stored in
   * the historically-named `mwaIkaUskSignatureB64` slot since both protocols feed the same
   * downstream `ikaRootSeedFromMwaSignature` hash.
   */
  async function onWalletConnectPaired(pair: WalletConnectPairResult) {
    setWalletConnectPair(pair);
    setMwaIkaUskSignatureB64(pair.ikaUskSignatureB64);
    try {
      const hw = await trpc.getHardwareAccounts.query();
      setHardwareAccounts(hw);
      const fresh = hw.find((a) => a.vendor === 'walletconnect' && a.chain === 'solana' && a.address === pair.address);
      if (fresh) setHardwareAccountSelect(fresh.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onImport() {
    setError(null);
    if (passwordRequired && password.length < 8) {
      setError('password must be at least 8 characters');
      return;
    }
    const phrase = mnemonicIn.trim();
    if (!phrase) {
      setError('enter your recovery phrase');
      return;
    }
    setImportBusy(true);
    try {
      if (mode === 'addVault') {
        await trpc.addVault.mutate({ ...passwordField, mnemonic: phrase, baseChain: effectiveIkaBase });
        setPassword('');
        setMnemonicIn('');
        onVaultReady();
        return;
      }
      await trpc.importVault.mutate({ password, mnemonic: phrase });
      await trpc.unlockVault.mutate({ password, autoLockMinutes: 30 });
      setPassword('');
      setMnemonicIn('');
      onVaultReady();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImportBusy(false);
    }
  }

  return {
    mode,
    /** caller-provided "wallet is ready" callback, surfaced so the new passkey/waap/lazor steps
     *  can drive the onboarding celebration / side-panel main view transition the same way the
     *  legacy HD/import flows do. */
    onVaultReady,
    step,
    setStep,
    intent,
    setIntent,
    password,
    setPassword,
    password2,
    setPassword2,
    mnemonicIn,
    setMnemonicIn,
    generatedMnemonic,
    backupConfirmed,
    setBackupConfirmed,
    error,
    setError,
    passwordBusy,
    setPasswordBusy,
    showPw,
    setShowPw,
    backupBusy,
    importBusy,
    privateKeyIn,
    setPrivateKeyIn,
    solanaKeyB64In,
    setSolanaKeyB64In,
    importKeyBusy,
    hardwareVaultOptions,
    hardwareAccounts,
    hardwareIkaSourceId,
    setHardwareIkaSourceId,
    hardwareAccountSelect,
    setHardwareAccountSelect,
    hardwarePairBusy,
    hardwareSubmitBusy,
    hardwareDeviceSelect,
    setHardwareDeviceSelect,
    mnemonicWordCount,
    setMnemonicWordCount,
    otherChainHdVaults,
    reuseVaultSelect,
    setReuseVaultSelect,
    crossChainReuseVaultId,
    setCrossChainReuseVaultId,
    ikaBaseReady,
    effectiveIkaBase,
    ikaChainLabel,
    addVaultChainPickerLocked: vaultBaseChainOverride != null,
    addVaultAllVaults,
    setChooseIkaBaseDraft,
    solanaKeyImportFormat,
    setSolanaKeyImportFormat,
    onCreateFinal,
    afterBackupUnlock,
    backFromBackup,
    onImportPrivateKey,
    pairLedgerSuiForHardwareVault,
    pairLedgerSolanaForHardwareVault,
    pairTrezorSolanaForHardwareVault,
    pairMwaForHardwareVault,
    onAddLedgerHardwareVault,
    onSeekerPaired,
    seekerPair,
    onWalletConnectPaired,
    walletConnectPair,
    isMwaSolanaAutoSeedEligible,
    onImport,
  };
}

export type WalletSetupHook = ReturnType<typeof useWalletSetup>;
