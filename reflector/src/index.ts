/**
 * Chromatika MWA reflector - Cloudflare Worker entry.
 *
 * the Mobile Wallet Adapter spec (https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol)
 * defines a tiny relay: a dapp connects without an id, server allocates a random id, sends a
 * REFLECTOR_ID frame back; a wallet connects with `?id=<base64url>` and the two are paired.
 * once paired the server sends APP_PING to both endpoints and then forwards every frame from
 * one to the other. frames cap at 4 KiB; half-open sessions die after 30 s, fully-open after 90 s.
 *
 * routing strategy:
 * - GET /reflect (no `id`): the dapp side. we allocate a random reflector_unique_id, route to a
 *   Durable Object keyed by that id, and pass `dapp=1` so the DO knows to respond with a
 *   REFLECTOR_ID frame.
 * - GET /reflect?id=<base64url>: the wallet side. we route to the Durable Object for that id;
 *   the DO either pairs and sends APP_PING to both, or rejects (already paired / unknown id).
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
      // wallet side: route to the existing DO. if the dapp never connected (or already paired
      // / timed out), the DO closes the socket; we still return 101 so the lib surfaces the close.
      const stub = env.REFLECTOR.get(env.REFLECTOR.idFromName(requestedId));
      const forwarded = new Request(
        `https://internal.reflector/attach?role=wallet&id=${encodeURIComponent(requestedId)}`,
        request,
      );
      return stub.fetch(forwarded);
    }

    // dapp side: allocate a fresh random id and address the DO by it.
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
