/**
 * Placeholder page exports for the marketing iframe preview.
 *
 * Aliased into vite's preview-build config so any tab/overlay that crashes or stalls
 * in static mode (Policy, IkaStaking, ChromaLab, Payments, Agents, VaultManagement,
 * DWalletManagement) renders a friendly explanation instead of an
 * unresolved loading state or a "Cannot read properties of null" crash.
 *
 * Each named export matches the real wallet module's named export so vite's resolve
 * alias swaps modules cleanly without breaking any importer.
 */

import type { ReactNode } from 'react';

const wrapperStyle: React.CSSProperties = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: '32px 24px',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: 'oklch(0.78 0.04 270)',
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  fontFamily: '"Bricolage Grotesque", system-ui, sans-serif',
  fontWeight: 700,
  fontSize: 22,
  letterSpacing: '0.01em',
  color: 'oklch(0.94 0.02 260)',
  margin: 0,
};

const kickerStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'oklch(0.78 0.14 245)',
  margin: 0,
};

const bodyStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.55,
  margin: 0,
  maxWidth: 280,
};

function PlaceholderPage({ label, body }: { label: string; body?: ReactNode }) {
  return (
    <div className="sp-page" style={wrapperStyle} data-preview-placeholder={label}>
      <p style={kickerStyle}>live preview</p>
      <h1 style={titleStyle}>{label}</h1>
      <p style={bodyStyle}>
        {body ?? (
          <>
            this surface is not available in the live preview. install the chromatika
            extension to use it for real.
          </>
        )}
      </p>
    </div>
  );
}

export function IkaStakingPage(): ReactNode {
  return <PlaceholderPage label="ika staking" />;
}

export function ChromaLabPage(): ReactNode {
  return (
    <PlaceholderPage
      label="chromalab (encrypt.xyz testing)"
      body="encrypted-input lab tools (encrypt + read ciphertext) are not available in the live preview. install the extension on devnet to play with the encrypt.xyz pre-alpha surface."
    />
  );
}

export function PaymentsPage({ onBack: _onBack }: { onBack?: () => void }): ReactNode {
  void _onBack;
  return (
    <PlaceholderPage
      label="x402 payments"
      body="HTTP 402 fetch interception, USDC payment caps, and per-counterparty receipts are not available in the live preview."
    />
  );
}

export function AgentsPage({ onBack: _onBack }: { onBack?: () => void }): ReactNode {
  void _onBack;
  return (
    <PlaceholderPage
      label="mcp agent surface"
      body="the model-context-protocol native messaging surface is not available in the live preview. install the extension + native host to expose chromatika as MCP tools."
    />
  );
}

export function PolicyVaultPage(): ReactNode {
  return (
    <PlaceholderPage
      label="policy vault"
      body="on-chain spend caps, panic, and rescue (PolicyVault) require a real dWallet + Move/Anchor package id and are not available in the live preview."
    />
  );
}

export function VaultManagementScreen({
  onBack: _onBack,
}: {
  onBack?: () => void;
}): ReactNode {
  void _onBack;
  return (
    <PlaceholderPage
      label="vault management"
      body="creating, importing, switching, renaming, and removing dWallet Vaults are not available in the live preview."
    />
  );
}

export function DWalletManagementScreen({
  onBack: _onBack,
}: {
  onBack?: () => void;
}): ReactNode {
  void _onBack;
  return (
    <PlaceholderPage
      label="dWallet management"
      body="managing dWallets (DKG, transfer, encryption-key registration, presign refill) is not available in the live preview."
    />
  );
}
