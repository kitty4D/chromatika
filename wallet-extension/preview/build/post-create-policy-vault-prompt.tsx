/**
 * PostCreatePolicyVaultPrompt preview. Mounts the bottom-sheet modal directly so
 * design can iterate on copy, spacing, and gradient/ease tokens without running
 * the chrome extension or simulating a full DKG flow.
 *
 * Behavior:
 * - Default state: modal mounted, ready for snapshot.
 * - Clicking "wrap with these defaults" calls trpc-mock's `optInToPolicyVault`
 *   fixture (returns success); the modal then re-mounts so you can drive the
 *   path repeatedly.
 * - "customize first" + "what does each setting mean?" log + remount so design
 *   can verify the close path.
 */

import './chrome-stub';
import { useState } from 'react';
import { PostCreatePolicyVaultPrompt } from '@/ui/components/PostCreatePolicyVaultPrompt';
import '@/ui/wallet.css';
import { mountPreview } from './mount';

function Preview() {
  const [, force] = useState(0);
  // ?curve=ED25519 in the URL switches the prompt to the soft-cap copy variant.
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const curve: 'SECP256K1' | 'ED25519' = params?.get('curve') === 'ED25519' ? 'ED25519' : 'SECP256K1';
  return (
    <div className="ch-frame">
      <div className="sp-root sp-bodyScroll">
        <div className="sp-contentTrackShell" style={{ height: '100%' }}>
          <div
            className="sp-contentTrack ch-scrollbar"
            style={{ height: '100%', padding: 16, opacity: 0.5 }}
          >
            <p className="sp-muted" style={{ fontSize: 11 }}>
              preview backdrop - the modal mounts on top.{' '}
              <a href="?curve=SECP256K1" style={{ color: '#93c5fd' }}>SECP</a>{' '}
              ·{' '}
              <a href="?curve=ED25519" style={{ color: '#93c5fd' }}>ED25519</a>
            </p>
          </div>
        </div>
        <PostCreatePolicyVaultPrompt
          curve={curve}
          onClose={() => force((n) => n + 1)}
          onWrapped={() => force((n) => n + 1)}
          onCustomize={() => force((n) => n + 1)}
        />
      </div>
    </div>
  );
}

mountPreview(<Preview />, 'post-create-policy-vault-prompt');
