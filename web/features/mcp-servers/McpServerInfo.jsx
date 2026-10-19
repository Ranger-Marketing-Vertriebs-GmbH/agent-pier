import React from "react";
import { mcpServerCopy as copy } from "../../lib/i18n/messages/mcp-servers.js";
import McpCliStatus from "./McpCliStatus.jsx";
import McpServerDetails, { usersText } from "./McpServerDetails.jsx";
import McpSharedAgents from "./McpSharedAgents.jsx";
import { McpOAuthActions } from "./McpOAuthLogin.jsx";
import McpOAuthStatus, { McpOAuthStatusHint, usesOAuth } from "./McpOAuthStatus.jsx";

/**
 * What a saved server is: transport, details, users, per-CLI status (overwrite/adopt,
 * Codex account logins) and, with agents, its OAuth login. Agent OAuth logins exist
 * only with agents; the rest works without.
 */
export default function McpServerInfo({ server, agentsEnabled, oauth, reload }) {
  const agentLogin = agentsEnabled && usesOAuth(server);
  return (
    <div className="mcp-item">
      <div className="mcp-item-head">
        <strong>{server.name}</strong>
        <span className="mcp-badge">{copy.transports[server.transport]}</span>
        {server.transport === "stdio" && (
          <span className="mcp-badge mcp-badge-warn">{copy.stdioBadge}</span>
        )}
        {agentLogin && <McpOAuthStatus server={server} />}
      </div>
      <McpServerDetails server={server} />
      {server.users && <p className="mcp-hint">{usersText(server)}</p>}
      {agentsEnabled && <McpSharedAgents server={server} onChanged={reload} />}
      <McpCliStatus server={server} onChanged={reload} />
      {agentLogin && <McpOAuthStatusHint server={server} />}
      {agentLogin && (
        <div className="mcp-actions">
          <McpOAuthActions server={server} oauth={oauth} />
        </div>
      )}
    </div>
  );
}
