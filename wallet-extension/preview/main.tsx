import '../src/buffer-polyfill';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { UnlockScreen } from '../src/ui/unlock-screen';
import { CodeCurrent } from '../src/ui/effects/code-current';
import { ChooseStep } from '../src/ui/wallet-setup-flow/steps/choose';
import { cardStyle } from '../src/ui/wallet-setup-flow/internal';
import type { WalletSetupHook } from '../src/ui/wallet-setup-flow/use-wallet-setup';
import '../src/ui/wallet.css';
import '../src/ui/wallet-setup-choose.css';

type SurfaceKind = 'popup' | 'sidepanel';

type Route = {
  slug: string;
  label: string;
  render: (surface: SurfaceKind) => JSX.Element;
};

const ROUTES: Route[] = [
  {
    slug: 'unlock',
    label: 'unlock',
    render: () => <UnlockPreview />,
  },
  {
    slug: 'unlock-bio',
    label: 'unlock (biometrics)',
    render: () => <UnlockPreview withBiometrics />,
  },
  {
    slug: 'unlock-error',
    label: 'unlock (error)',
    render: () => <UnlockPreview initialError="wrong password - try again" />,
  },
  {
    slug: 'unlock-mixed',
    label: 'unlock (password + passkey)',
    render: () => <UnlockPreview extraMethodsKind="mixed" />,
  },
  {
    slug: 'unlock-passkey-only',
    label: 'unlock (passkey only)',
    render: () => <UnlockPreview extraMethodsKind="passkey-only" />,
  },
  {
    slug: 'fx-code-fish',
    label: 'fx: code under the surface',
    render: () => (
      <CodeCurrent options={{ targetSelectors: ['.sp-input', '.sp-btnPrimary'], count: 24 }}>
        <UnlockPreview />
      </CodeCurrent>
    ),
  },
  {
    slug: 'fx-code-bare',
    label: 'fx: effect only',
    render: () => <CodeCurrent options={{ count: 18 }} />,
  },
  {
    slug: 'onboarding-buttons',
    label: 'onboarding buttons',
    render: () => <OnboardingButtonsPreview />,
  },
  {
    slug: 'wallet-setup-choose',
    label: 'choose step (sui+solana)',
    render: (surface) => <ChooseStepPreview surface={surface} />,
  },
];

function ChooseStepPreview({ surface }: { surface: SurfaceKind }) {
  const [intent, setIntent] = useState<WalletSetupHook['intent']>(null);
  const [step, setStep] = useState<WalletSetupHook['step']>('choose');
  const [reuseVaultSelect, setReuseVaultSelect] = useState('');
  const [crossChainReuseVaultId, setCrossChainReuseVaultId] = useState<string | null>(null);
  // ChooseStep only reads a narrow slice of WalletSetupHook; cast through `unknown` so the
  // preview doesn't pull in the full hook (which would try to reach trpc / chrome.storage).
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
    effectiveIkaBase: 'sui' as const,
    ikaChainLabel: 'Sui',
    otherChainHdVaults: [],
  } as unknown as WalletSetupHook;
  return (
    <ChooseStep
      surface={surface as 'popup' | 'sidepanel'}
      box={cardStyle(surface as 'popup' | 'sidepanel')}
      hook={mockHook}
    />
  );
}

