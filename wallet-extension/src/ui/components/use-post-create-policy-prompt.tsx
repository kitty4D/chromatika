/**
 * Shared trigger + modal-mount for the post-dWallet-creation Policy Vault prompt.
 *
 * Both `WalletPage` (empty-state CreateDwalletPrompt path) and `DWalletManagementScreen`
 * (DWalletPanel's manual-create path) need to surface the same modal after a SECP256K1
 * DKG resolves on a Sui-base vault. This hook centralizes the eligibility check + modal
 * lifecycle so the two screens stay in lockstep.
 *
 * Usage:
 *   const { triggerAfterCreate, modal } = usePostCreatePolicyPrompt(onOpenPolicyVault);
 *   // after `trpc.createDWallet.mutate({ curve })` resolves:
 *   triggerAfterCreate(curve);
 *   // anywhere in render:
 *   {modal}
 */

import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { PostCreatePolicyVaultPrompt } from './PostCreatePolicyVaultPrompt';

export function usePostCreatePolicyPrompt(
  /** Called when the user picks "Customize first" or the "what does each setting mean?"
   *  link inside the modal. Parent should navigate to Settings -> Security -> Policy Vault. */
  onOpenPolicyVault?: () => void,
  /** Called after a successful one-click wrap; parent should refresh balances + policy
   *  state. If omitted, no follow-up runs. */
  onWrapped?: () => void,
): { triggerAfterCreate: (curve: 'SECP256K1' | 'ED25519') => void; modal: React.ReactNode } {
  const [show, setShow] = useState<null | 'SECP256K1' | 'ED25519'>(null);

  function triggerAfterCreate(curve: 'SECP256K1' | 'ED25519') {
    // Eligibility check: bail on any error or any negative signal. Fail-closed - losing
    // the prompt is acceptable; surfacing it incorrectly isn't. Both curves are
    // wrappable; the modal body shows curve-aware copy so the user understands which
    // enforcement layer applies (hard decoders for SECP-signed chains, soft cap only
    // for ED25519-signed chains until decoders ship). With per-dwallet wraps, we
    // intentionally do NOT bail on `state.links.length > 0` - each new dWallet is its
    // own decision; the active-for-curve dWallet (the one just created) gets wrapped
    // by `optInToPolicyVault`'s default. Users who want to silence this entirely flip
    // the "don't ask me again" toggle, which sets the global dismissed flag below.
    void (async () => {
      try {
        const state = await trpc.getPolicyVaultState.query();
        if (state.activeVaultBaseChain !== 'sui') return;
        if (!state.packageConfig?.packageId) return;
        const promptState = await trpc.getPolicyVaultPromptState.query();
        if (promptState.globallyDismissed) return;
        setShow(curve);
      } catch {
        /* fail-closed */
      }
    })();
  }

  const modal = show ? (
    <PostCreatePolicyVaultPrompt
      curve={show}
      onClose={() => setShow(null)}
      onWrapped={() => {
        setShow(null);
        onWrapped?.();
      }}
      onCustomize={() => {
        setShow(null);
        onOpenPolicyVault?.();
      }}
    />
  ) : null;

  return { triggerAfterCreate, modal };
}
