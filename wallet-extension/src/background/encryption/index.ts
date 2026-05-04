/**
 * EncryptionBackend registry / factory. picks a concrete backend per use case.
 *
 * default mapping today:
 *   - self-recipient default = `EncryptXyzBackend` (encrypt.xyz as primary integration; self-only
 *     is what pre-alpha supports).
 *   - cross-recipient default = `DirectEd25519Backend` (stub today; throws on call)
 *
 * decrypt routing dispatches by `ref.backend` so a mixed install (some encrypt-xyz refs, some
 * future direct-ed25519 refs after the stub lands) works without the caller knowing which
 * backend produced the ref.
 *
 * see `wallet-extension/docs/ENCRYPTION_BACKEND.md` for the per-use-case decision matrix.
 */

import type { EncryptedRef, EncryptionBackend, EncryptionBackendId } from '@/background/encryption/types';
import { encryptXyzBackend } from '@/background/encryption/encrypt-xyz-backend';
import { directEd25519Backend } from '@/background/encryption/direct-ed25519-backend';

export type EncryptionUseCase =
  /** active vault encrypts to its own dWallet (labels, notes, vault backup). */
  | 'self-recipient-default'
  /** sender encrypts to a different recipient's dWallet (drain reports, gifts, P2P chat). */
  | 'cross-recipient-default';

const REGISTRY: Record<EncryptionBackendId, EncryptionBackend> = {
  'encrypt-xyz': encryptXyzBackend,
  'direct-ed25519': directEd25519Backend,
  // intentionally absent today: 'seal' - blocked on chromatika sui_signPersonalMessage BLAKE2b
  // parity (see WALLET_SECURITY.md). add when the parity fix ships.
  seal: {
    id: 'seal',
    capabilities: {
      supportsCrossRecipient: true,
      supportsThresholdAccess: true,
      supportsInlineBody: false,
      maxInlinePlaintextBytes: 0,
    },
    async encryptForRecipient() {
      throw new Error('SealBackend not implemented in this slice (BLAKE2b parity gap). See wallet-extension/docs/ENCRYPTION_BACKEND.md.');
    },
    async decrypt() {
      throw new Error('SealBackend not implemented in this slice (BLAKE2b parity gap). See wallet-extension/docs/ENCRYPTION_BACKEND.md.');
    },
  },
};

export function getEncryptionBackend(useCase: EncryptionUseCase): EncryptionBackend {
  switch (useCase) {
    case 'self-recipient-default':
      return REGISTRY['encrypt-xyz']!;
    case 'cross-recipient-default':
      return REGISTRY['direct-ed25519']!;
  }
}

/**
 * dispatch decrypt by the ref's backend tag. use this whenever a stored `EncryptedRef` may have
 * been written by a different backend than the current default. activity notes always use the
 * self-recipient default today, so the notes router can call the backend directly - this
 * registry-routed decrypt is for callers that handle mixed-backend stores.
 */
export async function decryptRefViaRegistry(ref: EncryptedRef): Promise<Uint8Array> {
  const backend = REGISTRY[ref.backend];
  if (!backend) {
    throw new Error(`unknown encryption backend on ref: ${ref.backend}`);
  }
  return backend.decrypt(ref);
}

export { encryptXyzBackend, directEd25519Backend };
