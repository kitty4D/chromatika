import { router } from './trpc';
import { vaultProcedures } from './routers/vault';
import { dwalletProcedures } from './routers/dwallet';
import { sendProcedures } from './routers/send';
import { dappProcedures } from './routers/dapp';
import { networkProcedures } from './routers/network';
import { hwProcedures } from './routers/hw';
import { passkeyProcedures } from './routers/passkey';
import { swapProcedures } from './routers/swap';
import { assetsProcedures } from './routers/assets';
import { encryptProcedures } from './routers/encrypt';
import { ikaFeesProcedures } from './routers/ika-fees';
import { mcpProcedures } from './routers/mcp';
import { x402Procedures } from './routers/x402';
import { activityNotesProcedures } from './routers/activity-notes';
import { alertsProcedures } from './routers/alerts';
import { pcTokenProcedures } from './routers/pc-token';
import { desoProcedures } from './routers/deso';
import { policyVaultProcedures } from './routers/policy-vault';
import { scanProcedures } from './routers/scan';
import { onboardingProcedures } from './routers/onboarding';

/**
 * tRPC root router, flat namespace built from per-domain procedure groups.
 * procedure names stay flat at the wire level (e.g. `trpc.unlockVault.mutate(...)`)
 * by spreading each group instead of nesting sub-routers.
 */
export const appRouter = router({
  ...vaultProcedures,
  ...dwalletProcedures,
  ...sendProcedures,
  ...dappProcedures,
  ...networkProcedures,
  ...hwProcedures,
  ...passkeyProcedures,
  ...swapProcedures,
  ...assetsProcedures,
  ...encryptProcedures,
  ...ikaFeesProcedures,
  ...mcpProcedures,
  ...x402Procedures,
  ...activityNotesProcedures,
  ...alertsProcedures,
  ...pcTokenProcedures,
  ...desoProcedures,
  ...policyVaultProcedures,
  ...scanProcedures,
  ...onboardingProcedures,
});

export type AppRouter = typeof appRouter;
