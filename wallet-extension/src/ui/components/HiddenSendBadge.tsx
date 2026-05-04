/**
 * lock icon + "private" tooltip rendered on activity-feed rows for pc-* signed txs (pc-wrap,
 * pc-transfer-hidden, pc-unwrap). same pattern as `EncryptedNoteBadge`.
 *
 * pre-alpha disclaimer: encrypt.xyz pre-alpha PC-Token; ciphertexts may be plaintext on-chain
 * during devnet testing. UI must reinforce this in the disclaimer modal copy.
 */

import { Lock } from 'lucide-react';

export function HiddenSendBadge({ size = 12 }: { size?: number }) {
  return (
    <span
      title="private pcToken transfer (encrypt.xyz pre-alpha) — sender visible, amount + recipient hidden"
      className="sp-hiddenSendBadge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
        opacity: 0.75,
      }}
    >
      <Lock size={size} aria-label="hidden transfer" />
    </span>
  );
}
