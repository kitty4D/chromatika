/**
 * tRPC procedures for the onboarding flow that need a server-side trigger from the UI.
 *
 * surface:
 *   - `getTeamFundingOffer` (query): eligibility snapshot for the team-funding consent banner.
 *     `eligible: true` only when the session is unlocked, the active vault is Sui-base, funder
 *     env vars are baked into the build, this is the user's FIRST vault on the device, AND
 *     no decision is already recorded for that vault id. UI polls / refetches around vault
 *     create + unlock; banner renders only on eligible.
 *   - `acceptTeamFundingOffer` (mutation): user said yes. records 'accepted' BEFORE firing
 *     the fetch (idempotent under double-tap), then queues `triggerTeamFunding` which
 *     surfaces progress + retry through the existing OperationProgressBanner.
 *   - `declineTeamFundingOffer` (mutation): user said no. records 'declined' so the offer
 *     banner never returns for that vault id.
 *   - `retryTeamFunding` (mutation): re-runs the team faucet against the active session's
 *     Sui fee-payer address. fired by the OperationProgressBanner "Retry" action when an
 *     in-flight funding attempt failed. routes through the same `triggerTeamFunding` helper
 *     so progress flows through the same banner pipeline.
 */

import { publicProcedure } from '../trpc';
import { retryTeamFundingFromActiveSession } from '@/background/wallet-service-helpers';
import {
  acceptTeamFundingOffer,
  declineTeamFundingOffer,
  getTeamFundingOffer,
} from '@/background/team-funding-offer';

export const onboardingProcedures = {
  getTeamFundingOffer: publicProcedure.query(async () => {
    return await getTeamFundingOffer();
  }),
  acceptTeamFundingOffer: publicProcedure.mutation(async () => {
    return await acceptTeamFundingOffer();
  }),
  declineTeamFundingOffer: publicProcedure.mutation(async () => {
    return await declineTeamFundingOffer();
  }),
  retryTeamFunding: publicProcedure.mutation(async () => {
    await retryTeamFundingFromActiveSession();
    return { ok: true };
  }),
};
