import { useEffect, useState, useCallback } from 'react';
import { trpc } from '@/lib/trpc';

type McpStatus = Awaited<ReturnType<typeof trpc.mcpStatus.query>>;

/**
 * settings: enable / disable the chromatika agent surface (MCP over native messaging host).
 *
 * pre-alpha disclaimer: read-tier only today. external MCP clients (claude desktop, cursor,
 * cline, custom) get listVaults / getActiveVault / getActiveNetworks / getLockState - no
 * signing or sending. setup involves running `pnpm setup:native-host --extension-id=<id>`
 * once per machine; see `wallet-extension/native-host/README.md`.
 */
export function AgentsSettingsSection() {
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await trpc.mcpStatus.query();
      setStatus(s);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // poll while enabled so the connection state surfaces without a manual refresh.
  useEffect(() => {
    if (!status?.enabled) return;
    const t = setInterval(() => {
      void refresh();
    }, 3_000);
    return () => clearInterval(t);
  }, [status?.enabled, refresh]);

  async function onEnable() {
    setMsg(null);
    setBusy(true);
    try {
      await trpc.mcpEnable.mutate();
      await refresh();
      setMsg('agent surface enabled. if status stays "disconnected", run `pnpm setup:native-host` once.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setMsg(null);
    setBusy(true);
    try {
      await trpc.mcpDisable.mutate();
      await refresh();
      setMsg('agent surface disabled.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRotateToken() {
    setMsg(null);
    setBusy(true);
    try {
      await trpc.mcpRotateToken.mutate();
      await refresh();
      setMsg('token rotated. update your mcp client config with the new value.');
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setMsg(`${label} copied.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  if (!status) {
    return (
      <div className="sp-section">
        <h3>agents</h3>
        <div className="sp-muted">loading status…</div>
      </div>
    );
  }

  const enabled = status.enabled;
  const connected = status.native.connected;
  const port = status.listenPort;
  const agentUrl = port ? `http://${status.listenHost}:${port}/mcp` : null;
  const tokenDisplay = status.tokenHex
    ? revealToken
      ? status.tokenHex
      : `${status.tokenHex.slice(0, 8)}…${status.tokenHex.slice(-4)}`
    : '(none yet)';

  return (
    <div className="sp-section">
      <h3>agents <span className="sp-badge">read + sign + send · pre-alpha</span></h3>
      <p className="sp-muted">
        let external mcp clients (claude desktop, cursor, cline, custom python) read your wallet
        surface, request signatures, and send EVM transactions. read tier (no popup): vault list,
        active vault id, active networks, lock state. approve tier (popup-gated): <code>signMessage</code>{' '}
        for evm + solana, plus <code>sendEvmTx</code> through the wallet's existing tx approval
        popup with gas options + decoded params. every signature and send opens its own approval
        window - the agent can never sign or broadcast without an explicit click. solana sendTx
        and evm signTransaction (sign-only) land in a follow-up slice.
      </p>

      <div className="sp-row">
        <div>
          <div className="sp-label">status</div>
          <div className={enabled ? (connected ? 'sp-ok' : 'sp-warn') : 'sp-muted'}>
            {!enabled ? 'disabled' : connected ? 'connected' : 'enabled, not connected'}
          </div>
        </div>
        <div className="sp-actions">
          {enabled ? (
            <button onClick={onDisable} disabled={busy} className="sp-btn">
              disable
            </button>
          ) : (
            <button onClick={onEnable} disabled={busy} className="sp-btn sp-btn-primary">
              enable
            </button>
          )}
        </div>
      </div>

      {enabled && (
        <>
          <div className="sp-row">
            <div className="sp-label">agent url</div>
            <div className="sp-mono">
              {agentUrl ?? <span className="sp-muted">(waiting for native host to bind a port)</span>}
            </div>
            {agentUrl && (
              <button onClick={() => void copyToClipboard(agentUrl, 'agent url')} className="sp-btn">
                copy
              </button>
            )}
          </div>

          <div className="sp-row">
            <div className="sp-label">bearer token</div>
            <div className="sp-mono">{tokenDisplay}</div>
            <button onClick={() => setRevealToken((v) => !v)} className="sp-btn">
              {revealToken ? 'hide' : 'reveal'}
            </button>
            {status.tokenHex && (
              <button onClick={() => void copyToClipboard(status.tokenHex, 'token')} className="sp-btn">
                copy
              </button>
            )}
            <button onClick={onRotateToken} disabled={busy} className="sp-btn">
              rotate
            </button>
          </div>

          <DesiredPortRow
            currentDesired={status.desiredListenPort}
            currentBound={status.listenPort}
            onMessage={setMsg}
            busy={busy}
            setBusy={setBusy}
            refresh={refresh}
          />

          {!connected && (
            <div className="sp-warn">
              host not connected. one-time setup:{' '}
              <code>pnpm -C wallet-extension setup:native-host --extension-id=&lt;your-id&gt;</code>{' '}
              (find &lt;your-id&gt; on chrome://extensions). see{' '}
              <code>wallet-extension/native-host/README.md</code>.
              {status.native.lastErrorMessage && (
                <div className="sp-mono sp-muted" style={{ marginTop: 4 }}>
                  last error: {status.native.lastErrorMessage}
                </div>
              )}
            </div>
          )}

          <details className="sp-details">
            <summary>connect from your mcp client</summary>
            <p>
              http MCP clients (cursor, cline, custom http): point at{' '}
              <code>{agentUrl ?? 'http://127.0.0.1:<port>/mcp'}</code> and pass the bearer token
              in the <code>Authorization</code> header.
            </p>
            <p>
              stdio MCP clients (claude desktop): they spawn each server as a child process. use
              the bundled <code>--stdio-bridge</code> mode of <code>chromatika-mcp-host.mjs</code>{' '}
              - it forwards stdio JSON-RPC to the http endpoint above. config snippet for
              <code> claude_desktop_config.json</code>:
            </p>
            <pre className="sp-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, marginTop: 4 }}>
{`{
  "mcpServers": {
    "chromatika": {
      "command": "node",
      "args": [
        "/abs/path/to/wallet-extension/native-host/chromatika-mcp-host.mjs",
        "--stdio-bridge"
      ],
      "env": {
        "CHROMATIKA_AGENT_URL": "${agentUrl ?? 'http://127.0.0.1:<port>/mcp'}",
        "CHROMATIKA_AGENT_TOKEN": "${revealToken ? status.tokenHex : '<reveal token above>'}"
      }
    }
  }
}`}
            </pre>
            <p>
              read tier (no popup): <code>listVaults</code>, <code>getActiveVault</code>,{' '}
              <code>getActiveNetworks</code>, <code>getLockState</code>. wallet must be unlocked for
              vault listings.
            </p>
            <p>
              approve tier (popup-gated):
            </p>
            <ul style={{ paddingLeft: 18, margin: '4px 0 0 0' }}>
              <li>
                <code>signMessage</code> with <code>{'{ chain, messageHex, evmChainId? }'}</code>{' '}
                - returns <code>{'{ signatureHex, signerAddress, chain }'}</code>.
              </li>
              <li>
                <code>sendEvmTx</code> with{' '}
                <code>{'{ to, value?, data?, chainId?, gas?, maxFeePerGas?, ... }'}</code>{' '}
                - opens the wallet's standard tx approval popup with decoded params + gas options;
                returns <code>{'{ chain, chainId, from, to, txHash }'}</code> after broadcast.
              </li>
            </ul>
            <p className="sp-muted" style={{ fontSize: 11, marginTop: 6 }}>
              caveat: the http port is random per chrome session. update the URL in your client
              config when chrome restarts (or wait for the fixed-port toggle in a follow-up).
            </p>
          </details>
        </>
      )}

      {msg && <div className="sp-msg">{msg}</div>}
    </div>
  );
}

function DesiredPortRow({
  currentDesired,
  currentBound,
  onMessage,
  busy,
  setBusy,
  refresh,
}: {
  currentDesired: number | null;
  currentBound: number | null;
  onMessage: (msg: string | null) => void;
  busy: boolean;
  setBusy: (v: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<string>(currentDesired != null ? String(currentDesired) : '');

  // keep draft synced with the upstream value when the user toggles the surface or the
  // tRPC poll lands a fresh value.
  useEffect(() => {
    setDraft(currentDesired != null ? String(currentDesired) : '');
  }, [currentDesired]);

  const trimmed = draft.trim();
  const parsed = trimmed.length === 0 ? null : Number.parseInt(trimmed, 10);
  const valid =
    trimmed.length === 0 ||
    (Number.isInteger(parsed) && parsed != null && parsed >= 1024 && parsed <= 65535);
  const dirty = (parsed ?? null) !== currentDesired;

  async function save() {
    if (!valid) {
      onMessage('port must be empty (random) or an integer 1024-65535');
      return;
    }
    setBusy(true);
    onMessage(null);
    try {
      await trpc.mcpSetDesiredPort.mutate({ port: parsed });
      await refresh();
      onMessage(
        parsed == null
          ? 'cleared desired port; host will use a random port on next chrome restart'
          : `desired port set to ${parsed}; host will rebind now (or on next chrome restart)`,
      );
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sp-row">
      <div className="sp-label">desired port</div>
      <input
        className="sp-input"
        style={{ maxWidth: 120 }}
        placeholder="random"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        inputMode="numeric"
        disabled={busy}
      />
      <button onClick={() => void save()} className="sp-btn" disabled={busy || !dirty || !valid}>
        save
      </button>
      <span className="sp-muted" style={{ fontSize: 11 }}>
        {currentBound != null && currentDesired != null && currentDesired !== currentBound
          ? `bound to ${currentBound} (rebind to ${currentDesired} pending or failed)`
          : currentBound != null
            ? `bound to ${currentBound}`
            : 'host not bound yet'}
      </span>
    </div>
  );
}
