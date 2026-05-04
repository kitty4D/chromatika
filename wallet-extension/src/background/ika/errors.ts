/**
 * single home for friendly ika error mapping. two distinct concerns live here:
 *
 *   1. **Sui transport / init errors** - `friendlyIkaClientError`, `withFriendlyIkaError`.
 *      ika SDK surfaces `Network error` when coordinator / encryption-key reads fail. chromatika
 *      wires `IkaClient` to **`SuiGraphQLClient`** only; this maps the SDK's wrappers into
 *      actionable copy that names the GraphQL endpoint, the coordinator/system object ids, and
 *      the most likely fix (wrong network, rate limit, bad custom URL, ika not deployed there).
 *
 *   2. **Server-says-dWallet-gone** - `DWalletGoneError`, `isDWalletGoneServerMessage`.
 *      ika Solana pre-alpha gRPC returns "no key for dwallet ... or scheme ... incompatible
 *      with curve ..." after a devnet wipe. we type that as `DWalletGoneError` so the UI can
 *      offer a "recreate dWallet" recovery affordance instead of just printing the raw error.
 *      gated to non-mainnet clusters by the call site (mainnet ika Solana doesn't run per the
 *      pre-alpha disclaimer).
 *
 * adding new ika error classifications: add a new typed class + matcher here. signing call
 * sites then `instanceof` to branch.
 */

import type { CurveKey } from '@/background/session';
import { getSession } from '@/background/session';
import { graphqlUrlForNetwork } from '@/config/sui';

// ---------------------------------------------------------------------------
// Sui transport / ika client init errors
// ---------------------------------------------------------------------------

/** appended to friendly ika errors so engineers can see exactly which endpoint + objects were used */
function ikaTransportDebugSuffix(): string {
  const s = getSession();
  if (!s) return '';
  const gql = graphqlUrlForNetwork(s.network);
  const coord = s.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID;
  const sys = s.ikaClient.ikaConfig.objects.ikaSystemObject.objectID;
  return (
    ` [ika: GraphQL POST ${gql} · vaultNetwork=${s.network} · ikaCoordinator=${coord} · ikaSystem=${sys}]`
  );
}

function causeSnippet(err: unknown): string {
  if (!(err instanceof Error)) return '';
  const c = err.cause;
  if (c instanceof Error) return c.message;
  if (c !== undefined && c !== null) return String(c);
  return '';
}

/** walk `Error.cause` so we surface Mysten `Object ... not found` instead of ika's generic wrapper. */
function deepestCauseMessage(err: unknown, maxDepth = 8): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  let d = 0;
  while (cur instanceof Error && d < maxDepth && !seen.has(cur)) {
    seen.add(cur);
    if (cur.message) messages.push(cur.message);
    cur = (cur as Error & { cause?: unknown }).cause;
    d++;
  }
  const genericIka = /^Network error: Failed to fetch objects$/i;
  const nonGeneric = messages.filter((m) => !genericIka.test(m));
  const preferObject = nonGeneric.find((m) =>
    /Object 0x[0-9a-f]+/i.test(m) || /does not exist|not found|notExists|GraphQL|fetch failed/i.test(m),
  );
  const pick = preferObject ?? nonGeneric[nonGeneric.length - 1] ?? messages[messages.length - 1] ?? '';
  return pick.length > 320 ? `${pick.slice(0, 320)}…` : pick;
}

function suiObjectExplorerLines(network: 'mainnet' | 'testnet', coordinatorId: string, systemId: string): string {
  const net = network === 'mainnet' ? 'mainnet' : 'testnet';
  return (
    ` Verify objects in an explorer: ${coordinatorId.slice(0, 10)}… → https://suiscan.xyz/${net}/object/${coordinatorId} · ` +
    `${systemId.slice(0, 10)}… → https://suiscan.xyz/${net}/object/${systemId}`
  );
}

