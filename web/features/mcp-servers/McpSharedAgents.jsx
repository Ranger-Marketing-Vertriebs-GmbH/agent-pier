import React from "react";
import { leadShareCopy as copy } from "../../lib/i18n/messages/lead-shares.js";
import RevokeLeadShare from "../assistants/RevokeLeadShare.jsx";

/**
 * The members that use a server through their lead agent (server
 * McpChanges.sharedViews): permanent members' shares and task-bound members'
 * grants, each "via" its lead, revoked here by the owner.
 */
export default function McpSharedAgents({ server, onChanged }) {
  const shared = server.shared || [],
    granted = server.memberGrants || [];
  if (!shared.length && !granted.length) return null;
  return (
    <div className="mcp-shared" data-mcp-shared={server.id}>
      <p className="mcp-hint">{copy.serverShared}</p>
      <ul className="mcp-list" aria-label={copy.serverShared}>
        {shared.map((s) => (
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
        {granted.map((g) => (
          <li key={g.id} className="mcp-shared-row">
            <span>
              {g.agentName} · {copy.via(g.leadName)} · {copy.taskMember}
              {!g.bound ? ` · ${copy.inactive}` : ""}
            </span>
            <RevokeLeadShare
              share={{ ...g, temporary: true, memberName: g.agentName }}
              what={copy.mcpServer(server.name)}
              onRevoked={onChanged}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
