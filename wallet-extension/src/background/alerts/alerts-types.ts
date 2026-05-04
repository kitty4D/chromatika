/**
 * safety broadcast alert envelope. signed JSON, verified per-alert via ed25519. authenticity is
 * the security goal here - we publish "to everyone" so encryption is meaningless. the publisher
 * allowlist (see `alerts-publishers.ts`) gates which keys we accept.
 *
 * pre-canonical signing: bytes signed = utf-8 of canonical JSON of the unsigned envelope (every
 * field except `signatureB64`), keys sorted alphabetically. the canonical form is implemented
 * in `canonicalAlertBytes` to match the publishing CLI (`scripts/publish-alert.mjs`).
 *
 * v1 schema. extend with `v: 2` if the wire format changes; old alerts stay verifiable while
 * new ones add fields.
 */

export type AlertSeverity = 'critical' | 'warning' | 'info';

/**
 * chains the alert is relevant to. optional - omit when the alert is chain-agnostic (e.g. a
 * phishing site that drains any wallet that connects). drives UI iconography only; the dNR
 * phishing-rule append happens for any severity-critical alert with `affectedDomains`.
 */
export type AlertChain = 'evm' | 'sui' | 'solana' | 'bitcoin' | 'aptos' | 'cross-chain';

/** wire format of an unsigned alert. */
export interface UnsignedAlertV1 {
  v: 1;
  /** stable id (uuid v4 or content hash). dedupe key. */
  id: string;
  severity: AlertSeverity;
  /** publish time, ms since epoch. */
  timestampMs: number;
  /** auto-expire time, ms since epoch. UI hides + dNR rule auto-removes after this. default: 7 days. */
  expiresAtMs: number;
  /** hostnames the alert is about (e.g. ['evilsite.io', 'phishing-uniswap.app']). lowercase, no scheme. */
  affectedDomains: string[];
  /** optional chain hints. */
  affectedChains?: AlertChain[];
  /** <= 100 chars. used in the banner + chrome.notification title. */
  titleShort: string;
  /** markdown body, <= 4000 chars. rendered in the expanded banner / history view. */
  bodyLong: string;
  /** base64 ed25519 publisher pubkey. must match an entry in the publisher allowlist. */
  publisherKeyB64: string;
  /**
   * optional list of policy-vault object ids that should auto-panic when this alert fires.
   * when set + alert verifies + chromatika has a local link to one of these vault ids
   * (via `chromatika_policy_vault_v1_<chromatikaVaultId>`), the safety SW handler builds + signs
   * a `panic` PTB from the user's local Sui keypair (which is registered as one of the vault's
   * actuators). the MPC network then refuses ALL signing for that dWallet until unfreeze.
   *
   * use case: chromatika-team detects an active drain pattern; signs an alert with the affected
   * users' vault ids; chromatika auto-freezes their keys at the protocol level.
   *
   * each entry must be a 0x-prefixed 32-byte hex Sui object id.
   */
  panicTargets?: string[];
}

/** wire format of a signed alert (the JSON the wallet fetches and verifies). */
export interface SignedAlertV1 extends UnsignedAlertV1 {
  /** base64 ed25519 signature over `canonicalAlertBytes(unsigned)`. */
  signatureB64: string;
}

/** wire format of the alert feed response. public read-only HTTP endpoint. */
export interface AlertsFeedResponse {
  v: 1;
  /** when the feed was generated. UI may show "feed last updated N min ago". */
  generatedAtMs: number;
  /** all currently-active alerts (publisher should drop expired alerts before generating). */
  alerts: SignedAlertV1[];
}

/**
 * canonical bytes for signing. must produce bit-identical output to the publishing CLI so the
 * signature verifies. implementation: drop `signatureB64`, sort all object keys alphabetically
 * (including nested), serialize via JSON.stringify, encode utf-8.
 */
export function canonicalAlertBytes(alert: UnsignedAlertV1): Uint8Array {
  return new TextEncoder().encode(canonicalAlertString(alert));
}

export function canonicalAlertString(alert: UnsignedAlertV1): string {
  return canonicalJsonStringify(alert);
}

/**
 * stable JSON serializer. recursively sorts object keys so the byte output is deterministic
 * across publishers and platforms. no support for cycles, regex, dates, etc - alerts are plain
 * data objects with primitives + arrays + nested objects.
 *
 * why we hand-roll this: standard `JSON.stringify` is key-order-dependent. a go publisher and a
 * ts publisher would otherwise produce different bytes for the same logical value, breaking
 * sig verification.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('canonical JSON cannot encode non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') {
    throw new Error('canonical JSON cannot encode bigint - convert to number or string first');
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJsonStringify(v)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // drop undefined fields (matches JSON.stringify behavior)
      parts.push(JSON.stringify(k) + ':' + canonicalJsonStringify(v));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error(`canonical JSON cannot encode ${typeof value}`);
}

/** strip the signature field for signing or re-verification. */
export function unsignedView(signed: SignedAlertV1): UnsignedAlertV1 {
  const { signatureB64: _drop, ...rest } = signed;
  void _drop;
  return rest;
}

/**
 * defaults applied at fetch / store time. publisher's stated `expiresAtMs` wins when present;
 * if missing or unreasonable (zero / past), we fall back to 7 days from the alert's timestamp.
 */
export const DEFAULT_ALERT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function effectiveExpiresAtMs(a: { timestampMs: number; expiresAtMs?: number }): number {
  if (typeof a.expiresAtMs === 'number' && a.expiresAtMs > a.timestampMs) {
    return a.expiresAtMs;
  }
  return a.timestampMs + DEFAULT_ALERT_TTL_MS;
}

export function isExpired(alert: SignedAlertV1, nowMs: number = Date.now()): boolean {
  return effectiveExpiresAtMs(alert) <= nowMs;
}
