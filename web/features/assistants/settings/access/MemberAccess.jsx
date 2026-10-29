import React, { useEffect, useState } from "react";
import api from "../../../../lib/api.js";
import TemporaryMcpServers from "../../../mcp-servers/TemporaryMcpServers.jsx";
import useAssistants from "../../useAssistants.js";
import GrantedCapabilities from "../GrantedCapabilities.jsx";
import LeadSharesGroup from "../LeadSharesGroup.jsx";
import AgentSshAgentStatus from "./AgentSshAgentStatus.jsx";

/**
 * The lead's SSH hosts as the member's plain ssh names them: the catalog hosts and
 * whether the lead's saved grants hold one with approval. Null while loading or when
 * either read fails (no names, no approval hint).
 */
function useLeadSsh(leadId) {
  const [lead, setLead] = useState(null);
  useEffect(() => {
    setLead(null);
    if (!leadId) return undefined;
    let active = true;
    Promise.all([
      api(`/assistants/${encodeURIComponent(leadId)}/access`),
      api("/assistant-workspace-catalog"),
    ])
      .then(([access, list]) => {
        if (!active) return;
        const hosts = list?.sshHosts || [];
        const listed = new Set(hosts.map((host) => host.id));
        setLead({
          hosts,
          approval: (access?.sshAccesses || []).some(
            (grant) => grant.mode === "approval" && listed.has(grant.accessId),
          ),
        });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [leadId]);
  return lead;
}

/**
 * A temporary member's Access tab: what its lead granted (read only), the lead's
 * grants of folders, MCP servers, shell and SSH with Revoke, and its temporary MCP
 * servers, and while it uses its lead's SSH hosts its own plain ssh with them. The
 * owner changes nothing else here; the lead decides.
 */
export default function MemberAccess({ assistant }) {
  const { members = [] } = useAssistants();
  const member = members.find((m) => m.assistantId === assistant.id);
  const ssh = assistant.inherited?.ssh === true;
  const lead = useLeadSsh(ssh ? assistant.parentAssistantId : null);
  return (
    <>
      {assistant.inherited && (
        <GrantedCapabilities inherited={assistant.inherited} member={member} />
      )}
      {assistant.inherited && <LeadSharesGroup assistant={assistant} />}
      {ssh && (
        <AgentSshAgentStatus
          assistantId={assistant.id}
          hosts={lead?.hosts}
          approval={lead?.approval === true}
        />
      )}
      {member && <TemporaryMcpServers servers={member.mcpServers} />}
    </>
  );
}
