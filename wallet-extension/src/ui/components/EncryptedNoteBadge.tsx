/**
 * tiny lock icon + "encrypted note" tooltip. renders next to an activity row when the row has
 * an encrypted note attached (`item.hasEncryptedNote === true`). click handler is on the parent
 * row (the badge itself is purely visual feedback).
 *
 * pre-alpha disclaimer: encrypt.xyz pre-alpha, clicking the row to decrypt will trigger an ika
 * MPC sign (signMessageSol on the active vault's dWallet ed25519 key). the note is not real
 * production-grade secret storage; ciphertexts can be plaintext on-chain in pre-alpha. UI must
 * reinforce this in the modal copy.
 */

import { Lock } from 'lucide-react';

export function EncryptedNoteBadge({ size = 12 }: { size?: number }) {
  return (
    <span
      title="encrypted note (encrypt.xyz pre-alpha)"
      className="sp-encryptedNoteBadge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: 6,
        opacity: 0.75,
      }}
    >
      <Lock size={size} aria-label="encrypted note attached" />
    </span>
  );
}
