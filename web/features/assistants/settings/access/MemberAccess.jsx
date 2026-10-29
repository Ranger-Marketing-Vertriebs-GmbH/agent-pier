import React, { useEffect, useState } from "react";
import api from "../../../../lib/api.js";
import useLiveTopic from "../../../../lib/live/useLiveTopic.js";
import TemporaryMcpServers from "../../../mcp-servers/TemporaryMcpServers.jsx";
import useAssistants from "../../useAssistants.js";
import GrantedCapabilities from "../GrantedCapabilities.jsx";
import LeadSharesGroup from "../LeadSharesGroup.jsx";
import AgentSshAgentStatus from "./AgentSshAgentStatus.jsx";

/**
 * The lead's SSH hosts as the member's plain ssh names them: the catalog hosts and
 * whether the lead's saved grants hold one with approval. Read again whenever the
 * member's plain ssh changes live (`agent.ssh-agent:<member>`: a lead's revoke or
 * mode switch changes its aliases). Null while loading or when either read fails
 * (no names, no approval hint).
 */
function useLeadSsh(memberId, leadId) {
  const [lead, setLead] = useState(null);
  const { data } = useLiveTopic(leadId ? `agent.ssh-agent:${memberId}` : null);
  const version = data ? JSON.stringify([data.state, data.reason, data.aliases]) : "";
  useEffect(() => setLead(null), [leadId]);
  useEffect(() => {
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
  }, [leadId, version]);
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
  const lead = useLeadSsh(assistant.id, ssh ? assistant.parentAssistantId : null);
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
