import {
  Curve,
  SignatureAlgorithm,
  type ZeroTrustDWallet,
} from '@ika.xyz/sdk';
import { getSession } from '@/background/session';
import type { CurveKey } from '@/background/session';
import { saveDwalletMeta } from '@/background/storage-meta';
import { replenishPool, takePresign, takePresignId, type PresignPoolKey } from '@/background/ika/presign-pool';
import type { IkaAdapter } from '@/background/ika/ika-adapter';
import { runSerializedIkaTx } from '@/background/ika/tx-serialize';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { listOwnedDWalletCapsForVault } from '@/background/ika/dwallet-discovery';
import type { IkaTxBenchSession } from '@/background/ika/ika-tx-benchmark';

export async function ikaBenchMeasure<T>(
  b: IkaTxBenchSession | undefined,
  phase: string,
  detail: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return b ? b.measure(phase, detail, fn) : fn();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function hexAddr(s: string): string {
  return s.startsWith('0x') ? s : `0x${s}`;
}

export function b64ToU8Local(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function hexToU8(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length === 0) return new Uint8Array(0);
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex for presign id');
  return Uint8Array.from(h.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
}

export function isStaleObjectVersionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /is not available for consumption, current version/i.test(msg);
}

/**
 * "Upstream request timeout" means the Sui node accepted and committed the IKA signing
 * PTB but the GraphQL response timed out. the presign WAS consumed and coins were mutated.
 * we must take a new presign and wait for the indexer before retrying.
 */
export function isUpstreamTimeoutError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('upstream request timeout') || msg.includes('upstream connect error');
}

/**
 * ika SDK `getPresignInParticularState` / `getSignInParticularState` polls until
 * the on-chain object reaches the target state. when the MPC ceremony doesn't
 * complete in time (validators busy / network lag), the SDK throws
 * "Timeout waiting for presign <id> to reach state Completed".
 * the presign was NOT consumed (signing PTB never ran), so we should take a fresh
 * one and retry.
 */
export function isPresignCompletionTimeout(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('timeout waiting for') && msg.includes('presign');
}

/** flatten `Error.cause`, `AggregateError.errors`, and `{ message }` for classification + logs. */
function suiReadErrorTextDeep(err: unknown): string {
  const seen = new Set<unknown>();
  const chunks: string[] = [];

  const walk = (e: unknown, depth: number) => {
    if (e == null || depth > 14) return;
    if (typeof e === 'object') {
      if (seen.has(e)) return;
      seen.add(e);
    }

    if (e instanceof AggregateError) {
      for (const sub of e.errors ?? []) walk(sub, depth + 1);
      if (e.message) chunks.push(e.message);
      walk(e.cause, depth + 1);
      return;
    }
    if (e instanceof Error) {
      chunks.push(e.message);
      walk(e.cause, depth + 1);
      return;
    }
    if (typeof e === 'object' && e !== null && 'message' in e) {
      const m = (e as { message: unknown }).message;
      if (typeof m === 'string') chunks.push(m);
      return;
    }
    chunks.push(String(e));
  };

  walk(err, 0);
  return chunks.join(' | ');
}

function formatSuiReadErrorOneLine(err: unknown): string {
  const t = suiReadErrorTextDeep(err).trim();
  return t.length > 520 ? `${t.slice(0, 520)}…` : t;
}

/**
 * Sui GraphQL / fetch occasionally returns an empty body, mysten + ethers surface that as
 * "unexpected end of input". short backoff retries avoid failing a sign after the PTB already committed.
 */
function isTransientSuiReadError(err: unknown): boolean {
  const msg = suiReadErrorTextDeep(err).toLowerCase();
  return (
    msg.includes('unexpected end of') ||
    msg.includes('invalid json') ||
    msg.includes('json parse') ||
    msg.includes('failed to fetch') ||
    msg.includes('network error') ||
    msg.includes('econnreset') ||
    msg.includes('429') ||
    msg.includes('502') ||
    msg.includes('503')
  );
}

export type TransientSuiReadRetryLog = { graphqlUrl: string; label: string };

