#!/usr/bin/env node
/**
 * chromatika-mcp-host
 *
 * chrome native messaging host for the chromatika wallet extension. MV3 cannot bind a listening
 * socket from the service worker, so this process runs outside the extension and acts as the
 * bridge to external MCP clients.
 *
 * two invocation modes:
 *
 * 1. native messaging host (default - chrome spawns this on connectNative):
 *   - reads chrome native messaging frames from stdin (4-byte LE length prefix + UTF-8 JSON body).
 *   - hosts an HTTP listener on 127.0.0.1:<random-port> serving a single endpoint:
 *       POST /mcp   - JSON-RPC 2.0 over HTTP; methods: initialize, tools/list, tools/call.
 *   - forwards tools/list / tools/call to the extension over native messaging via a tool-call
 *     envelope (`{ type: 'tool-call', id, method, params }`) and correlates the matching
 *     `{ type: 'tool-result', id, result|error }` back to the waiting HTTP client by id.
 *   - bearer-token auth: extension pushes `{ type: 'config', tokenHex }` on connect; MCP clients
 *     pass `Authorization: Bearer <tokenHex>` on every /mcp request.
 *
 * 2. stdio bridge (`--stdio-bridge` flag - claude desktop / other stdio MCP clients spawn this):
 *   - reads line-delimited JSON-RPC 2.0 from stdin (the standard MCP stdio transport framing).
 *   - forwards each request to the HTTP listener (mode 1 above) at $CHROMATIKA_AGENT_URL with
 *     bearer auth from $CHROMATIKA_AGENT_TOKEN.
 *   - writes the response back as a single newline-terminated JSON line on stdout.
 *   - this lets MCP clients that don't speak HTTP MCP transport (claude desktop's default config
 *     uses stdio) still drive the wallet via the chrome-spawned native messaging host.
 *
 * still TODO (next slices):
 *   - SSE transport for server-to-client notifications (tools/list_changed, etc.).
 *   - approve-tier tools beyond signMessage + sendEvmTx (Solana sendTx, signTransaction).
 *   - durable port registration so stdio-bridge users don't need to manually update env vars
 *     after each chrome restart.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const STDIN = process.stdin;
const STDOUT = process.stdout;
const STDERR = process.stderr;

const STDIO_BRIDGE_FLAG = '--stdio-bridge';
const isStdioBridge = process.argv.includes(STDIO_BRIDGE_FLAG);

if (isStdioBridge) {
  // stdio bridge mode - read line-delimited JSON-RPC from stdin, forward to the HTTP endpoint
  // hosted by the chrome-spawned native messaging host, write response back as a JSON line.
  // never returns; exits when stdin closes (parent client disconnected).
  await runStdioBridge();
  process.exit(0);
}

const SERVER_INFO = { name: 'chromatika', version: '0.0.1' };
const MCP_PROTOCOL_VERSION = '2025-03-26';
// approve-tier tools (signMessage etc.) wait on user popup approval; 5 min covers a careful read.
// read-tier tools resolve in well under a second so the same cap is fine for both.
const TOOL_CALL_TIMEOUT_MS = 300_000;

const STATE = {
  /** authoritative token; the extension pushes this via a `{ type: 'config', tokenHex }` frame on connect. */
  tokenHex: null,
};

/**
 * pending tool calls awaiting an extension reply. keyed by correlation id; resolved when
 * `{ type: 'tool-result', id, ... }` comes back over native messaging.
 */
const pending = new Map();

let buffer = Buffer.alloc(0);

function logErr(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
  try {
    STDERR.write(`${line}\n`);
  } catch {
    /* stderr gone - parent likely dead */
  }
}

function safeStringify(o) {
  try {
    return JSON.stringify(o);
  } catch {
    return String(o);
  }
}

function sendFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  // chrome rejects messages larger than 1 MiB in either direction; we never come close in v2.
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(body.length, 0);
  try {
    STDOUT.write(Buffer.concat([lenBuf, body]));
  } catch (e) {
    logErr('stdout write failed:', e?.message ?? e);
  }
}

