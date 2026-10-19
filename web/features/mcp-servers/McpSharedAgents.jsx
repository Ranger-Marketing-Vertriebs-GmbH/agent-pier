import React from "react";
import { leadShareCopy as copy } from "../../lib/i18n/messages/lead-shares.js";
import RevokeLeadShare from "../assistants/RevokeLeadShare.jsx";

/**
 * The permanent members that use a server through their lead agent (server
 * McpChanges.sharedViews): each "via" its lead, revoked here by the owner.
 */
export default function McpSharedAgents({ server, onChanged }) {
  if (!server.shared?.length) return null;
  return (
    <div className="mcp-shared" data-mcp-shared={server.id}>
      <p className="mcp-hint">{copy.serverShared}</p>
      <ul className="mcp-list" aria-label={copy.serverShared}>
        {server.shared.map((s) => (
          <li key={s.id} className="mcp-shared-row">
            <span>
              {s.agentName} · {copy.via(s.leadName)}
              {s.requestId ? ` · ${copy.forTask}` : ""}
              {!s.bound ? ` · ${copy.inactive}` : ""}
            </span>
            <RevokeLeadShare
              share={{ ...s, memberName: s.agentName }}
              what={copy.mcpServer(server.name)}
              onRevoked={onChanged}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
