# Chromatika MWA reflector (fallback)

a tiny Cloudflare Worker that implements the [Mobile Wallet Adapter reflector protocol](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html#reflector-protocol). it sits between desktop Chromatika (running in a Chromium tab) and a Solana Mobile wallet on a phone (Seeker / Phantom Android / Solflare Android), relaying bytes during QR pairing.

> **NOT in production by default.** Chromatika ships pointing at Solana Mobile's public reflector at `development.reflector.solanamobile.com` — that's the host every shipping MWA wallet is tested against. self-hosted reflectors trip wallet-side allowlists / untested code paths and silently freeze the wallet UI. don't deploy this and swap `MWA_REMOTE_HOST_AUTHORITY` unless the public host is down or you've got a specific reason to control the relay surface.

## what it does

- `wss://<host>/reflect` — dapp connects without an `id`. server allocates a 16-byte random id, sends a `REFLECTOR_ID` frame back, and parks the connection in **half-open** state for ≤ 30 s.
- `wss://<host>/reflect?id=<base64url>` — wallet connects with the id from the QR. server pairs the two, sends `APP_PING` (empty frame) to both, and starts forwarding frames until either side disconnects or the **fully-open** 90 s window elapses.
- `GET /healthz` — plain text 200, for uptime probes.

caps:
- 4 KiB max frame size (per spec) — oversize closes that side with code 1009
- ≤ 3 min half-open (spec floor 30 s; we extend so a real user has time to scan + open wallet + tap through Seed Vault)
- ≤ 5 min fully-open (spec floor 90 s; extends to cover multi-prompt signing flows like the chromatika ika USK derivation)

each `id` is its own Durable Object; idle pairs hibernate so cost stays near zero.

## one-time setup

```bash
cd reflector
pnpm install     # or npm / yarn
npx wrangler login
```

## deploy

```bash
npx wrangler deploy
```

first deploy provisions the worker at `https://chromatika-mwa-reflector.<your-subdomain>.workers.dev`. you can use that directly, or attach a custom hostname (recommended) — see "custom domain" below.

verify:

```bash
curl -i https://chromatika-mwa-reflector.<your-subdomain>.workers.dev/healthz
# → HTTP/2 200; body "chromatika-mwa-reflector ok"
```

## custom domain (optional, recommended)

uptime + branding are easier with a hostname you control. steps:

1. add a route in `wrangler.toml`:
   ```toml
   [[routes]]
   pattern = "reflect.chromatika.xyz/*"
   custom_domain = true
   ```
2. add the hostname to your Cloudflare zone (DNS → Add record → Worker route, or via the dashboard's Workers → custom domains panel).
3. redeploy: `npx wrangler deploy`.

## point chromatika at it

once deployed, edit [`wallet-extension/src/background/hardware/mwa-remote.ts`](../wallet-extension/src/background/hardware/mwa-remote.ts):

```ts
export const MWA_REMOTE_HOST_AUTHORITY = 'chromatika-mwa-reflector.<your-subdomain>.workers.dev';
// or: 'reflect.chromatika.xyz'
```

rebuild the extension (`pnpm run build` in `wallet-extension/`) and reload from `chrome://extensions`. the Seeker QR pair flow now uses your reflector.

## local testing

```bash
npx wrangler dev
# starts a local worker at http://127.0.0.1:8787
```

`wrangler dev` does emulate Durable Objects but websocket subprotocol negotiation isn't always faithful — production deploys are the source of truth. for end-to-end pair tests use the real Seeker / Phantom Android / Solflare Android.

## protocol notes (for future maintainers)

- `REFLECTOR_ID` is `<varint length><id bytes>` — we use the unsigned LEB128 (protobuf-style) encoding the JS protocol package decodes server-bound. for our 16-byte id the length prefix is one byte (`0x10`).
- `APP_PING` is an empty frame.
- subprotocol negotiation: server echoes back exactly one of `com.solana.mobilewalletadapter.v1` or `com.solana.mobilewalletadapter.v1.base64` from the client's `Sec-WebSocket-Protocol` request. we never invent one.
- pre-pairing, all incoming data is silently discarded per spec — the dapp shouldn't send anything before APP_PING anyway.

## why cloudflare workers

native WebSocket Hibernation API + Durable Objects with built-in alarms = ~150 lines of TS for the entire relay, no Node.js shims. free tier covers chromatika's expected pre-alpha load (a few thousand pairings/month). if that ever stops being true, the same logic ports to Fly.io / Render with a Node WebSocket server in a few hours.

## deliberately not here

- **TURN / STUN** — irrelevant; the spec uses simple wss reflection.
- **bluetooth LE transport** — optional in the spec, not used by chromatika.
- **rate limiting** — punted to Cloudflare's WAF / firewall rules. add a rule on `/reflect` if abuse appears.