function processBuffer() {
  while (buffer.length >= 4) {
    const msgLen = buffer.readUInt32LE(0);
    if (buffer.length < 4 + msgLen) break;
    const body = buffer.subarray(4, 4 + msgLen);
    buffer = buffer.subarray(4 + msgLen);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch (e) {
      logErr('parse error:', e?.message ?? e);
      continue;
    }
    handleMessage(msg);
  }
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    sendFrame({ ok: false, error: 'expected json object' });
    return;
  }

  if (msg.type === 'config') {
    STATE.tokenHex = typeof msg.tokenHex === 'string' && msg.tokenHex.length > 0 ? msg.tokenHex : null;
    sendFrame({ ok: true, kind: 'config-ack', hasToken: STATE.tokenHex != null });
    return;
  }

  if (msg.type === 'tool-result' && typeof msg.id === 'string') {
    const entry = pending.get(msg.id);
    if (!entry) return; // already timed out / unknown id
    pending.delete(msg.id);
    clearTimeout(entry.timeoutId);
    if (msg.error) {
      entry.resolve({ error: msg.error });
    } else {
      entry.resolve({ result: msg.result });
    }
    return;
  }

  if (msg.type === 'ping') {
    sendFrame({ ok: true, kind: 'pong', tsMs: Date.now() });
    return;
  }

  if (msg.type === 'reconfigure-port' && Number.isInteger(msg.port) && msg.port > 0 && msg.port <= 65535) {
    void rebindToDesiredPort(msg.port);
    return;
  }

  // unknown / legacy frames - echo so the extension can diagnose during dev.
  sendFrame({ ok: true, kind: 'echo', received: msg });
}

/**
 * close the current localhost listener and bind to `desiredPort`. on failure (port collision
 * / permissions) the original server stays open and the host reports `kind: 'rebind-error'`
 * so the extension can surface a "couldn't bind requested port" message in settings.
 *
 * called at most once per native messaging connection (the bridge sends `reconfigure-port`
 * right after the initial config push). if the user updates their desired port in settings
 * mid-connection, the bridge calls `pushDesiredPortToHost` which fires another reconfigure-port.
 */
async function rebindToDesiredPort(desiredPort) {
  // sanity: if the current server already serves the requested port, nothing to do.
  const currentAddr = server?.address?.();
  const currentPort = typeof currentAddr === 'object' && currentAddr ? currentAddr.port : null;
  if (currentPort === desiredPort) {
    sendFrame({ kind: 'listen', host: '127.0.0.1', port: desiredPort });
    return;
  }

  const oldServer = server;
  // build the replacement first so we don't tear down the working one until the new bind succeeds.
  const newServer = createServer(httpHandler);
  newServer.on('error', (e) => {
    logErr('replacement server error:', e?.message ?? e);
  });

  await new Promise((resolve) => {
    newServer.once('error', (e) => {
      logErr(`rebind to port ${desiredPort} failed: ${e?.message ?? e}; staying on current port ${currentPort}`);
      sendFrame({ kind: 'rebind-error', desiredPort, error: e?.message ?? String(e) });
      try { newServer.close(); } catch { /* noop */ }
      resolve();
    });
    newServer.listen(desiredPort, '127.0.0.1', () => {
      // tear down the old listener now that the new one is up.
      try {
        oldServer.close();
      } catch (e) {
        logErr('failed to close prior listener after rebind:', e?.message ?? e);
      }
      server = newServer;
      sendFrame({ kind: 'listen', host: '127.0.0.1', port: desiredPort });
      logErr(`chromatika-mcp-host rebound to 127.0.0.1:${desiredPort}`);
      resolve();
    });
  });
}

STDIN.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  try {
    processBuffer();
  } catch (e) {
    logErr('processBuffer error:', e?.message ?? e);
  }
});

STDIN.on('end', () => {
  // chrome closed the port - exit cleanly so the OS reaps us.
  try {
    server.close();
  } catch {
    /* server may have failed earlier */
  }
  process.exit(0);
});

function callExtensionTool(method, params) {
  return new Promise((resolve) => {
    if (!STATE.tokenHex) {
      // not yet configured - the client raced the extension's config push.
      resolve({ error: { code: -32002, message: 'native host not yet configured by extension' } });
      return;
    }
    const id = randomUUID();
    const timeoutId = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { code: -32603, message: `tool call timed out after ${TOOL_CALL_TIMEOUT_MS}ms` } });
    }, TOOL_CALL_TIMEOUT_MS);
    pending.set(id, { resolve, timeoutId });
    sendFrame({ type: 'tool-call', id, method, params });
  });
}

function bearerTokenFromHeaders(headers) {
  const auth = headers['authorization'] ?? headers['Authorization'];
  if (typeof auth !== 'string') return null;
  const m = /^Bearer\s+([0-9a-fA-F]+)$/.exec(auth.trim());
  return m ? m[1].toLowerCase() : null;
}

function constantTimeStringEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      chunks.push(c);
      total += c.length;
      if (total > 1_048_576) {
        // 1 MiB cap - matches chrome native messaging frame limit
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(body.length === 0 ? null : JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function handleMcpRequest(jrpc) {
  const id = jrpc?.id ?? null;
  if (!jrpc || jrpc.jsonrpc !== '2.0' || typeof jrpc.method !== 'string') {
    return jsonRpcError(id, -32600, 'invalid json-rpc 2.0 envelope');
  }

  switch (jrpc.method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      // notification - no response per JSON-RPC 2.0 spec.
      return null;

    case 'tools/list':
    case 'tools/call': {
      const out = await callExtensionTool(jrpc.method, jrpc.params ?? {});
      if (out.error) return jsonRpcError(id, out.error.code, out.error.message);
      return jsonRpcResponse(id, out.result);
    }

    case 'ping':
      return jsonRpcResponse(id, {});

    default:
      return jsonRpcError(id, -32601, `unknown method: ${jrpc.method}`);
  }
}

async function httpHandler(req, res) {
  // CORS preflight - keep permissive for localhost; the bearer-token check is the real gate.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '86400',
    });
    res.end();
    return;
  }

  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found - POST /mcp' }));
    return;
  }

  if (!STATE.tokenHex) {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'native host not yet configured by extension; retry shortly' }));
    return;
  }

  const provided = bearerTokenFromHeaders(req.headers);
  if (!constantTimeStringEq(provided ?? '', STATE.tokenHex)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized - bad or missing bearer token' }));
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `bad request body: ${e?.message ?? e}` }));
    return;
  }

  if (body == null) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'empty request body' }));
    return;
  }

  // batch JSON-RPC - process each in parallel and return an array. matches the JSON-RPC 2.0 spec.
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(handleMcpRequest));
    const filtered = responses.filter((r) => r != null);
    if (filtered.length === 0) {
      // all were notifications
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(filtered));
    return;
  }

  const response = await handleMcpRequest(body);
  if (response == null) {
    // notification - no response
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(response));
}

let server = createServer(httpHandler);

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  sendFrame({ kind: 'listen', host: '127.0.0.1', port });
  logErr(`chromatika-mcp-host listening on http://127.0.0.1:${port}/mcp`);
});

server.on('error', (e) => {
  logErr('server error:', e?.message ?? e);
  sendFrame({ kind: 'listen-error', error: e?.message ?? String(e) });
});

process.on('uncaughtException', (e) => {
  logErr('uncaughtException:', e?.message ?? e);
  process.exit(1);
});

process.on('unhandledRejection', (e) => {
  const message = e instanceof Error ? e.message : String(e);
  logErr('unhandledRejection:', message);
});

/**
 * stdio bridge - forwards line-delimited JSON-RPC 2.0 from stdin/stdout to the HTTP endpoint
 * the chrome-spawned native messaging host already exposes on 127.0.0.1.
 *
 * required env vars:
 *   CHROMATIKA_AGENT_URL    - e.g. http://127.0.0.1:31415/mcp (find in Settings -> Agents)
 *   CHROMATIKA_AGENT_TOKEN  - bearer token from Settings -> Agents
 *
 * claude desktop config example (~/.../claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "chromatika": {
 *         "command": "node",
 *         "args": ["/abs/path/to/chromatika-mcp-host.mjs", "--stdio-bridge"],
 *         "env": {
 *           "CHROMATIKA_AGENT_URL": "http://127.0.0.1:<port>/mcp",
 *           "CHROMATIKA_AGENT_TOKEN": "<token-hex>"
 *         }
 *       }
 *     }
 *   }
 */
async function runStdioBridge() {
  const url = process.env.CHROMATIKA_AGENT_URL;
  const token = process.env.CHROMATIKA_AGENT_TOKEN;
  if (!url) {
    STDERR.write('CHROMATIKA_AGENT_URL is not set; copy it from chromatika Settings → Agents\n');
    process.exit(2);
  }
  if (!token) {
    STDERR.write('CHROMATIKA_AGENT_TOKEN is not set; copy it from chromatika Settings → Agents\n');
    process.exit(2);
  }

  const rl = createInterface({ input: STDIN });
  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      // we don't validate or rewrite the body - the chrome-spawned host already does JSON-RPC
      // 2.0 parsing + dispatch. just forward the raw line, return the raw response line.
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: line,
      });
      // notifications - HTTP endpoint returns 204 with no body; MCP stdio writes nothing back.
      if (response.status === 204) continue;
      const text = await response.text();
      // MCP stdio framing: one JSON message per line.
      STDOUT.write(text + '\n');
    } catch (e) {
      STDERR.write(`stdio-bridge forward failed: ${e?.message ?? e}\n`);
      // surface the failure as a JSON-RPC error response when we can extract an id from the
      // request line - clients pair responses to requests by id and would hang otherwise.
      try {
        const parsed = JSON.parse(line);
        const id = Array.isArray(parsed) ? null : parsed?.id ?? null;
        if (id !== null) {
          const errResp = {
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: `chromatika-mcp-host stdio bridge: ${e?.message ?? e}` },
          };
          STDOUT.write(JSON.stringify(errResp) + '\n');
        }
      } catch {
        /* malformed input line; nothing to send back */
      }
    }
  }
}
