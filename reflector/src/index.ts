/**
 * Chromatika MWA reflector - Cloudflare Worker entry.
 *
 * supports both the new MWA reflector spec
 * (https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol)
 * AND the legacy 1.0 spec
 * (https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec1.0.html#reflector-protocol)
 * simultaneously, discriminated by URL shape on first connect:
 *
 * - new spec: dapp opens `wss://<host>/reflect` (no id). server allocates a random 16-byte id,
 *   responds with a REFLECTOR_ID frame, and the dapp embeds that id into the QR. wallet later
 *   connects with `?id=<base64url>`.
 * - old spec (used by every published Android wallet still in the wild as of 2026-05): dapp
 *   picks its own numeric id and opens `wss://<host>/reflect?id=<numeric>`. server uses that id
 *   as the room key, sends NO REFLECTOR_ID frame. wallet connects with the same `?id=<numeric>`
 *   from the QR.
 *
 * once paired the server sends APP_PING (empty frame) to both endpoints and then forwards every
 * frame from one to the other. frames cap at 4 KiB; half-open sessions die after 30 s,
 * fully-open after 90 s. these semantics are identical between the two specs.
 *
 * routing strategy:
 * - GET /reflect (no `id`): new-spec dapp side. allocate a random reflector_unique_id, route to
 *   a Durable Object keyed by that id, pass `role=dapp` so the DO knows it's new-spec and must
 *   send a REFLECTOR_ID frame on accept.
 * - GET /reflect?id=<X>: ambiguous — either the old-spec dapp creating a room or any-spec
 *   wallet joining one. forward to the DO keyed by `X` with `role=auto`; the DO uses its own
 *   state (room empty -> old-spec dapp; room has dapp -> wallet) to disambiguate.
 *
 * health probes (GET /healthz) return plain text 200 OK so uptime checks have something to hit.
 *
 * no-effort path to deploy: `wrangler deploy` (see ../README.md).
 */

import type { ReflectorDurableObject } from './reflector-do';

export { ReflectorDurableObject } from './reflector-do';

export interface Env {
  REFLECTOR: DurableObjectNamespace<ReflectorDurableObject>;
}

const REFLECTOR_ID_BYTES = 16;

/** RFC 4648 §5: base64url. Uses `-`/`_` instead of `+`/`/`, drops `=` padding. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/healthz' || url.pathname === '/') {
      return new Response('chromatika-mwa-reflector ok\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    if (url.pathname !== '/reflect') {
      return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected WebSocket upgrade\n', { status: 426 });
    }

    const requestedId = url.searchParams.get('id');

    if (requestedId) {
      // ambiguous path: this could be an old-spec dapp creating a new room with its own id, or
      // a wallet (either spec) joining an existing room. forward to the DO keyed by the id with
      // role=auto so the DO can decide based on whether it already has a dapp attached.
      const stub = env.REFLECTOR.get(env.REFLECTOR.idFromName(requestedId));
      const forwarded = new Request(
        `https://internal.reflector/attach?role=auto&id=${encodeURIComponent(requestedId)}`,
        request,
      );
      return stub.fetch(forwarded);
    }

    // new-spec dapp side: allocate a fresh random id and address the DO by it.
    const idBytes = new Uint8Array(REFLECTOR_ID_BYTES);
    crypto.getRandomValues(idBytes);
    const newId = bytesToBase64Url(idBytes);
    const stub = env.REFLECTOR.get(env.REFLECTOR.idFromName(newId));
    const forwarded = new Request(
      `https://internal.reflector/attach?role=dapp&id=${encodeURIComponent(newId)}`,
      request,
    );
    return stub.fetch(forwarded);
  },
} satisfies ExportedHandler<Env>;
