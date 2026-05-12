# Encrypt gRPC-web transport (HTTP/1.1 over fetch)

chromatika talks to Encrypt's gRPC service over the gRPC-web protocol. browsers can't speak native gRPC (HTTP/2 streaming with custom frame types), so gRPC-web wraps gRPC's wire format inside HTTP/1.1 POST requests with specific framing. chromatika's transport is `encrypt-grpc-web-fetch.ts`, a thin wrapper around `fetch()` plus `@protobuf-ts/grpcweb-transport` for the framing details.

## why gRPC-web

native gRPC requires:
- HTTP/2 (most fetch implementations don't expose enough control over HTTP/2 frames)
- bidirectional streaming (browsers don't have a clean way to do this)
- trailers (uncommon in browser fetch)

gRPC-web is a spec that maps gRPC onto vanilla HTTP/1.1 POST + base64-or-binary message frames + per-response trailer-equivalent metadata in a synthetic frame. it's the standard way to call gRPC services from a browser-style runtime.

## the wire shape

every gRPC-web request is a POST to `<base_url>/<service>/<method>`:

```
POST /encrypt.v1.EncryptService/CreateInput HTTP/1.1
Host: pre-alpha-dev-1.encrypt.ika-network.net
Content-Type: application/grpc-web+proto
X-Grpc-Web: 1
X-User-Agent: grpc-web-javascript/0.1
Accept: application/grpc-web+proto

[5-byte length-prefix frame] [protobuf body]
```

the body framing:
- byte 0: compression flag (0 = uncompressed)
- bytes 1-4: big-endian uint32 length of the next message
- bytes 5+: the protobuf-encoded message

response framing is similar, plus a synthetic **trailer frame** (compression flag = 0x80, then a length, then `key1: value1\r\nkey2: value2\r\n` style headers) at the end:

```
[length-prefixed protobuf response frame]
[length-prefixed trailer frame]
  flag = 0x80
  body = "grpc-status: 0\r\ngrpc-message: \r\n"
```

`grpc-status: 0` means success. nonzero is an error code per gRPC's status enum.

## chromatika's wrapper

```ts
async function encryptGrpcUnary(
  baseUrl: string,
  service: string,
  method: string,
  encodedRequestBytes: Uint8Array,
  timeoutMs = 25_000
): Promise<Uint8Array> {
  const url = `${baseUrl}/${service}/${method}`;

  const requestBody = createGrpcWebRequestBody(encodedRequestBytes);   // adds 5-byte prefix
  const requestHeaders = createGrpcWebRequestHeader();                 // sets Content-Type etc.

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const resp = await fetch(url, {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
    signal: controller.signal,
  });
  clearTimeout(timeoutId);

  if (!resp.ok) {
    throw new Error(`grpc-web HTTP ${resp.status}: ${await resp.text()}`);
  }

  const responseBuffer = new Uint8Array(await resp.arrayBuffer());
  const { dataFrames, trailers } = readGrpcWebResponseBody(responseBuffer);

  // check trailers for grpc-status: 0
  if (trailers['grpc-status'] && trailers['grpc-status'] !== '0') {
    throw new Error(
      `grpc error ${trailers['grpc-status']}: ${trailers['grpc-message'] ?? 'unknown'}`
    );
  }

  if (dataFrames.length === 0) throw new Error('no data frames in response');
  return dataFrames[0];   // first DATA frame = the protobuf response
}
```

`createGrpcWebRequestBody`, `createGrpcWebRequestHeader`, `readGrpcWebResponseBody` come from `@protobuf-ts/grpcweb-transport`. they handle the 5-byte framing + trailer parsing.

## the two methods chromatika calls

```ts
// CreateInput - upload encrypted inputs
encryptGrpcCreateInput(baseUrl, encodedRequest)
  → POST {baseUrl}/encrypt.v1.EncryptService/CreateInput
  → returns Uint8Array (protobuf-encoded CreateInputResponse)

// ReadCiphertext - read a stored ciphertext (signed)
encryptGrpcReadCiphertext(baseUrl, encodedRequest)
  → POST {baseUrl}/encrypt.v1.EncryptService/ReadCiphertext
  → returns Uint8Array (protobuf-encoded ReadCiphertextResponse)
```

the `encodedRequest` is already protobuf-encoded - the body of one inside the gRPC-web frame.

## the 25-second timeout

```js
const timeoutMs = 25_000;
```

reasonable for a single round-trip to a pre-alpha devnet service. tweakable per call, but the default catches stuck connections without making the user wait too long.

## error handling

three error tiers:
1. **HTTP error** (4xx, 5xx response status) - network or server failure. `throw new Error('grpc-web HTTP ' + status)` with the body included
2. **gRPC error** (HTTP 200 with `grpc-status` trailer != 0) - server understood, but request was invalid. `throw new Error('grpc error ' + status + ': ' + message)`
3. **client abort** (timeout fired) - `AbortError` propagates

callers wrap these into chromatika-shaped errors before surfacing to the user.

## why not @grpc/grpc-js

`@grpc/grpc-js` is the standard node.js gRPC client. it's **not browser-compatible**:
- depends on node-only APIs (`net`, `tls`, `dns`)
- emits HTTP/2 frames directly
- ~5 MB minified

chromatika runs in a chrome service worker, where neither node APIs nor HTTP/2 control are available. gRPC-web over fetch is the only option.

## CORS

the Encrypt server at `pre-alpha-dev-1.encrypt.ika-network.net` sets permissive CORS headers so browsers can call it. specifically:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, X-Grpc-Web, X-User-Agent
```

if CORS becomes more restrictive in the future (e.g. per-origin allowlist), chromatika may need to ship a fetch-proxy in the service worker. not a concern today.

## library

- `fetch` (browser native, works in service worker)
- `@bufbuild/protobuf` for the protobuf encoder / decoder (used by callers, not this transport)
- `@protobuf-ts/grpcweb-transport` for `createGrpcWebRequestBody`, `createGrpcWebRequestHeader`, `readGrpcWebResponseBody`
- internal: `wallet-extension/src/background/encrypt/encrypt-grpc-web-fetch.ts`

## related

- [encrypt-protobuf-wire.md](/library/tech/encrypt-protobuf-wire) - what the request/response bytes look like before/after framing
- [encrypt-create-input.md](/library/tech/encrypt-create-input) - the encrypt path that uses this transport
- [encrypt-read-ciphertext-signed.md](/library/tech/encrypt-read-ciphertext-signed) - the reveal path
