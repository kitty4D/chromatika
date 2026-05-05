/**
 * reflector Durable Object: one instance per reflector_unique_id.
 *
 * holds the half-open / fully-open WebSocket pair and implements the relay logic from
 * https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol
 * (new spec) and https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec1.0.html#reflector-protocol
 * (old spec). chromatika supports both simultaneously, discriminating on URL shape at the
 * router (see src/index.ts):
 *
 *   - dapp connects to /reflect (no `id`)        -> new spec: server-allocated id, REFLECTOR_ID frame
 *   - dapp connects to /reflect?id=<X>           -> old spec: client-supplied id, no REFLECTOR_ID frame
 *   - wallet always connects with /reflect?id=<X> for either spec; the DO's state distinguishes
 *     "first arrival is dapp" from "second arrival is wallet".
 *
 * state machine:
 *   1. dapp attaches (role=dapp for new-spec, or role=auto with empty room for old-spec).
 *      new-spec dapp -> DO sends REFLECTOR_ID frame. old-spec dapp -> nothing sent. half-open.
 *   2. wallet attaches (role=auto, room has dapp) -> DO sends APP_PING (empty frame) to BOTH.
 *      this is identical for both specs.
 *   3. DO relays every subsequent frame from one side to the other.
 *   4. either disconnect -> DO closes the counterpart and tears down.
 *
 * timeouts: half-open dies at 30 s, fully-open at 90 s (both per spec). frames cap at 4 KiB:
 * larger frames close the offending side with code 1009 (message too big).
 *
 * subprotocol: server must echo back one of the requested
 * `com.solana.mobilewalletadapter.v1` / `.v1.base64` subprotocols. we negotiate per-side and
 * relay raw frames; encoding is the endpoints' problem (the spec lets the server pick either,
 * and the JS lib treats binary or base64 transparently).
 *
 * hibernation: we use the WebSocket Hibernation API (`acceptWebSocket` + `webSocketMessage`
 * handlers on the `DurableObject` base class) so the DO can sleep between frames, keeping
 * cost near zero on idle pairs.
 */

import { DurableObject } from 'cloudflare:workers';

/**
 * Flip to true and `pnpm run deploy` to emit per-frame relay/close traces to `wrangler tail`.
 * Useful when diagnosing dapp <-> wallet pairing issues: shows direction, byte size, target
 * presence, and the close code/reason for each side. Leave false in production - tail entries
 * cost cycles and the size logging would leak frame sizes for any onlooker with tail access.
 */
const DEBUG = false;

/**
 * The spec
 * (https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol)
 * says 4 KiB per frame, but in practice the `authorize` response includes per-account `icon`
 * fields and a top-level `wallet_icon`, all inline base64 data URLs. A typical PNG icon alone
 * blows past 4 KiB easily, and fakewallet's response is observed at well over the cap. We
 * bump to 1 MiB so realistic responses go through; this is still well below CF Workers' WS
 * frame size limit and prevents unbounded memory pressure from a buggy or malicious peer.
 */
const MAX_FRAME_BYTES = 1024 * 1024;
/**
 * half-open = dapp waits for wallet to connect. spec floor is 30 s; we use 3 min so
 * a real user has time to scan the QR, open the wallet app, approve the picker, and
 * (on Seeker) interact with Seed Vault before the reflector tears us down.
 */
const HALF_OPEN_TIMEOUT_MS = 3 * 60_000;
/**
 * full-open = the actual MWA session (HELLO_REQ -> handshake -> ECDH -> method calls).
 * spec floor is 90 s; we use 5 min so signing flows that prompt the user multiple
 * times (e.g. authorize + signMessages for the ika USK derivation in our case)
 * don't hit the timeout if the user takes a moment to read.
 */
const FULL_OPEN_TIMEOUT_MS = 5 * 60_000;

const SUBPROTOCOL_BINARY = 'com.solana.mobilewalletadapter.v1';
const SUBPROTOCOL_BASE64 = 'com.solana.mobilewalletadapter.v1.base64';

const ROLE_DAPP = 'dapp' as const;
const ROLE_WALLET = 'wallet' as const;
/**
 * router forwards `?role=auto` for any URL with `?id=<X>` — the DO decides whether this is the
 * old-spec dapp arrival (room empty) or a wallet arrival (room already has a dapp). new-spec
 * dapps still arrive with `?role=dapp` because the router allocated the id for them.
 */
const ROLE_AUTO = 'auto' as const;

type ProtocolVersion = 'old' | 'new';

/** WebSocket close codes from RFC 6455 + IANA registry; reflector-specific reasons. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_TOO_BIG = 1009;
const CLOSE_POLICY_VIOLATION = 1008;

type AttachedRole = typeof ROLE_DAPP | typeof ROLE_WALLET;

/**
 * encode `<varint length><reflector_unique_id_bytes>` per the REFLECTOR_ID spec.
 *
 * the spec calls out a `varint` for the length prefix; we use the unsigned LEB128 / protobuf
 * varint shape (low 7 bits + high bit = continuation), which is what the JS protocol package
 * decodes server-bound. for our 16-byte id the length is 16, i.e. a single byte (0x10).
 */
