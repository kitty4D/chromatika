/**
 * payments page: promoted from a `SettingsPage` section to a top-level tab. houses everything
 * x402: daily caps, receipts feed, private-receipts toggle (encrypts amount + counterparty in
 * `chromatika_x402_receipts_v1` so the local payment history isn't readable by other extensions
 * or malware on the machine).
 *
 * accessed via the Payments icon in the four-icon expandable tray (between IKA Staking + Lab + Agents).
 */

import { PaymentsSettingsSection } from '@/ui/components/PaymentsSettingsSection';
import { X402ReceiptsSection } from '@/ui/components/X402ReceiptsSection';
import { X402PrivateReceiptsSection } from '@/ui/components/X402PrivateReceiptsSection';

export function PaymentsPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="sp-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <div className="sp-pageTitle">payments · x402</div>
      </div>

      <p className="sp-muted" style={{ fontSize: 11, marginTop: 0 }}>
        chromatika auto-handles HTTP 402 (x402) micropayments — when a page returns a payment-required
        response, the wallet decodes it, asks for your approval, signs the Solana versioned tx, and
        retries the request with a payment-signature header. caps below limit how much can be spent
        per counterparty + globally per day. receipts below log every settlement.
      </p>

      <PaymentsSettingsSection />

      <X402PrivateReceiptsSection />

      <X402ReceiptsSection />
    </div>
  );
}
