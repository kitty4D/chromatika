/**
 * reflector Durable Object: one instance per reflector_unique_id.
 *
 * holds the half-open / fully-open WebSocket pair and implements the relay logic from
 * https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol.
 *
 * state machine:
 *   1. dapp attaches (role=dapp, id=<random>) -> DO sends REFLECTOR_ID frame, half-open.
 *   2. wallet attaches (role=wallet, id=<same>) -> DO sends APP_PING (empty frame) to BOTH.
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

const MAX_FRAME_BYTES = 4 * 1024;
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
  /** base64url id, retained for log diagnostics on close. */
  id: string;
};

export class ReflectorDurableObject extends DurableObject {
  private idBytes: Uint8Array | null = null;
  private idStr: string | null = null;
  private dapp: WebSocket | null = null;
  private wallet: WebSocket | null = null;
  private fullyOpen = false;
  private halfOpenAlarmAtMs: number | null = null;

  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    super(state, env);
    // restore in-memory state for any sockets that were hibernating across cold starts.
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (!attachment) continue;
      if (attachment.role === ROLE_DAPP) this.dapp = ws;
      else if (attachment.role === ROLE_WALLET) this.wallet = ws;
      this.idStr = attachment.id;
    }
    this.fullyOpen = this.dapp !== null && this.wallet !== null;
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const role = url.searchParams.get('role');
    const id = url.searchParams.get('id') ?? '';

    if (role !== ROLE_DAPP && role !== ROLE_WALLET) {
      return new Response('bad role\n', { status: 400 });
    }
    if (id.length === 0) {
      return new Response('missing id\n', { status: 400 });
    }
    if (this.idStr === null) this.idStr = id;
    if (this.idBytes === null) {
      try {
        this.idBytes = base64UrlToBytes(id);
      } catch {
        return new Response('bad id encoding\n', { status: 400 });
      }
    }

    const subprotocol = negotiateSubprotocol(req);
    if (!subprotocol) {
      return new Response('no acceptable Sec-WebSocket-Protocol\n', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    if (role === ROLE_DAPP) {
      if (this.dapp) {
        server.accept();
        server.close(CLOSE_POLICY_VIOLATION, 'reflector_id already in use (dapp)');
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { 'Sec-WebSocket-Protocol': subprotocol },
        });
      }
      this.dapp = server;
      this.ctx.acceptWebSocket(server, ['dapp']);
      server.serializeAttachment({ role: ROLE_DAPP, id } satisfies Attachment);
      // announce the assigned reflector_unique_id to the dapp.
      server.send(encodeReflectorIdFrame(this.idBytes));
      this.scheduleHalfOpenTimeoutIfNeeded();
    } else {
      if (!this.dapp) {
        server.accept();
        server.close(CLOSE_POLICY_VIOLATION, 'reflector_id unknown (wallet before dapp)');
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { 'Sec-WebSocket-Protocol': subprotocol },
        });
      }
      if (this.wallet) {
        server.accept();
        server.close(CLOSE_POLICY_VIOLATION, 'reflector_id already paired');
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { 'Sec-WebSocket-Protocol': subprotocol },
        });
      }
      this.wallet = server;
      this.ctx.acceptWebSocket(server, ['wallet']);
      server.serializeAttachment({ role: ROLE_WALLET, id } satisfies Attachment);
      // pair is fully open: ping both sides per spec.
      this.fullyOpen = true;
      const empty = new ArrayBuffer(0);
      try {
        this.dapp.send(empty);
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

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': subprotocol },
    });
  }

  override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    // spec caps frames at 4 KiB; oversize frames close the offending side. don't relay.
    const size =
      typeof message === 'string'
        ? new TextEncoder().encode(message).byteLength
        : message.byteLength;
    if (size > MAX_FRAME_BYTES) {
      try {
        ws.close(CLOSE_TOO_BIG, 'frame exceeds 4 KiB');
      } catch {
        /* already closed */
      }
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    // pre-pairing, all incoming data is silently discarded per spec.
    if (!this.fullyOpen) return;

    const target = attachment.role === ROLE_DAPP ? this.wallet : this.dapp;
    if (!target) return;
    try {
      target.send(message);
    } catch {
      // target is gone: close this side, relay teardown handler will close the other.
      try {
        ws.close(CLOSE_PROTOCOL_ERROR, 'counterparty unavailable');
      } catch {
        /* already closed */
      }
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.tearDown(ws);
  }

  override webSocketError(ws: WebSocket, _error: unknown): void {
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