function encodeReflectorIdFrame(idBytes: Uint8Array): ArrayBuffer {
  const lenBytes: number[] = [];
  let n = idBytes.length;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    lenBytes.push(byte);
  } while (n !== 0);
  const out = new Uint8Array(lenBytes.length + idBytes.length);
  out.set(lenBytes, 0);
  out.set(idBytes, lenBytes.length);
  return out.buffer;
}

/** RFC 4648 §5 base64url decode -> bytes. */
function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** pick one of the two MWA subprotocols based on the client's `Sec-WebSocket-Protocol` request. */
function negotiateSubprotocol(req: Request): string | null {
  const requested = (req.headers.get('Sec-WebSocket-Protocol') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (requested.includes(SUBPROTOCOL_BINARY)) return SUBPROTOCOL_BINARY;
  if (requested.includes(SUBPROTOCOL_BASE64)) return SUBPROTOCOL_BASE64;
  return null;
}

/** tag stored on the WebSocket via `serializeAttachment` so hibernation handlers know which role. */
type Attachment = {
  role: AttachedRole;
  /** base64url id (new spec) or arbitrary client-supplied id (old spec, typically a decimal integer). */
  id: string;
  /** which protocol the dapp side is speaking; carried on every attached socket so a hibernation
   * restore can re-establish the mode without consulting external state. */
  protocolVersion: ProtocolVersion;
};

export class ReflectorDurableObject extends DurableObject {
  /** decoded id bytes; only populated on new-spec dapp arrival, used solely for the REFLECTOR_ID frame. */
  private idBytes: Uint8Array | null = null;
  private idStr: string | null = null;
  private dapp: WebSocket | null = null;
  private wallet: WebSocket | null = null;
  private fullyOpen = false;
  private halfOpenAlarmAtMs: number | null = null;
  private protocolVersion: ProtocolVersion | null = null;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env);
    // restore in-memory state for any sockets that were hibernating across cold starts.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      if (attachment.role === ROLE_DAPP) this.dapp = ws;
      else if (attachment.role === ROLE_WALLET) this.wallet = ws;
      this.idStr = attachment.id;
      this.protocolVersion = attachment.protocolVersion;
    }
    this.fullyOpen = this.dapp !== null && this.wallet !== null;
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const requestedRole = url.searchParams.get('role');
    const id = url.searchParams.get('id') ?? '';

    if (requestedRole !== ROLE_DAPP && requestedRole !== ROLE_AUTO) {
      return new Response('bad role\n', { status: 400 });
    }
    if (id.length === 0) {
      return new Response('missing id\n', { status: 400 });
    }

    const subprotocol = negotiateSubprotocol(req);
    if (!subprotocol) {
      return new Response('no acceptable Sec-WebSocket-Protocol\n', { status: 400 });
    }

    // Decide what to do based on requested role + current room state. The router forwards
    // role=dapp only for new-spec (server-allocated id) and role=auto for any URL that arrived
    // with a client-supplied id — the DO state distinguishes old-spec dapp from wallet.
    type Decision =
      | { kind: 'accept-dapp'; protocolVersion: ProtocolVersion }
      | { kind: 'accept-wallet' }
      | { kind: 'reject'; reason: string };

    let decision: Decision;
    if (requestedRole === ROLE_DAPP) {
      // new-spec dapp (router allocated id and routed here)
      if (this.dapp !== null) {
        decision = { kind: 'reject', reason: 'reflector_id already in use (dapp)' };
      } else {
        decision = { kind: 'accept-dapp', protocolVersion: 'new' };
      }
    } else {
      // role=auto: room state decides
      if (this.dapp === null) {
        // first arrival with a client-supplied id -> old-spec dapp
        decision = { kind: 'accept-dapp', protocolVersion: 'old' };
      } else if (this.wallet === null) {
        decision = { kind: 'accept-wallet' };
      } else {
        decision = { kind: 'reject', reason: 'reflector_id already paired' };
      }
    }

    // Establish per-DO state when a dapp arrives. Must run before WebSocketPair so a bad
    // id encoding still produces a 400 rather than a 101+close.
    if (decision.kind === 'accept-dapp') {
      this.idStr = id;
      this.protocolVersion = decision.protocolVersion;
      if (decision.protocolVersion === 'new' && this.idBytes === null) {
        try {
          this.idBytes = base64UrlToBytes(id);
        } catch {
          return new Response('bad id encoding\n', { status: 400 });
        }
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const headers = { 'Sec-WebSocket-Protocol': subprotocol };

    if (decision.kind === 'reject') {
      server.accept();
      server.close(CLOSE_POLICY_VIOLATION, decision.reason);
      return new Response(null, { status: 101, webSocket: client, headers });
    }

    if (decision.kind === 'accept-dapp') {
      this.dapp = server;
      this.ctx.acceptWebSocket(server, ['dapp']);
      server.serializeAttachment({
        role: ROLE_DAPP,
        id,
        protocolVersion: decision.protocolVersion,
      } satisfies Attachment);
      if (decision.protocolVersion === 'new') {
        // announce the assigned reflector_unique_id to the dapp. idBytes is non-null here
        // because the new-spec branch above decoded it (or returned 400).
        server.send(encodeReflectorIdFrame(this.idBytes!));
      }
      // old-spec dapp gets nothing on accept; both sides await the wallet arrival.
      this.scheduleHalfOpenTimeoutIfNeeded();
    } else {
      // accept-wallet
      this.wallet = server;
      this.ctx.acceptWebSocket(server, ['wallet']);
      server.serializeAttachment({
        role: ROLE_WALLET,
        id,
        // protocolVersion was set on the dapp arrival; fall back to 'old' for paranoia
        // (a wallet shouldn't arrive without a dapp, but if it did via auto path we'd treat
        // it as old-spec dapp anyway, so 'old' is the consistent fallback).
        protocolVersion: this.protocolVersion ?? 'old',
      } satisfies Attachment);
      // pair is fully open: ping both sides per spec.
      this.fullyOpen = true;
      const empty = new ArrayBuffer(0);
      try {
        this.dapp!.send(empty);
      } catch {
        /* dapp may have died between accept and pair; relay handler cleans up */
      }
      try {
        this.wallet.send(empty);
      } catch {
        /* wallet socket open but send failed; close handler cleans up */
      }
      // replace the half-open alarm with the fully-open one.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.setAlarm(Date.now() + FULL_OPEN_TIMEOUT_MS);
      this.halfOpenAlarmAtMs = null;
    }

    return new Response(null, { status: 101, webSocket: client, headers });
  }

  override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    // oversize frames close the offending side. don't relay.
    const size =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      try {
        ws.close(CLOSE_TOO_BIG, `frame exceeds ${MAX_FRAME_BYTES} bytes`);
      } catch {
        /* already closed */
      }
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    // pre-pairing, all incoming data is silently discarded per spec.
    if (!this.fullyOpen) {
      if (DEBUG) {
        console.log('[chromatika DO] message arrived pre-pair (discarded)', {
          from: attachment.role,
          size,
          id: this.idStr,
        });
      }
      return;
    }

    const target = attachment.role === ROLE_DAPP ? this.wallet : this.dapp;
    if (DEBUG) {
      console.log('[chromatika DO] relay', {
        from: attachment.role,
        size,
        hasTarget: !!target,
        id: this.idStr,
      });
    }
    if (!target) return;
    try {
      target.send(message);
      if (DEBUG) {
        console.log('[chromatika DO] relay sent', { from: attachment.role, size, id: this.idStr });
      }
    } catch (e) {
      if (DEBUG) console.error('[chromatika DO] relay send threw', e);
      // target is gone: close this side, relay teardown handler will close the other.
      try {
        ws.close(CLOSE_PROTOCOL_ERROR, 'counterparty unavailable');
      } catch {
        /* already closed */
      }
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    if (DEBUG) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      console.log('[chromatika DO] webSocketClose', {
        role: attachment?.role,
        code,
        reason,
        wasClean,
        fullyOpen: this.fullyOpen,
        id: this.idStr,
      });
    }
    this.tearDown(ws);
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    if (DEBUG) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      console.error('[chromatika DO] webSocketError', {
        role: attachment?.role,
        error: String(error),
        id: this.idStr,
      });
    }
    this.tearDown(ws);
  }

  /** alarms fire on half-open and fully-open timeouts. */
  override async alarm(): Promise<void> {
    // forcefully close any sockets still attached and let the runtime hibernate the DO.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CLOSE_NORMAL, this.fullyOpen ? 'session timeout (90s)' : 'half-open timeout (30s)');
      } catch {
        /* already closed */
      }
    }
    this.dapp = null;
    this.wallet = null;
    this.fullyOpen = false;
    this.halfOpenAlarmAtMs = null;
  }

  private scheduleHalfOpenTimeoutIfNeeded(): void {
    if (this.halfOpenAlarmAtMs !== null) return;
    const at = Date.now() + HALF_OPEN_TIMEOUT_MS;
    this.halfOpenAlarmAtMs = at;
    void this.ctx.storage.setAlarm(at);
  }

  private tearDown(closingWs: WebSocket): void {
    const attachment = closingWs.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    if (attachment.role === ROLE_DAPP) this.dapp = null;
    else this.wallet = null;
    if (this.fullyOpen) {
      // spec: when one side disconnects, close the other.
      const other = attachment.role === ROLE_DAPP ? this.wallet : this.dapp;
      if (other) {
        try {
          other.close(CLOSE_NORMAL, 'counterparty disconnected');
        } catch {
          /* already closed */
        }
      }
      this.dapp = null;
      this.wallet = null;
      this.fullyOpen = false;
    }
    void this.ctx.storage.deleteAlarm().catch(() => {});
    this.halfOpenAlarmAtMs = null;
  }
}