export async function withTransientSuiReadRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; log?: TransientSuiReadRetryLog },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const log = opts?.log;
  /** always log when `log` is set, avoids env gating mismatches across worker chunks, only fires on real retries / exhaustion. */
  const wantLog = Boolean(log);
  let last: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const transient = isTransientSuiReadError(e);
      const lastAttempt = i === maxAttempts - 1;
      const msg = formatSuiReadErrorOneLine(e);
      if (!transient || lastAttempt) {
        if (wantLog) {
          if (transient && lastAttempt) {
            console.error(
              `[chromatika graphql] transient read retries exhausted (${maxAttempts}) - ${log!.label} - ${log!.graphqlUrl} -`,
              msg,
            );
          } else if (!transient) {
            console.warn(
              `[chromatika graphql] getSignInParticularState failed (not classified as transient, no auto-retry) - ${log!.label} - ${log!.graphqlUrl} -`,
              msg,
            );
          }
        }
        throw e;
      }
      if (wantLog) {
        console.warn(
          `[chromatika graphql] transient read retry ${i + 1}/${maxAttempts - 1} - ${log!.label} - ${log!.graphqlUrl} - ${msg}`,
        );
      }
      await sleep(400 * (i + 1) + Math.floor(Math.random() * 150));
    }
  }
  throw last instanceof Error ? last : new Error(String(last ?? 'sui read retry exhausted'));
}

// raw GQL to find recent sign-request txs from an owner, used for post-timeout recovery
const RECENT_SIGN_SESSIONS_QUERY = `
  query RecentSignSessions($addr: SuiAddress!) {
    transactionBlocks(filter: { signAddress: $addr }, last: 10, scanLimit: 20) {
      nodes {
        effects {
          events {
            nodes {
              type { repr }
              contents { json }
            }
          }
        }
      }
    }
  }
`;

/**
 * after an upstream timeout on executeTx, the signing PTB may have committed on chain
 * creating a sign session we never got the ID for. this queries the sender's recent
 * transactions, finds the one with a PresignRequestEvent matching our presign_id, and
 * returns the session_object_id so we can poll it instead of re-executing the full PTB.
 */
export async function tryRecoverSignSession(
  suiClient: SuiGraphQLClient,
  owner: string,
  presignId: string,
): Promise<string | undefined> {
  await sleep(6000); // let the indexer catch up to the committed tx
  try {
    type GqlResult = {
      transactionBlocks?: {
        nodes?: Array<{
          effects?: {
            events?: {
              nodes?: Array<{
                type?: { repr?: string };
                contents?: { json?: unknown };
              }>;
            };
          };
        }>;
      };
    };
    const res = await suiClient.query<GqlResult>({
      query: RECENT_SIGN_SESSIONS_QUERY,
      variables: { addr: owner },
    });
    const txNodes = res.data?.transactionBlocks?.nodes ?? [];
    for (const tx of txNodes) {
      const events = tx.effects?.events?.nodes ?? [];
      for (const evt of events) {
        const repr = evt.type?.repr ?? '';
        if (!repr.includes('PresignRequestEvent')) continue;
        const json = evt.contents?.json as Record<string, unknown> | null | undefined;
        if (!json) continue;
        // event structure: DWalletSessionEvent<PresignRequestEvent>
        // top-level has session_object_id, event_data has presign_id
        const eventData = json.event_data as Record<string, unknown> | undefined;
        if (eventData?.presign_id !== presignId) continue;
        const sessionId = json.session_object_id;
        if (typeof sessionId === 'string' && sessionId.startsWith('0x')) {
          return sessionId;
        }
      }
    }
  } catch {
    // recovery query failed, caller falls back to new presign
  }
  return undefined;
}

/**
 * retry helper for IKA signing transactions. takes a presign supplier so each retry
 * can get a fresh presign when needed:
 * - stale object version: indexer lag, presign was NOT consumed (tx failed), reuse presign, wait for coins
 * - upstream timeout: tx committed but response lost, presign WAS consumed, take new presign + wait
 */
export async function runSignWithRetry<T>(
  getPresignId: () => Promise<string>,
  fn: (presignId: string) => Promise<T>,
  maxAttempts = 4,
): Promise<T> {
  let presignId = await getPresignId();
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await runSerializedIkaTx(() => fn(presignId));
    } catch (e) {
      lastErr = e;
      const stale = isStaleObjectVersionError(e);
      const timeout = isUpstreamTimeoutError(e);
      const presignTimeout = isPresignCompletionTimeout(e);
      if ((!stale && !timeout && !presignTimeout) || attempt === maxAttempts - 1) throw e;
      // progressive backoff so the graphql indexer can catch up to recent coin mutations
      await sleep(2000 * (attempt + 1));
      if (timeout || presignTimeout) {
        // timeout: presign consumed by committed tx, take fresh one.
        // presignTimeout: MPC ceremony didn't complete, presign is stuck, take a different one.
        presignId = await getPresignId();
      }
      // stale object: presign intact (tx failed before consuming it), reuse same presignId
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'signing failed'));
}

