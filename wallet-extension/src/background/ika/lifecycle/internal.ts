import { Curve, type IkaClient } from '@ika.xyz/sdk';
import type { CurveKey } from '@/background/session';

export function toCurve(curveKey: CurveKey): Curve {
  return curveKey === 'SECP256K1' ? Curve.SECP256K1 : Curve.ED25519;
}

export function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}

export function b64ToU8(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Sui `0x2::dynamic_field::add` abort code 0 is `EFieldAlreadyExists`. */
export function isDynamicFieldAddAlreadyExistsError(err: unknown): boolean {
  const blobs: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (depth > 8) return;
    if (e == null) return;
    if (typeof e === 'string') {
      blobs.push(e);
      return;
    }
    if (e instanceof Error) {
      blobs.push(e.message);
      visit(e.cause, depth + 1);
      return;
    }
    try {
      blobs.push(JSON.stringify(e));
    } catch {
      blobs.push(String(e));
    }
  };
  visit(err, 0);
  const m = blobs.join('\n').toLowerCase();
  const hasAdd =
    m.includes('dynamic_field::add') ||
    (m.includes('dynamic_field') && m.includes('"function":"add"'));
  const hasAbort0 =
    /\babort code:\s*0\b/.test(m) ||
    /"abortcode"\s*:\s*"0"/.test(m) ||
    /"abortcode"\s*:\s*0[,}\]]/.test(m);
  return hasAdd && hasAbort0;
}

export function deepFindAddressByKey(root: unknown, keyNeedles: string[]): string | undefined {
  const seen = new Set<unknown>();
  const visit = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);
    const rec = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(rec)) {
      const keyLower = k.toLowerCase();
      const keyMatch = keyNeedles.every((needle) => keyLower.includes(needle));
      if (keyMatch) {
        if (typeof val === 'string' && val.startsWith('0x')) return val;
        if (val && typeof val === 'object') {
          const id = (val as { id?: unknown }).id;
          if (typeof id === 'string' && id.startsWith('0x')) return id;
          for (const nested of Object.values(val as Record<string, unknown>)) {
            if (typeof nested === 'string' && nested.startsWith('0x')) return nested;
            if (nested && typeof nested === 'object') {
              const nid = (nested as { id?: unknown }).id;
              if (typeof nid === 'string' && nid.startsWith('0x')) return nid;
            }
          }
        }
      }
    }
    for (const val of Object.values(rec)) {
      const hit = visit(val);
      if (hit) return hit;
    }
    return undefined;
  };
  return visit(root);
}

export function deepFindStringByKey(root: unknown, keyNeedles: string[]): string | undefined {
  const seen = new Set<unknown>();
  const visit = (v: unknown): string | undefined => {
    if (!v || typeof v !== 'object') return undefined;
    if (seen.has(v)) return undefined;
    seen.add(v);
    const rec = v as Record<string, unknown>;
    for (const [k, val] of Object.entries(rec)) {
      const keyLower = k.toLowerCase();
      const keyMatch = keyNeedles.every((needle) => keyLower.includes(needle));
      if (keyMatch && typeof val === 'string') return val;
    }
    for (const val of Object.values(rec)) {
      const hit = visit(val);
      if (hit) return hit;
    }
    return undefined;
  };
  return visit(root);
}

export type RawEventLike = {
  type?: string | null;
  parsedJson?: unknown;
  eventType?: string | null;
  json?: unknown;
  contents?: { json?: unknown; type?: { repr?: string } } | null;
};

export function normalizeEvents(
  events: RawEventLike[] | { nodes?: RawEventLike[] } | undefined,
): { type?: string | null; parsedJson?: unknown }[] {
  if (!events) return [];
  const list = Array.isArray(events) ? events : events.nodes ?? [];
  return list.map((e) => ({
    type: e.type ?? e.eventType ?? e.contents?.type?.repr ?? null,
    parsedJson: e.parsedJson ?? e.json ?? e.contents?.json,
  }));
}

/** extract new object IDs from transaction events (best-effort). */
export function idsFromEvents(events: { type?: string | null; parsedJson?: unknown }[]): string[] {
  if (!events?.length) return [];
  const out: string[] = [];
  for (const e of events) {
    const j = e.parsedJson;
    if (j && typeof j === 'object') {
      for (const v of Object.values(j as Record<string, unknown>)) {
        if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) out.push(v);
        if (v && typeof v === 'object' && 'id' in (v as object)) {
          const id = (v as { id?: string | { id?: string } }).id;
          const sid = typeof id === 'string' ? id : id && typeof id === 'object' ? id.id : undefined;
          if (typeof sid === 'string' && sid.startsWith('0x') && sid.length === 66) out.push(sid);
        }
      }
    }
  }
  return [...new Set(out)];
}

/** parse ika DKG / encrypted-share event payloads for the encrypted share object id. */
function encryptedShareIdFromParsedJson(parsedJson: unknown): string | undefined {
  if (!parsedJson || typeof parsedJson !== 'object') return undefined;
  const keys = [
    'encryptedUserSecretKeyShareId',
    'encrypted_user_secret_key_share_id',
    'encrypted_user_secret_key_share',
  ];
  const rec = parsedJson as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'string' && v.startsWith('0x') && v.length === 66) return v;
    if (v && typeof v === 'object' && v !== null && 'id' in v) {
      const inner = (v as { id?: unknown }).id;
      if (typeof inner === 'string' && inner.startsWith('0x')) return inner;
      if (inner && typeof inner === 'object' && 'id' in (inner as object)) {
        const id = (inner as { id: string }).id;
        if (typeof id === 'string' && id.startsWith('0x')) return id;
      }
    }
  }
  return undefined;
}

export function extractEncryptedShareIdFromEvents(
  events: { type?: string | null; parsedJson?: unknown }[],
): string | undefined {
  if (!events.length) return undefined;
  for (const e of events) {
    const t = (e.type ?? '').toLowerCase();
    if (t.includes('encrypted') && t.includes('share')) {
      const id = encryptedShareIdFromParsedJson(e.parsedJson);
      if (id) return id;
    }
    const id = encryptedShareIdFromParsedJson(e.parsedJson);
    if (id) return id;
  }
  return undefined;
}

/** try object ids from events until `getEncryptedUserSecretKeyShare` succeeds. */
export async function resolveEncryptedShareIdByProbing(
  ikaClient: IkaClient,
  dwalletId: string,
  candidateIds: string[],
): Promise<string | undefined> {
  for (const id of candidateIds) {
    if (id === dwalletId) continue;
    try {
      await ikaClient.getEncryptedUserSecretKeyShare(id);
      return id;
    } catch {
      /* not this object */
    }
  }
  return undefined;
}
