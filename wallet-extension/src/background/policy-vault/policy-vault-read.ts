/**
 * on-chain reader for `PolicyVault` objects. loads the shared object via the Sui GraphQL
 * core API, parses the Move struct fields, returns a typed snapshot.
 *
 * pure-data parser is exported separately (`parsePolicyVaultFields`) for unit-testability.
 * the end-to-end loader (`readPolicyVaultSnapshot`) wraps the SDK call.
 */

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { PolicyVaultSnapshot } from './policy-vault-storage';

/** shape of the parsed Move struct fields chromatika cares about. */
type ParsedFields = Record<string, unknown>;

/** convert a Sui SDK Option<vector<u8>> field to a TS Uint8Array | null. */
function readOptionalBytes(field: unknown): Uint8Array | null {
  // `Option::Some(...)` is encoded as `{ vec: [[byte, byte, ...]] }` in Mysten's parsed shape;
  // `Option::None` is `{ vec: [] }` or null. we accept both forms defensively.
  if (field == null) return null;
  if (typeof field === 'object' && 'vec' in (field as Record<string, unknown>)) {
    const vec = (field as { vec: unknown }).vec;
    if (Array.isArray(vec) && vec.length > 0) {
      const first = vec[0];
      if (Array.isArray(first)) {
        return Uint8Array.from(first as number[]);
      }
    }
    return null;
  }
  if (Array.isArray(field) && field.length > 0) {
    const first = field[0];
    if (Array.isArray(first)) return Uint8Array.from(first as number[]);
  }
  return null;
}

/** read a u64 field (Move emits as a string in JSON). */
function readU64(field: unknown): bigint {
  if (typeof field === 'string' && /^\d+$/.test(field)) return BigInt(field);
  if (typeof field === 'number' && Number.isFinite(field)) return BigInt(field);
  if (typeof field === 'bigint') return field;
  return 0n;
}

function readBool(field: unknown): boolean {
  if (typeof field === 'boolean') return field;
  if (typeof field === 'string') return field === 'true';
  return false;
}

