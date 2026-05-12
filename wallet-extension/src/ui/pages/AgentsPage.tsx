/**
 * agents page: promoted from a `SettingsPage` section to a top-level tab. houses the MCP
 * surface: native-host config, bearer token, listen port, agent URL, status indicators.
 *
 * accessed via the Agents icon in the four-icon expandable tray (between IKA Staking + Lab + Payments).
 */

import { AgentsSettingsSection } from '@/ui/components/AgentsSettingsSection';

export function AgentsPage({ onBack }: { onBack: () => void }) {
  return (
    <div className="sp-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <button type="button" className="sp-backBtn" onClick={onBack}>
          ← back
        </button>
        <h2 className="sp-pageTitle">agents · MCP</h2>
      </div>

      <p className="sp-muted" style={{ fontSize: 11, marginTop: 0 }}>
        AI agents (Claude Desktop, Cursor, etc.) can drive chromatika via the Model Context Protocol.
        chromatika ships a local-only HTTP MCP surface bound to <code>127.0.0.1:&lt;port&gt;</code>,
        gated by a per-install bearer token. read tools (list vaults, list active alerts) run without
        a popup; write tools (sign messages / send EVM tx / sign tx) open the existing approval popup
        every time so you stay in control.
      </p>

      <AgentsSettingsSection />
    </div>
  );
}
