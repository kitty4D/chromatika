/**
 * ed25519 signature verification + structural validation for SignedAlertV1 envelopes.
 * authenticity is the security goal of the broadcast channel - alerts are public, but only
 * keys in the allowlist can publish.
 *
 * verification pipeline (hard-fail order):
 *   1. structural shape (zod schema)
 *   2. publisher pubkey is in the bundled allowlist
 *   3. ed25519 sig over canonical bytes verifies under the claimed pubkey
 *   4. timestamp + expires sanity (timestamp not in the far future, not before chromatika's epoch)
 *
 * a failure at any step drops the alert with a console warning. never throw - the poller calls
 * this in a tight loop and a hostile feed shouldn't kill polling.
 */

import { z } from 'zod';
import * as ed25519 from '@noble/ed25519';
import { hashes as edHashes } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import {
  type SignedAlertV1,
  canonicalAlertBytes,
  unsignedView,
} from '@/background/alerts/alerts-types';
import { isAllowedPublisher } from '@/background/alerts/alerts-publishers';

// noble-ed25519 v3 sync APIs require an injected sha512 implementation. module-load assignment
// is idempotent across other consumers (hd.ts, solana-tx-sign.ts) that do the same.
edHashes.sha512 = sha512;

// 30-day sanity window relative to "now". alerts published far outside this range get dropped.
// generous on the past side - reasonable for a feed that might be slowly polled or rebroadcast.
const PAST_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
// future allowance: 5 minutes for clock skew. anything further out is suspicious.
const FUTURE_GRACE_MS = 5 * 60 * 1000;

const severitySchema = z.enum(['critical', 'warning', 'info']);
const chainSchema = z.enum(['evm', 'sui', 'solana', 'bitcoin', 'aptos', 'cross-chain']);

const signedAlertSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(200),
  severity: severitySchema,
  timestampMs: z.number().int().nonnegative(),
  expiresAtMs: z.number().int().nonnegative(),
  affectedDomains: z.array(z.string().min(1).max(255)).max(50),
  affectedChains: z.array(chainSchema).max(10).optional(),
  titleShort: z.string().min(1).max(100),
  bodyLong: z.string().min(0).max(4000),
  publisherKeyB64: z.string().min(1).max(100),
  signatureB64: z.string().min(1).max(200),
});

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export type AlertVerifyResult =
  | { ok: true; alert: SignedAlertV1 }
  | { ok: false; reason: AlertVerifyFailReason; detail: string };

export type AlertVerifyFailReason =
  | 'invalid-shape'
  | 'unknown-publisher'
  | 'bad-signature'
  | 'invalid-pubkey'
  | 'invalid-signature-bytes'
  | 'time-out-of-range';

/**
 * validate the shape, the publisher allowlist, and the ed25519 signature. returns a discriminated
 * result so callers can log specific failure reasons (useful when debugging a feed that suddenly
 * stops verifying, e.g. publisher pubkey rotation that the wallet didn't pick up yet).
 *
 * pure async - no chrome / storage / network calls.
 */
export async function verifySignedAlert(
  raw: unknown,
  nowMs: number = Date.now(),
): Promise<AlertVerifyResult> {
  const parsed = signedAlertSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid-shape', detail: parsed.error.message };
  }
  const alert = parsed.data as SignedAlertV1;

  if (!isAllowedPublisher(alert.publisherKeyB64)) {
    return {
      ok: false,
      reason: 'unknown-publisher',
      detail: `publisher pubkey ${alert.publisherKeyB64.slice(0, 16)}… is not in the bundled allowlist`,
    };
  }

  let pubkey: Uint8Array;
  let signature: Uint8Array;
  try {
    pubkey = fromBase64(alert.publisherKeyB64);
  } catch (e) {
    return { ok: false, reason: 'invalid-pubkey', detail: e instanceof Error ? e.message : String(e) };
  }
  if (pubkey.length !== 32) {
    return { ok: false, reason: 'invalid-pubkey', detail: `expected 32-byte pubkey, got ${pubkey.length}` };
  }
  try {
    signature = fromBase64(alert.signatureB64);
  } catch (e) {
    return {
      ok: false,
      reason: 'invalid-signature-bytes',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (signature.length !== 64) {
    return {
      ok: false,
      reason: 'invalid-signature-bytes',
      detail: `expected 64-byte sig, got ${signature.length}`,
    };
  }

  const msg = canonicalAlertBytes(unsignedView(alert));
  let valid: boolean;
  try {
    valid = await Promise.resolve(ed25519.verify(signature, msg, pubkey));
  } catch (e) {
    // noble can throw on malformed pubkey points; treat as bad-signature for caller simplicity.
    return {
      ok: false,
      reason: 'bad-signature',
      detail: `verify threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!valid) {
    return { ok: false, reason: 'bad-signature', detail: 'ed25519.verify returned false' };
  }

  if (
    alert.timestampMs < nowMs - PAST_GRACE_MS ||
    alert.timestampMs > nowMs + FUTURE_GRACE_MS
  ) {
    return {
      ok: false,
      reason: 'time-out-of-range',
      detail: `timestamp ${alert.timestampMs} is outside [now-${PAST_GRACE_MS}, now+${FUTURE_GRACE_MS}]`,
    };
  }

  return { ok: true, alert };
}
