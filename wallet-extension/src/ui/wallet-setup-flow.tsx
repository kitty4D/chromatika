/**
 * shared create / import wallet UI for popup, full-tab onboarding, and side panel.
 *
 * lazy-load split: the five steps that drag in multi-MB SDK weight (hardware / passkey /
 * waap / lazor / seeker) become their own chunks so `wallet-setup-flow.js` stays small for
 * first paint. the user picks ONE of these paths after `ChooseStep`, so a brief Suspense
 * fallback on step transition is acceptable. common steps (choose / password / backup /
 * import / importKey) stay eager because they're on every flow's hot path.
 */

import { lazy, Suspense } from 'react';
import { cardStyle, type WalletSetupSurface, type WalletSetupMode } from './wallet-setup-flow/internal';
import { useWalletSetup } from './wallet-setup-flow/use-wallet-setup';
import { ChooseStep } from './wallet-setup-flow/steps/choose';
import { PasswordStep } from './wallet-setup-flow/steps/password';
import { BackupStep } from './wallet-setup-flow/steps/backup';
import { ImportStep } from './wallet-setup-flow/steps/import';
import { ImportKeyStep } from './wallet-setup-flow/steps/import-key';
const HardwareStep = lazy(() =>
  import('./wallet-setup-flow/steps/hardware').then((m) => ({ default: m.HardwareStep })),
);
const PasskeyStep = lazy(() =>
  import('./wallet-setup-flow/steps/passkey').then((m) => ({ default: m.PasskeyStep })),
);
const WaapStep = lazy(() =>
  import('./wallet-setup-flow/steps/waap').then((m) => ({ default: m.WaapStep })),
);
const LazorStep = lazy(() =>
  import('./wallet-setup-flow/steps/lazor').then((m) => ({ default: m.LazorStep })),
);
const SeekerStep = lazy(() =>
  import('./wallet-setup-flow/steps/seeker').then((m) => ({ default: m.SeekerStep })),
);
import './wallet-setup-choose.css';

export type {
  WalletSetupSurface,
  WalletSetupMode,
  WalletSetupStep,
  WalletSetupIntent,
} from './wallet-setup-flow/internal';

export function WalletSetupFlow({
  surface,
  mode = 'bootstrap',
  onVaultReady,
  onDismiss,
  initialStep,
  initialIntent,
  initialMnemonicIn,
  initialGeneratedMnemonic,
  initialBackupConfirmed,
  vaultBaseChainOverride,
}: {
  surface: WalletSetupSurface;
  /** default `bootstrap` - first-time create/import. `addVault` reuses the same steps for an additional vault. */
  mode?: WalletSetupMode;
  onVaultReady: () => void;
  /** when `mode` is `addVault`, show a way back (e.g. settings) without finishing */
  onDismiss?: () => void;
  /** dev-only: render the flow starting at a specific screen */
  initialStep?: import('./wallet-setup-flow/internal').WalletSetupStep;
  /** dev-only: if starting at `password`, default intent can be set explicitly */
  initialIntent?: import('./wallet-setup-flow/internal').WalletSetupIntent;
  /** dev-only: starting at `import` */
  initialMnemonicIn?: string;
  /** dev-only: starting at `backup` */
  initialGeneratedMnemonic?: string;
  /** dev-only: starting at `backup` */
  initialBackupConfirmed?: boolean;
  /** `addVault` only: pin ika base chain (e.g. user chose Solana in header but had no vault yet) */
  vaultBaseChainOverride?: 'sui' | 'solana';
}) {
  const hook = useWalletSetup({
    mode,
    onVaultReady,
    initialStep,
    initialIntent,
    initialMnemonicIn,
    initialGeneratedMnemonic,
    initialBackupConfirmed,
    vaultBaseChainOverride,
  });

  const box = cardStyle(surface);
  const { step } = hook;

  if (step === 'choose') return <ChooseStep surface={surface} box={box} onDismiss={onDismiss} hook={hook} />;
  if (step === 'password') return <PasswordStep surface={surface} box={box} hook={hook} />;
  if (step === 'backup') return <BackupStep surface={surface} box={box} hook={hook} />;
  if (step === 'importKey') return <ImportKeyStep surface={surface} box={box} hook={hook} />;
  // lazy-loaded steps share one Suspense - only one renders at a time.
  if (
    step === 'hardware' ||
    step === 'passkey' ||
    step === 'waap' ||
    step === 'lazor' ||
    step === 'seeker'
  ) {
    return (
      <Suspense fallback={<div className="sp-loading">Loading…</div>}>
        {step === 'hardware' && <HardwareStep surface={surface} box={box} onDismiss={onDismiss} hook={hook} />}
        {step === 'passkey' && <PasskeyStep surface={surface} box={box} hook={hook} />}
        {step === 'waap' && <WaapStep surface={surface} box={box} hook={hook} />}
        {step === 'lazor' && <LazorStep surface={surface} box={box} hook={hook} />}
        {step === 'seeker' && <SeekerStep surface={surface} box={box} onDismiss={onDismiss} hook={hook} />}
      </Suspense>
    );
  }
  return <ImportStep surface={surface} box={box} hook={hook} />;
}
