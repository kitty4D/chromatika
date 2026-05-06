# `listActiveAlerts` MCP read-tier tool

new MCP read-tier tool that exposes chromatika's safety alerts to AI agents (Claude Desktop, Cursor, Cline, etc.). agents can query active alerts before recommending a dapp connection or transaction. no popup, no signing, no wallet-state mutation. read-only. auto-rejects when wallet is locked.

## the tool descriptor

```jsonc
{
  "name": "listActiveAlerts",
  "description": "Returns active (non-dismissed, non-expired) chromatika safety alerts. Use to check whether a dapp domain is flagged as phishing/malicious before recommending interaction. Supports optional severity floor and domain filter. Read-only; no popup.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "domain": {
        "type": "string",
        "description": "Optional domain to filter on (case-insensitive substring match). If provided, returns only alerts whose affectedDomains include this domain.",
      },
      "severity": {
        "type": "string",
        "enum": ["critical", "warning", "info"],
        "description": "Optional severity floor. 'critical' returns only critical; 'warning' returns critical+warning; 'info' returns all.",
      },
    },
  },
}
```

## the response shape

```jsonc
{
  "alerts": [
    {
      "id": "uniswap-clone-2026-04-29",
      "severity": "critical",
      "timestampMs": 1712345678000,
      "expiresAtMs": 1712950478000,
      "affectedDomains": ["uniswap-clone-evil.io"],
      "affectedChains": ["evm"],
      "titleShort": "phishing uniswap clone draining USDC",
      "bodyLong": "Two domains run an exact uniswap v4 UI clone...",
    },
    // ... more alerts ...
  ],
  "lastPolledAtMs": 1712346000000,
  "lastPollError": null,
  "muted": false,
  "optedOut": false,
}
```

`alerts` is the filtered + sorted active list. UI metadata (`lastPolledAtMs`, `muted`, `optedOut`) is included so agents can surface "your alerts are muted" or "your last poll failed" context.

`publisherKeyB64` and `signatureB64` are **stripped** from the response - the alert was already verified by the wallet on ingest; agents don't need to re-verify and shouldn't be in the trust loop.

## the implementation

dispatched in `src/background/mcp/mcp-tools.ts` `dispatchMcpToolCall`:

```ts
case 'listActiveAlerts': {
  const { listActiveAlertsForMcp } = await import('@/background/alerts/alerts-store');
  const result = await listActiveAlertsForMcp(params);
  return { ok: true, result };
}
```

`listActiveAlertsForMcp({ domain?, severity? })` lives in `alerts-store.ts`:

```ts
async function listActiveAlertsForMcp({ domain, severity }: { domain?: string, severity?: 'critical'|'warning'|'info' }): Promise<...> {
  const state = await getAlertsState();

  // active = non-dismissed, non-expired
  let active = activeAlertsFromState(state);

  // severity floor
  if (severity === 'critical') active = active.filter(a => a.severity === 'critical');
  else if (severity === 'warning') active = active.filter(a => a.severity === 'critical' || a.severity === 'warning');
  // 'info' = no filter (default)

  // domain filter (case-insensitive substring on any affectedDomain)
  if (domain) {
    const needle = domain.toLowerCase();
    active = active.filter(a => a.affectedDomains.some(d => d.toLowerCase().includes(needle)));
  }

  // strip pubkey + signature for the MCP response
  const sanitized = active.map(a => ({
    id: a.id,
    severity: a.severity,
    timestampMs: a.timestampMs,
    expiresAtMs: a.expiresAtMs,
    affectedDomains: a.affectedDomains,
    affectedChains: a.affectedChains,
    titleShort: a.titleShort,
    bodyLong: a.bodyLong,
  }));

  return {
    alerts: sanitized,
    lastPolledAtMs: state.lastPolledAtMs,
    lastPollError: state.lastPollError,
    muted: state.settings.muted,
    optedOut: state.settings.optedOut,
  };
}
```

## the read-tier classification

per [mcp-protocol-overview.md](/library/tech/mcp-protocol-overview), MCP tools split into:

- **read tier** (no popup): `listVaults`, `getActiveVault`, `getActiveNetworks`, `getLockState`, **and now `listActiveAlerts`**
- **approve tier** (popup-gated): `signMessage`, `sendEvmTx`, `signTransaction`

`listActiveAlerts` joins read-tier because:

- it's read-only (no state mutation)
- the data is already-verified safety info (no signing needed)
- agents need fast access to flag dangerous domains before recommending interaction
- popping a UI for every agent query would defeat the use case

## the lock check

read-tier still respects the wallet lock state. if the wallet is locked, the tool returns JSON-RPC error `-32001` ("wallet locked") rather than reading from storage.

```ts
if (!sessionState.unlocked) {
  return { ok: false, error: { code: -32001, message: "wallet locked" } };
}
```

rationale: alerts data is technically not user-secret (the feed is public), but the **active vault state** + **session metadata** in the response (muted/optedOut settings are user choices) is. simpler to gate on lock than to special-case "alerts are public, but settings are private."

## the agent use case

example agent prompt: "I want to swap USDC for ETH on uniswap.org. is this safe?"

agent flow:

1. `tools/call listActiveAlerts({ domain: 'uniswap.org' })`
2. response: `{ alerts: [], ... }` (or `{ alerts: [...] }` with phishing matches)
3. agent reasons: empty result = no flags = recommend with normal caution. non-empty = surface the alert content to the user before any interaction
4. agent then might call `sendEvmTx` (approve tier) or just inform the user

## privacy properties for agents

- agents calling `listActiveAlerts` see verified alerts but cannot inject or modify alerts. they're consumers of the same feed the user sees
- agents see `muted` / `optedOut` settings. an agent could in principle nag the user about being muted; the user can ignore the nag. it's metadata, not authority
- agents do **not** see `publisherKeyB64` / `signatureB64`. the wallet is the trust anchor; agents don't re-verify

## what about subscription / push?

current MCP transport is request/response only (no SSE for server push). so agents have to **poll** `listActiveAlerts` to get fresh alerts. the tool description tells them to call before recommending a domain - no need for push if the agent always queries before acting.

future: when SSE arrives, push `notifications/alerts/changed` so agents can re-fetch when new alerts land. tracked in the broader MCP roadmap.

## library

- internal: `src/background/mcp/mcp-tools.ts` for the dispatch
- internal: `src/background/alerts/alerts-store.ts` for `listActiveAlertsForMcp`, `getAlertsState`, `activeAlertsFromState`

## related

- [mcp-protocol-overview.md](/library/tech/mcp-protocol-overview) - the broader MCP method set
- [mcp-tool-routing.md](/library/tech/mcp-tool-routing) - how tool-calls correlate
- [alerts-overview.md](/library/tech/alerts-overview) - the underlying alerts subsystem
- [alerts-signed-feed-format.md](/library/tech/alerts-signed-feed-format) - the verification that produced the data this tool returns