function readAddressList(field: unknown): string[] {
  if (Array.isArray(field)) {
    return field.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/** pull the `value` field from a Sui Balance<T> sub-struct. */
function readBalanceValue(field: unknown): bigint {
  if (field && typeof field === 'object') {
    const f = field as Record<string, unknown>;
    if ('value' in f) return readU64(f.value);
    // some shapes wrap balance in `{ fields: { value } }`
    if ('fields' in f && f.fields && typeof f.fields === 'object') {
      const inner = f.fields as Record<string, unknown>;
      if ('value' in inner) return readU64(inner.value);
    }
  }
  return 0n;
}

/** length of a Move `vector<T>` field (vec-of-x). */
function readVectorLength(field: unknown): number {
  if (Array.isArray(field)) return field.length;
  return 0;
}

/**
 * pure-data parser. takes a `parsedFields` object (the Move struct fields as a JSON-ish
 * blob) and produces a `PolicyVaultSnapshot`. defensive across plausible shapes (Mysten
 * has shifted the parsed-content format across SDK versions).
 */
export function parsePolicyVaultFields(parsedFields: ParsedFields): PolicyVaultSnapshot {
  const f = parsedFields;
  const panicked = readBool(f.panicked);
  const panicAtMs = Number(readU64(f.panic_at_ms));
  const unfreezeDelayMs = Number(readU64(f.unfreeze_delay_ms));
  const dailyCapMicros = readU64(f.daily_cap_micros);
  const spentTodayMicros = readU64(f.spent_today_micros);
  const coolDownMs = Number(readU64(f.cool_down_ms));
  const lastSignAtMs = Number(readU64(f.last_sign_at_ms));
  const epochDay = Number(readU64(f.epoch_day));
  const ikaBalance = readBalanceValue(f.ika_balance);
  const suiBalance = readBalanceValue(f.sui_balance);
  const presignsRemaining = readVectorLength(f.presigns);
  const actuators = readAddressList(f.actuators);
  const rescueBytes = readOptionalBytes(f.rescue_address_bytes);
  // staging fields (default conservative values when absent for backward-compat)
  const stageCapRaises = readBool(f.stage_cap_raises);
  const stageDelayMs = Number(readU64(f.stage_delay_ms));
  const pendingCapBytes = readOptionalU64(f.pending_cap_micros);
  const pendingCapAtMs = Number(readU64(f.pending_cap_at_ms));
  const pendingStageOff = readBool(f.pending_stage_off);
  const pendingStageOffAtMs = Number(readU64(f.pending_stage_off_at_ms));

  return {
    panicked,
    panicAtMs,
    unfreezeDelayMs,
    unfreezeUnlocksAtMs: panicAtMs + unfreezeDelayMs,
    dailyCapMicros: dailyCapMicros.toString(),
    spentTodayMicros: spentTodayMicros.toString(),
    coolDownMs,
    lastSignAtMs,
    actuators,
    hasRescueAddress: rescueBytes != null,
    ikaBalance: ikaBalance.toString(),
    suiBalance: suiBalance.toString(),
    presignsRemaining,
    epochDay,
    stageCapRaises,
    stageDelayMs,
    hasPendingCap: pendingCapBytes != null,
    pendingCapMicros: pendingCapBytes != null ? pendingCapBytes.toString() : '0',
    pendingCapAtMs,
    pendingStageOff,
    pendingStageOffAtMs,
  };
}

/**
 * parse a Move `Option<u64>` field. mirrors `readOptionalBytes` shape: `{ vec: [string] }`
 * for Some, `{ vec: [] }` or null for None. returns the bigint value or null.
 */
function readOptionalU64(field: unknown): bigint | null {
  if (field == null) return null;
  if (typeof field === 'object' && 'vec' in (field as Record<string, unknown>)) {
    const vec = (field as { vec: unknown }).vec;
    if (Array.isArray(vec) && vec.length > 0) {
      const first = vec[0];
      if (typeof first === 'string' && /^\d+$/.test(first)) return BigInt(first);
      if (typeof first === 'number' && Number.isFinite(first)) return BigInt(first);
    }
    return null;
  }
  if (Array.isArray(field) && field.length > 0) {
    const first = field[0];
    if (typeof first === 'string' && /^\d+$/.test(first)) return BigInt(first);
    if (typeof first === 'number' && Number.isFinite(first)) return BigInt(first);
  }
  return null;
}

/**
 * end-to-end load: resolve the `PolicyVault` shared object via GraphQL core API and parse.
 * caller passes the live `SuiGraphQLClient`. returns null if the object is missing
 * (e.g. user removed it) or the response shape doesn't include parseable fields.
 */
export async function readPolicyVaultSnapshot(
  client: SuiGraphQLClient,
  vaultObjectId: string,
): Promise<PolicyVaultSnapshot | null> {
  type RespShape = { objects?: Array<{ content?: { fields?: ParsedFields } | ParsedFields }> };
  let response: RespShape | null = null;
  try {
    const raw = await (client.core as unknown as {
      getObjects: (opts: { objectIds: string[] }) => Promise<unknown>;
    }).getObjects({ objectIds: [vaultObjectId] });
    response = raw as RespShape;
  } catch (e) {
    console.warn('[chromatika policy-vault] readPolicyVaultSnapshot getObjects failed:', e);
    return null;
  }
  const obj = response?.objects?.[0];
  if (!obj) return null;
  // different SDK paths surface the Move fields differently; try a couple shapes.
  const c = (obj as { content?: unknown }).content;
  let fields: ParsedFields | null = null;
  if (c && typeof c === 'object') {
    const maybeFields = (c as { fields?: ParsedFields }).fields;
    if (maybeFields && typeof maybeFields === 'object') {
      fields = maybeFields;
    } else {
      // some shapes inline the struct fields directly on `content`
      fields = c as ParsedFields;
    }
  }
  if (!fields) return null;
  return parsePolicyVaultFields(fields);
}
