/**
 * Onboarding picker preview - mounts the real `ChooseStep` with a mock hook so it
 * renders without touching trpc / chrome.
 *
 * Cycles ika base mode (sui ↔ solana) every 6s so visitors see both Sui (passkey
 * + waap) and Solana (lazor + seeker) primary CTA sets without clicking. The
 * conic-gradient + glow border on the primary buttons (per `wallet-setup-choose.css`)
 * plays on each switch.
 */

import './chrome-stub';
import { useEffect, useState } from 'react';
import { ChooseStep } from '@/ui/wallet-setup-flow/steps/choose';
import { cardStyle } from '@/ui/wallet-setup-flow/internal';
import type { WalletSetupHook } from '@/ui/wallet-setup-flow/use-wallet-setup';
import '@/ui/wallet.css';
import '@/ui/wallet-setup-choose.css';
import { mountPreview } from './mount';

const SURFACE = 'sidepanel' as const;

function OnboardingPreview() {
  const [intent, setIntent] = useState<WalletSetupHook['intent']>(null);
  const [step, setStep] = useState<WalletSetupHook['step']>('choose');
  const [reuseVaultSelect, setReuseVaultSelect] = useState('');
  const [crossChainReuseVaultId, setCrossChainReuseVaultId] = useState<string | null>(null);
  const [chooseIkaBaseDraft, setChooseIkaBaseDraft] = useState<'sui' | 'solana' | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setChooseIkaBaseDraft((prev) => (prev === 'solana' ? 'sui' : 'solana'));
    }, 6000);
    return () => clearInterval(id);
  }, []);

  // click-feedback resets so animations replay on each visitor poke
  useEffect(() => {
    if (intent === null) return;
    const id = setTimeout(() => setIntent(null), 250);
    return () => clearTimeout(id);
  }, [intent]);

  useEffect(() => {
    if (step !== 'choose') {
      const id = setTimeout(() => setStep('choose'), 250);
      return () => clearTimeout(id);
    }
  }, [step]);

  const effectiveIkaBase: 'sui' | 'solana' = chooseIkaBaseDraft ?? 'sui';
  const ikaChainLabel = effectiveIkaBase === 'solana' ? 'Solana' : 'Sui';

  const mockHook = {
    mode: 'bootstrap' as const,
    intent,
    setIntent,
    step,
    setStep,
    reuseVaultSelect,
    setReuseVaultSelect,
    crossChainReuseVaultId,
    setCrossChainReuseVaultId,
    effectiveIkaBase,
    ikaChainLabel,
    otherChainHdVaults: [],
    addVaultAllVaults: [],
    addVaultChainPickerLocked: false,
    setChooseIkaBaseDraft,
  } as unknown as WalletSetupHook;

  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }}>
            <ChooseStep surface={SURFACE} box={cardStyle(SURFACE)} hook={mockHook} />
          </div>
        </div>
      </div>
    </div>
  );
}

mountPreview(<OnboardingPreview />, 'onboarding');
