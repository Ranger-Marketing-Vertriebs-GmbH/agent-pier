import React, { useState } from "react";
import Icon from "../../components/Icon.jsx";
import { routePath } from "../../app/routes.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";
import { mcpServerCopy } from "../../lib/i18n/messages/mcp-servers.js";
import { sshCopy } from "../../lib/i18n/messages/ssh.js";
import { itemRoute } from "../accounts/accounts-items.js";
import McpFeedback from "../mcp-servers/McpFeedback.jsx";
import McpServerInfo from "../mcp-servers/McpServerInfo.jsx";
import McpUsedBy from "./McpUsedBy.jsx";
import { mcpCheckText } from "./mcp-check.js";
import "../mcp-servers/mcp-servers.css";
import "../mcp-servers/mcp-cli.css";

/**
 * The detail pane beside the MCP list: the server's live status (transport, details,
 * per-CLI status, OAuth, lead shares), "Benutzt von" with grant and revoke, and
 * "Status prüfen", "Bearbeiten" and "Vollansicht".
 */
export default function McpDetailPane({
  server,
  usage,
  agentsEnabled,
  assistants,
  data,
  oauth,
  mcpNotice,
  navigate,
  reloadUsage,
  close,
}) {
  const [checking, setChecking] = useState(false);
  // What the last "Check status" found, for this server only.
  const [checked, setChecked] = useState(null);
  const result = checked?.id === server.id ? checked : null;
  const full = itemRoute("mcp-servers", server.id);
  const edit = itemRoute("mcp-servers", server.id, "setup");
  const go = (route) => ({
    href: routePath(route),
    onClick: (event) => {
      event.preventDefault();
      navigate(route);
    },
  });
  return (
    <aside
      className="connections-pane"
      aria-label={server.name}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        type="button"
        className="icon-button connections-pane-close"
        aria-label={sshCopy.closeDetails}
        onClick={close}
      >
        <Icon name="close" />
      </button>
      <p className="connections-eyebrow">{copy.mcpKind}</p>
      <h3 className="connections-pane-title">{server.name}</h3>
      <div className="connections-actions">
        <button
          type="button"
          className="button secondary compact"
          disabled={checking}
          onClick={async () => {
            setChecking(true);
            setChecked(null);
            const list = await data.reloadMcp();
            setChecked({ id: server.id, failed: !list, at: Date.now() });
            setChecking(false);
          }}
        >
          {copy.checkStatus}
        </button>
        <a className="button secondary compact" {...go(edit)}>
          {copy.edit}
        </a>
        <a className="button secondary compact" {...go(full)}>
          {copy.fullView}
        </a>
      </div>
      <p className="accounts-note" role="status">
        {checking ? copy.checking : result ? mcpCheckText(server, result) : ""}
      </p>
      <McpServerInfo
        server={server}
        agentsEnabled={agentsEnabled}
        oauth={oauth}
        reload={data.reloadMcp}
      />
      <McpFeedback oauth={oauth} notice={mcpNotice} />
      <McpUsedBy
        server={server}
        usage={usage}
        agentsEnabled={agentsEnabled}
        assistants={assistants}
        navigate={navigate}
        onChanged={() => {
          reloadUsage();
          data.reloadMcp();
        }}
      />
      <p className="accounts-note">{mcpServerCopy.description}</p>
    </aside>
  );
}