export async function capIdForDwallet(_adapter: IkaAdapter, _owner: string, dwalletId: string): Promise<string> {
  const s = getSession();
  if (!s) throw new Error('Wallet locked');
  const target = hexAddr(dwalletId).toLowerCase();

  // use the resilient discovery path (raw Sui getOwnedObjects first, ika SDK enrichment as
  // best-effort) instead of calling adapter.getOwnedDWalletCaps directly, the SDK's BCS
  // decoder breaks when the on-chain package is upgraded and the local layout drifts.
  const caps = await listOwnedDWalletCapsForVault(s.activeVaultId);
  for (const cap of caps) {
    if (hexAddr(cap.dwalletId).toLowerCase() === target) {
      return cap.capObjectId;
    }
  }

  throw new Error(`No DWalletCap found for dWallet ${dwalletId}`);
}

function createdObjectIds(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effects: any,
): string[] {
  // SDK may surface changed objects as `changedObjects` or `objectChanges`
  const list: unknown[] = effects?.changedObjects ?? effects?.objectChanges ?? [];
  if (!Array.isArray(list) || !list.length) return [];
  return list
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((c: any) => c.idOperation === 'Created' || c.type === 'created')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((c: any) => c.objectId ?? c.objectID ?? '')
    .filter((id: string) => id.startsWith('0x'));
}

/** recursively collect all 0x...66 hex strings from a value. */
function collectHexIds(val: unknown, out: string[]): void {
  if (typeof val === 'string' && val.startsWith('0x') && val.length === 66) {
    out.push(val);
  } else if (val && typeof val === 'object') {
    for (const v of Object.values(val as Record<string, unknown>)) {
      collectHexIds(v, out);
    }
  }
}

/**
 * extract 0x...66 ids from ika events (best-effort).
 * handles SDK event shapes: `{ eventType, json }`, `{ type, parsedJson }`,
 * `{ contents: { type: { repr }, json } }`, and events as array or `{ nodes: [] }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function idsFromEvents(events: any): string[] {
  const list: unknown[] = Array.isArray(events)
    ? events
    : events?.nodes ?? [];
  if (!list.length) return [];
  const out: string[] = [];
  for (const raw of list) {
    const e = raw as Record<string, unknown>;
    const json =
      e.parsedJson ?? e.json ?? (e.contents as Record<string, unknown> | undefined)?.json;
    if (json && typeof json === 'object') {
      collectHexIds(json, out);
    }
  }
  return [...new Set(out)];
}

/**
 * extract the sign session object id from transaction events and effects.
 *
 * priority: session_object_id from the sign-related DWalletSessionEvent, then
 * brute-force created object ids validated via getSign (slow fallback).
 *
 * the ika `requestSign` emits a `DWalletSessionEvent<SignRequestEvent>` whose
 * JSON contains `session_object_id` at the top level, that's the ID we need
 * for `getSignInParticularState`. the first event is a
 * `UserSessionIdentifierRegisteredEvent` which also has a `session_object_id`
 * but it's the *identifier registration* session, not the sign session.
 */
export async function resolveSignSessionId(
  adapter: IkaAdapter,
  curve: Curve,
  signatureAlgorithm: SignatureAlgorithm,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  effects: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any,
): Promise<string | undefined> {
  const evList: unknown[] = Array.isArray(events) ? events : events?.nodes ?? [];

  // direct extraction: find the DWalletSessionEvent<SignRequestEvent> and pull
  // event_data.sign_id (the actual sign object, not the session wrapper)
  for (const raw of evList) {
    const e = raw as Record<string, unknown>;
    const evType =
      (e.eventType as string | undefined) ??
      (e.type as string | undefined) ??
      ((e.contents as Record<string, unknown> | undefined)?.type as Record<string, unknown> | undefined)?.repr as string | undefined ??
      '';
    if (evType.includes('UserSessionIdentifier')) continue;
    if (!evType.includes('DWalletSessionEvent')) continue;
    const json = (e.json ?? e.parsedJson ?? (e.contents as Record<string, unknown> | undefined)?.json) as Record<string, unknown> | undefined;
    if (!json) continue;
    const eventData = json.event_data as Record<string, unknown> | undefined;
    const signId = eventData?.sign_id;
    if (typeof signId === 'string' && signId.startsWith('0x') && signId.length === 66) {
      return signId;
    }
  }

  // fallback: brute-force created objects + event hex ids through getSign
  const candidates = [...new Set([...createdObjectIds(effects), ...idsFromEvents(events)])];
  for (const id of candidates) {
    try {
      await adapter.getSign(id, curve, signatureAlgorithm);
      return id;
    } catch {
      /* not a Sign session */
    }
  }
  return undefined;
}

