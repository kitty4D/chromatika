/**
 * tRPC procedures for the onboarding flow that need a server-side trigger from the UI.
 *
 * v1 surface:
 *   - `retryTeamFunding`: re-runs the team faucet against the active session's Sui fee-payer
 *     address. fired by the `OperationProgressBanner` "Retry" action when an automatic
 *     funding attempt failed during onboarding. the faucet itself is the same module called
 *     automatically by `finalizeUnlock`; this procedure just surfaces it as a retry hook.
 *
 * the helper writes its own progress to `chrome.storage.session` via `beginOperation`, so the
 * caller only awaits a structured status code - the banner observes the storage key directly.
 */

import { publicProcedure } from '../trpc';
import { retryTeamFundingFromActiveSession } from '@/background/wallet-service-helpers';

export const onboardingProcedures = {
  retryTeamFunding: publicProcedure.mutation(async () => {
    await retryTeamFundingFromActiveSession();
    return { ok: true };
  }),
};
