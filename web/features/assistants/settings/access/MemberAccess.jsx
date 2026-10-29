import React from "react";
import TemporaryMcpServers from "../../../mcp-servers/TemporaryMcpServers.jsx";
import useAssistants from "../../useAssistants.js";
import GrantedCapabilities from "../GrantedCapabilities.jsx";
import LeadSharesGroup from "../LeadSharesGroup.jsx";
import AgentSshAgentStatus from "./AgentSshAgentStatus.jsx";

/**
 * A temporary member's Access tab: what its lead granted (read only), the lead's
 * grants of folders, MCP servers, shell and SSH with Revoke, and its temporary MCP
 * servers, and while it uses its lead's SSH hosts its own plain ssh with them. The
 * owner changes nothing else here; the lead decides.
 */
export default function MemberAccess({ assistant }) {
  const { members = [] } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id);
  return (
    <>
      {assistant.inherited && (
        <GrantedCapabilities inherited={assistant.inherited} member={member} />
      )}
      {assistant.inherited && <LeadSharesGroup assistant={assistant} />}
      {assistant.inherited?.ssh === true && (
        <AgentSshAgentStatus assistantId={assistant.id} approval />
      )}
      {member && <TemporaryMcpServers servers={member.mcpServers} />}
    </>
  );
}