function OnboardingButtonsPreview() {
  // headless preview can't toggle :hover / :focus-visible, so we force the hover state
  // via a demo-only class that duplicates the relevant rules. defaults to ON so the demo
  // shows the animation immediately; click the toggle to see the rest state.
  const [forced, setForced] = useState(true);
  const cls = (c: string) => `${c}${forced ? ' demo-forced' : ''}`;
  return (
    <div className="ws-choose" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <style>{`
        .ws-choose-btn--primary.demo-forced {
          --ws-proceed-border-angle: 0deg;
          background:
            linear-gradient(135deg, rgba(132, 94, 247, 0.95), rgba(20, 184, 166, 0.88)) padding-box,
            conic-gradient(
              from var(--ws-proceed-border-angle),
              #7cf0c4, #6366f1, #f472b6, #fbbf24, #7cf0c4
            ) border-box;
          background-clip: padding-box, border-box;
          -webkit-background-clip: padding-box, border-box;
          background-origin: padding-box, border-box;
          box-shadow: 0 4px 14px rgba(124, 92, 252, 0.5);
          filter: brightness(1.05);
          text-decoration-line: underline;
          text-decoration-color: rgba(255, 255, 255, 0.75);
          text-decoration-thickness: 1px;
          text-underline-offset: 3px;
          animation: ws-proceed-border-hue 2.8s linear infinite;
        }
        .ws-choose-btn--secondary.demo-forced {
          --ws-proceed-border-angle: 0deg;
          background:
            linear-gradient(rgba(22, 30, 54, 0.96), rgba(14, 20, 38, 0.96)) padding-box,
            conic-gradient(
              from var(--ws-proceed-border-angle),
              #7cf0c4, #6366f1, #f472b6, #fbbf24, #7cf0c4
            ) border-box;
          background-clip: padding-box, border-box;
          -webkit-background-clip: padding-box, border-box;
          background-origin: padding-box, border-box;
          box-shadow: 0 3px 12px rgba(124, 92, 252, 0.45);
          text-decoration-line: underline;
          text-decoration-color: rgba(255, 255, 255, 0.75);
          text-decoration-thickness: 1px;
          text-underline-offset: 3px;
          animation: ws-proceed-border-hue 2.8s linear infinite;
        }
        .ws-choose-select.demo-forced {
          --ws-proceed-border-angle: 0deg;
          background:
            url("data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'%3E%3Cpath d='M1 1L6 6L11 1' stroke='%23eaf0ff' stroke-opacity='0.9' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 16px center padding-box,
            linear-gradient(rgba(22, 30, 54, 0.96), rgba(14, 20, 38, 0.96)) padding-box,
            conic-gradient(
              from var(--ws-proceed-border-angle),
              #7cf0c4, #6366f1, #f472b6, #fbbf24, #7cf0c4
            ) border-box;
          background-clip: padding-box, padding-box, border-box;
          -webkit-background-clip: padding-box, padding-box, border-box;
          background-origin: padding-box, padding-box, border-box;
          box-shadow: 0 3px 12px rgba(124, 92, 252, 0.45);
          text-decoration-line: underline;
          text-decoration-color: rgba(255, 255, 255, 0.75);
          text-decoration-thickness: 1px;
          text-underline-offset: 3px;
          animation: ws-proceed-border-hue 2.8s linear infinite;
        }
      `}</style>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(234,240,255,0.55)', fontWeight: 600 }}>
        primary
      </div>
      <button className={cls('ws-choose-btn ws-choose-btn--primary')}>create new wallet</button>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(234,240,255,0.55)', fontWeight: 600, marginTop: 8 }}>
        secondary (after)
      </div>
      <button className={cls('ws-choose-btn ws-choose-btn--secondary')}>import wallet</button>
      <div style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(234,240,255,0.55)', fontWeight: 600, marginTop: 8 }}>
        select (after)
      </div>
      <select className={cls('ws-choose-select')} defaultValue="">
        <option value="" disabled>choose a network</option>
        <option>sui</option>
        <option>solana</option>
      </select>
      <button
        type="button"
        onClick={() => setForced((f) => !f)}
        style={{ marginTop: 14, padding: '6px 12px', fontSize: 11, background: 'rgba(255,255,255,0.08)', color: 'rgba(234,240,255,0.9)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, cursor: 'pointer' }}
      >
        {forced ? 'show rest state' : 'show hover state'}
      </button>
    </div>
  );
}

function UnlockPreview({
  withBiometrics = false,
  initialError = null,
  extraMethodsKind,
}: {
  withBiometrics?: boolean;
  initialError?: string | null;
  /** demo: 'mixed' shows password + passkey buttons; 'passkey-only' hides the password form. */
  extraMethodsKind?: 'mixed' | 'passkey-only';
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(initialError);
  const [bioBusy, setBioBusy] = useState(false);
  const extraMethods = extraMethodsKind
    ? [
        {
          id: 'env-passkey-1',
          kind: 'passkey-prf' as const,
          label: 'unlock with passkey',
          hint: 'face id · fingerprint · pin',
          onClick: () => setError('passkey assertion would run here in the real wallet.'),
        },
      ]
    : undefined;
  return (
    <UnlockScreen
      password={password}
      onPasswordChange={(v) => {
        setPassword(v);
        if (error) setError(null);
      }}
      onSubmit={() => setError(password ? null : 'enter a password')}
      error={error}
      bioEnrolled={withBiometrics}
      bioBusy={bioBusy}
      onBiometricUnlock={() => {
        setBioBusy(true);
        setTimeout(() => setBioBusy(false), 900);
      }}
      extraMethods={extraMethods}
      hidePasswordSection={extraMethodsKind === 'passkey-only'}
    />
  );
}

function currentSlug(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return ROUTES.find((r) => r.slug === hash)?.slug ?? ROUTES[0].slug;
}

function App() {
  const [slug, setSlug] = useState(currentSlug());
  const route = ROUTES.find((r) => r.slug === slug) ?? ROUTES[0];
  return (
    <>
      <div className="preview-nav">
        {ROUTES.map((r) => (
          <a
            key={r.slug}
            href={`#${r.slug}`}
            className={r.slug === slug ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              window.location.hash = r.slug;
              setSlug(r.slug);
            }}
          >
            {r.label}
          </a>
        ))}
      </div>
      <div className="preview-frame">
        <div>
          <p className="preview-label">popup · 360×600</p>
          <div className="preview-surface preview-surface--popup">
            <div className="sp-root sp-popupDocumentShell sp-unlock" style={{ height: '100%' }} key={`popup-${route.slug}`}>
              {route.render('popup')}
            </div>
          </div>
        </div>
        <div>
          <p className="preview-label">side panel · 400×720</p>
          <div className="preview-surface preview-surface--sidepanel">
            <div className="sp-root sp-unlock" style={{ height: '100%' }}>
              <div className="sp-bodyScroll" style={{ height: '100%' }}>
                <div className="sp-contentTrackShell" style={{ height: '100%' }}>
                  <div className="sp-contentTrack ch-scrollbar" style={{ height: '100%' }} key={`sp-${route.slug}`}>
                    {route.render('sidepanel')}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const container = document.getElementById('root')! as HTMLElement & { __previewRoot?: ReturnType<typeof createRoot> };
const root = container.__previewRoot ?? createRoot(container);
container.__previewRoot = root;
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