export async function assertActiveSecpDwallet(
  s: NonNullable<ReturnType<typeof getSession>>,
  adapter: IkaAdapter,
  explicitDwalletId?: string,
): Promise<{ dWallet: ZeroTrustDWallet; dwalletId: string }> {
  const curveKey: CurveKey = 'SECP256K1';
  const dwalletId = explicitDwalletId ?? s.dwalletMeta[curveKey]?.dwalletId;
  if (!dwalletId) throw new Error('No SECP256K1 dWallet - create one first');
  const dWallet = await adapter.getDWallet(dwalletId);
  if (dWallet.kind !== 'zero-trust') throw new Error('Expected zero-trust dWallet');
  const kind = (dWallet.state as { $kind: string }).$kind;
  if (kind !== 'Active') throw new Error(`dWallet must be Active to sign (current: ${kind})`);
  return { dWallet: dWallet as ZeroTrustDWallet, dwalletId };
}

export async function ensureEncryptedShareId(
  s: NonNullable<ReturnType<typeof getSession>>,
  curveKey: CurveKey,
  adapter: IkaAdapter,
  dwalletId: string,
): Promise<string> {
  const metaDwallet = s.dwalletMeta[curveKey]?.dwalletId;
  const existing = s.dwalletMeta[curveKey]?.encryptedUserSecretKeyShareId;
  if (existing && metaDwallet === dwalletId) return existing;

  const persistToMeta = !metaDwallet || metaDwallet === dwalletId;

  const dWallet = await adapter.getDWallet(dwalletId);
  const recovered = (dWallet as { encrypted_user_secret_key_share_id?: { id?: string } })
    .encrypted_user_secret_key_share_id?.id;
  if (typeof recovered === 'string' && recovered.startsWith('0x')) {
    if (persistToMeta) {
      s.dwalletMeta[curveKey] ??= { baseChain: 'sui' as const };
      s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = recovered;
      if (!s.dwalletMeta[curveKey]!.dwalletId) s.dwalletMeta[curveKey]!.dwalletId = dwalletId;
      await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
    }
    return recovered;
  }

  // fallback: recover from dWallet dynamic-field table of encrypted shares
  const tableId = (dWallet as { encrypted_user_secret_key_shares?: { id?: string } })
    .encrypted_user_secret_key_shares?.id;
  if (typeof tableId === 'string' && tableId.startsWith('0x')) {
    let dfCursor: string | null = null;
    for (;;) {
      const page: {
        hasNextPage: boolean;
        cursor: string | null;
        dynamicFields: Array<{ fieldId?: string; childId?: string }>;
      } = await s.suiClient.listDynamicFields({ parentId: tableId, cursor: dfCursor, limit: 50 });
      for (const f of page.dynamicFields) {
        const candidateIds = [f.fieldId, f.childId].filter(
          (x): x is string => typeof x === 'string' && x.startsWith('0x'),
        );
        for (const id of candidateIds) {
          try {
            const enc = await adapter.getEncryptedUserSecretKeyShare(id) as { dwallet_id?: string };
            if (enc.dwallet_id !== dwalletId) continue;
            if (persistToMeta) {
              s.dwalletMeta[curveKey] ??= { baseChain: 'sui' as const };
              s.dwalletMeta[curveKey]!.encryptedUserSecretKeyShareId = id;
              if (!s.dwalletMeta[curveKey]!.dwalletId) s.dwalletMeta[curveKey]!.dwalletId = dwalletId;
              await saveDwalletMeta(s.activeVaultId, s.dwalletMeta);
            }
            return id;
          } catch {
            // not an encrypted share object id
          }
        }
      }
      if (!page.hasNextPage || !page.cursor) break;
      dfCursor = page.cursor;
    }
  }

  throw new Error(`Missing encryptedUserSecretKeyShareId for ${curveKey} - complete zero-trust DKG first`);
}

export async function takePresignWithAutoRefill(
  key: PresignPoolKey,
  fallbackError: string,
): Promise<string> {
  const first = key === 'SECP256K1_ECDSA' ? await takePresignId() : await takePresign(key);
  if (first) return first;
  let replenishError: unknown;
  try {
    await replenishPool(key, 3);
  } catch (e) {
    replenishError = e;
  }
  // after replenishment, coin objects have been mutated by 3 transactions, give the
  // graphql indexer time to reflect the new versions before the signing tx fetches them,
  // otherwise `requireSuiAndIkaCoins` returns the pre-split version and we get a stale object error
  await sleep(2000);
  const second = key === 'SECP256K1_ECDSA' ? await takePresignId() : await takePresign(key);
  if (second) return second;
  if (replenishError) {
    const inner = replenishError instanceof Error ? replenishError.message : String(replenishError);
    throw new Error(`${fallbackError} - replenish error: ${inner}`);
  }
  throw new Error(fallbackError);
}
