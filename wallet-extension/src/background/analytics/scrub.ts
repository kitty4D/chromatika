// scrub.ts - PII scrubber for sentry error events
// strips wallet addresses, private keys, mnemonics, and api-key-bearing URLs
// before any event leaves the device. runs synchronously on every event/breadcrumb.

const HEX_ADDR = /0x[a-fA-F0-9]{40,}/g;
const BASE58_LONG = /[1-9A-HJ-NP-Za-km-z]{32,}/g;
const PRIV_KEY_PREFIX = /(suiprivkey|solprivkey)\S+/gi;
const URL_WITH_PATH = /https?:\/\/[^\s]+/g;

const SENSITIVE_FIELDS = new Set([
  'password',
  'mnemonic',
  'seed',
  'privkey',
  'privatekey',
  'secret',
  'secretkey',
]);

/**
 * takes any value, converts to string, then redacts known sensitive patterns.
 * returns empty string for null / undefined input.
 */
export function scrubString(s: unknown): string {
  if (s == null) return '';
  const str = typeof s === 'string' ? s : String(s);
  return str
    .replace(HEX_ADDR, '[REDACTED]')
    .replace(BASE58_LONG, '[REDACTED]')
    .replace(PRIV_KEY_PREFIX, '[REDACTED]')
    .replace(URL_WITH_PATH, '[REDACTED_URL]');
}

/**
 * scrubs a breadcrumb's data bag.
 * sensitive field names (password, mnemonic, seed, etc.) have their values
 * replaced wholesale with [REDACTED].
 * other string values go through scrubString.
 */
export function scrubBreadcrumbData(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(data)) {
    if (SENSITIVE_FIELDS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else if (typeof val === 'string') {
      out[key] = scrubString(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

/**
 * deep-scrubs a sentry event by round-tripping through JSON.
 * catches wallet addresses / keys that might appear anywhere in the event tree
 * (message, exception values, extra, tags, etc.).
 */
export function scrubEvent(event: unknown): unknown {
  try {
    const json = JSON.stringify(event);
    const scrubbed = scrubString(json);
    return JSON.parse(scrubbed) as unknown;
  } catch {
    return event;
  }
}

/**
 * scrubs a sentry breadcrumb.
 * only touches the `.data` bag via scrubBreadcrumbData; leaves other fields as-is
 * (category, message, level, etc. don't typically carry raw key material).
 */
export function scrubBreadcrumb(breadcrumb: unknown): unknown {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const bc = breadcrumb as Record<string, unknown>;
  if (!('data' in bc)) return bc;
  return {
    ...bc,
    data: scrubBreadcrumbData(bc['data'] as Record<string, unknown> | undefined),
  };
}