export function friendlyIkaClientError(err: unknown): Error {
  if (err instanceof Error && err.message.startsWith('Could not load ika')) {
    return err;
  }
  const raw = err instanceof Error ? err.message : String(err);
  const cause = causeSnippet(err);
  const blob = `${raw} ${cause}`;

  if (/429|Too Many Requests/i.test(blob) || /Unexpected status code:\s*429/i.test(blob)) {
    return new Error(
      `Sui GraphQL rate-limited this session (HTTP 429). Public endpoints cap bursts; ika loads many objects back-to-back. ` +
        `Wait 30-60s and try again. If it keeps happening, use a dedicated GraphQL endpoint with higher limits when Settings exposes custom Sui URLs.` +
        ikaTransportDebugSuffix(),
    );
  }

  // ika wraps inner failures: root cause is often "Failed to fetch objects" (coordinator init), not encryption keys.
  if (/Failed to fetch objects/i.test(blob) || /Network error: Failed to fetch objects/i.test(raw)) {
    const deep = err instanceof Error ? deepestCauseMessage(err) : '';
    const shallow = cause ? cause.slice(0, 220) + (cause.length > 220 ? '…' : '') : '';
    const detail =
      deep && deep !== raw && !/^Network error: Failed to fetch objects$/i.test(deep)
        ? ` ${deep}`
        : shallow && shallow !== raw
          ? ` (${shallow})`
          : '';
    const s = getSession();
    const explore =
      s && (s.network === 'mainnet' || s.network === 'testnet')
        ? suiObjectExplorerLines(
            s.network,
            s.ikaClient.ikaConfig.objects.ikaDWalletCoordinator.objectID,
            s.ikaClient.ikaConfig.objects.ikaSystemObject.objectID,
          )
        : '';
    return new Error(
      `Could not load ika coordinator / system objects from Sui (init step before encryption keys).${detail}` +
        ` Uses the same GraphQL POST as balances - open the extension service worker console (chrome://extensions → Chromatika → service worker → Inspect) for Mysten / GraphQL errors.` +
        explore +
        ` Wrong vault network (mainnet vs testnet), a bad custom GraphQL URL, or an offline / blocked request looks the same in the UI.` +
        ikaTransportDebugSuffix(),
    );
  }

  if (/Failed to fetch encryption keys/i.test(blob) || (/Network error/i.test(raw) && /encryption keys/i.test(raw))) {
    const tail = cause ? ` (${cause.slice(0, 220)}${cause.length > 220 ? '…' : ''})` : '';
    return new Error(
      `Could not load ika network encryption keys from Sui.${tail} ` +
        `Chromatika reads ika data via your active Sui GraphQL endpoint. ` +
        `Common causes: ika is not deployed on this network (try testnet if you use mainnet), ` +
        `timeout or rate limits, or a bad custom URL. Open Settings → networks, pick a working endpoint, and retry.` +
        ikaTransportDebugSuffix(),
    );
  }

  if (/Network encryption keys.*not found/i.test(raw) || /Network encryption keys object not found/i.test(raw)) {
    return new Error(
      `No ika network encryption keys on this Sui network. ` +
        `Switch to the network where ika is deployed (often testnet) under Settings → networks.` +
        ikaTransportDebugSuffix(),
    );
  }

  return err instanceof Error ? err : new Error(raw);
}

export async function withFriendlyIkaError<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await Promise.resolve(fn());
  } catch (e) {
    throw friendlyIkaClientError(e);
  }
}

// ---------------------------------------------------------------------------
// Server-says-dWallet-gone (ika Solana pre-alpha gRPC)
// ---------------------------------------------------------------------------

export class DWalletGoneError extends Error {
  readonly kind = 'dwallet-gone' as const;
  readonly curve: CurveKey;
  readonly cluster: 'devnet' | 'testnet' | 'localnet' | 'mainnet';
  readonly serverMessage: string;

  constructor(args: {
    curve: CurveKey;
    cluster: 'devnet' | 'testnet' | 'localnet' | 'mainnet';
    serverMessage: string;
  }) {
    super(
      `Ika ${args.cluster} has no record of your ${args.curve} dWallet. The pre-alpha network likely wiped - recreate the dWallet to continue.`,
    );
    this.name = 'DWalletGoneError';
    this.curve = args.curve;
    this.cluster = args.cluster;
    this.serverMessage = args.serverMessage;
  }
}

const NO_KEY_FOR_DWALLET_PATTERN = /no key for dwallet/i;

/** cheap regex sniff against the server-error message. not a strict parse. */
export function isDWalletGoneServerMessage(message: string): boolean {
  return NO_KEY_FOR_DWALLET_PATTERN.test(message);
}
