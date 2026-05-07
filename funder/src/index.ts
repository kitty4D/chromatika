/**
 * chromatika team funder Worker.
 *
 * routes:
 *   - GET    /healthz             -> 200 plaintext, used for uptime probes
 *   - POST   /fund                -> drip SUI + IKA to a freshly-onboarded chromatika user
 *   - DELETE /address/<addr>      -> admin: clear a single address's lifetime dedupe
 *
 * the funding flow per `POST /fund`:
 *   1. validate bearer token + body shape (recipientAddress).
 *   2. ask the rate-limit Durable Object whether this address is allowed today.
 *   3. find the team's largest IKA coin object via Sui GraphQL.
 *   4. build + sign + execute one PTB: split IKA + split SUI from gas + transferObjects.
 *   5. record the funding in the DO so future calls return 429.
 *   6. return `{ digest, ikaSent, suiSent }`.
 *
 * we do NOT mutate the DO ahead of step 4, so a Sui execute failure does not "burn" the
 * recipient's slot. they retry, get a fresh attempt, and if Sui execute fails again we keep
 * returning 502 without consuming their lifetime one-shot.
 */

import { FUNDING_IKA, FUNDING_SUI, SUI_ADDRESS_RE } from './config';
import { RateLimitDurableObject } from './rate-limit';
import {
  createGraphQLClient,
  executeFundingPtb,
  findLargestIkaCoin,
  loadFunderKeypair,
  normalizeSuiAddress,
} from './sui';

export { RateLimitDurableObject };

export interface Env {
  /** rate-limit Durable Object namespace, single global instance keyed by `'global'`. */
  RATE_LIMIT: DurableObjectNamespace<RateLimitDurableObject>;
  // wrangler.toml [vars]
  SUI_GRAPHQL_URL: string;
  IKA_COIN_TYPE: string;
  DAILY_CAP: string;
  // wrangler secrets
  FUNDER_SUI_PRIVKEY: string;
  FUNDER_BEARER_TOKEN: string;
  // optional secrets
  LIFETIME_CAP?: string;
  ADMIN_BEARER_TOKEN?: string;
}

const DO_INSTANCE_NAME = 'global';

function getRateLimitStub(env: Env): DurableObjectStub<RateLimitDurableObject> {
  return env.RATE_LIMIT.get(env.RATE_LIMIT.idFromName(DO_INSTANCE_NAME));
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function bearerFromRequest(request: Request): string | null {
  const h = request.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

function parseDailyCap(env: Env): number {
  const raw = (env.DAILY_CAP ?? '').trim();
  const n = raw === '' ? 25 : Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid DAILY_CAP: ${JSON.stringify(env.DAILY_CAP)}`);
  }
  return n;
}

function parseLifetimeCap(env: Env): number | null {
  const raw = (env.LIFETIME_CAP ?? '').trim();
  if (raw === '') return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid LIFETIME_CAP: ${JSON.stringify(env.LIFETIME_CAP)}`);
  }
  return n;
}

/**
 * validate + canonicalize a Sui address. accepts loose `0x` + hex (any length 1-64), pads via
 * `normalizeSuiAddress` to the canonical 32-byte form. rejects everything else.
 */
function canonicalizeRecipient(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (!SUI_ADDRESS_RE.test(trimmed)) return null;
  try {
    return normalizeSuiAddress(trimmed);
  } catch {
    return null;
  }
}

async function handleFund(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return plain(405, 'method not allowed\n');
  const presented = bearerFromRequest(request);
  if (!presented || presented !== env.FUNDER_BEARER_TOKEN) {
    return jsonResponse(401, { error: 'unauthorized' });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }
  const recipient = canonicalizeRecipient((body as { recipientAddress?: unknown })?.recipientAddress);
  if (!recipient) {
    return jsonResponse(400, { error: 'invalid_recipient_address' });
  }

  let dailyCap: number;
  let lifetimeCap: number | null;
  try {
    dailyCap = parseDailyCap(env);
    lifetimeCap = parseLifetimeCap(env);
  } catch (e) {
    return jsonResponse(500, { error: 'config_error', detail: (e as Error).message });
  }

  const rl = getRateLimitStub(env);
  const decision = await rl.tryAcquire({ address: recipient, dailyCap, lifetimeCap });
  if (!decision.ok) {
    console.log('rate-limit hit', { reason: decision.reason, recipient });
    return jsonResponse(429, { error: 'rate_limited', ...decision });
  }

  // sui execute
  let signer;
  try {
    signer = loadFunderKeypair(env.FUNDER_SUI_PRIVKEY);
  } catch (e) {
    console.error('funder key load failed', e);
    return jsonResponse(500, { error: 'config_error', detail: (e as Error).message });
  }
  const funderAddress = signer.toSuiAddress();
  const client = createGraphQLClient(env);

  let digest: string;
  try {
    const ikaCoin = await findLargestIkaCoin(client, funderAddress, env.IKA_COIN_TYPE, FUNDING_IKA);
    const exec = await executeFundingPtb({
      client,
      signer,
      recipient,
      ikaCoinId: ikaCoin.id,
      ikaAmount: FUNDING_IKA,
      suiAmount: FUNDING_SUI,
    });
    digest = exec.digest;
  } catch (e) {
    console.error('sui exec failed', { recipient, err: (e as Error).message });
    return jsonResponse(502, { error: 'sui_execute_failed', detail: (e as Error).message });
  }

  // only stamp the DO after a successful execute. failures do not consume the recipient's slot.
  try {
    await rl.recordFunding({ address: recipient });
  } catch (e) {
    // execute already landed - log and let the user proceed; the DO miss means they could
    // hypothetically request again, but the per-address one-shot will catch it on the next try.
    console.warn('rate-limit record failed (execute already landed)', e);
  }

  console.log('funded ok', { recipient, digest, ikaSent: FUNDING_IKA.toString(), suiSent: FUNDING_SUI.toString() });
  return jsonResponse(200, {
    digest,
    ikaSent: FUNDING_IKA.toString(),
    suiSent: FUNDING_SUI.toString(),
  });
}

async function handleAdminClear(request: Request, env: Env, address: string): Promise<Response> {
  if (request.method !== 'DELETE') return plain(405, 'method not allowed\n');
  const adminToken = env.ADMIN_BEARER_TOKEN?.trim();
  if (!adminToken) return jsonResponse(404, { error: 'admin_disabled' });
  const presented = bearerFromRequest(request);
  if (!presented || presented !== adminToken) return jsonResponse(401, { error: 'unauthorized' });
  const recipient = canonicalizeRecipient(address);
  if (!recipient) return jsonResponse(400, { error: 'invalid_address' });
  const rl = getRateLimitStub(env);
  const result = await rl.clearAddress(recipient);
  return jsonResponse(200, result);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/healthz') {
      return plain(200, 'chromatika-team-funder ok\n');
    }
    if (url.pathname === '/fund') {
      return handleFund(request, env);
    }
    const adminMatch = /^\/address\/(.+)$/.exec(url.pathname);
    if (adminMatch) {
      return handleAdminClear(request, env, adminMatch[1]!);
    }
    return plain(404, 'not found\n');
  },
} satisfies ExportedHandler<Env>;
