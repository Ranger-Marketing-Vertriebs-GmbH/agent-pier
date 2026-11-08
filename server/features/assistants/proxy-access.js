import { withInherited } from "../mcp-servers/mcp-inputs.js";
import { ownProcess } from "./runtimes/runtime-for.js";
import { personalCapabilities } from "./native-capabilities.js";

// Who may use a credential of AgentPier's runtime proxy (model-logins/
// runtime-proxy.js), decided at every request from the current store, so a changed
// model, a removed binding, an archived or deleted agent or a disabled user revokes
// it at once. The credential names its scope; this decides whether that scope still
// holds:
// - ["chatgpt", agentId, profileId]: the Hermes agent `agentId` exists, is active,
//   belongs to an active user (if any) and its current model is that ChatGPT login;
//   the Codex images endpoints only while it may create images now, with that login
//   as its model or as the one AgentPier chose for its images (model-accounts.js
//   heldImageLogin). Its Responses route also while the agent may read PDFs and that
//   login is the owner's PDF fallback now (pdf-policy.js fallback): its pdf tool
//   reads with it (hermes-config/pdf.js).
// - ["mcp", serverId, agentId]: the Hermes agent is such an agent and bound to the
//   server (its own bindings or those it uses through its lead).
// - ["mcp", serverId, "openclaw"]: the Gateway's one entry (OpenClaw's `mcp.servers`
// is global); valid while at least one such OpenClaw agent is bound. Inside the
//   Gateway each agent reaches only its own servers' tools (tools.allow), as for
//   every server with headers.

/**
 * `assistants`: the AssistantService (`store`, `userActive(userId)`, `workflows`,
 * `accounts`: the model accounts);
 * `servers`: the MCP server store; `accountIdOf(profileId)`: the account id agents
 * select for a ChatGPT profile (model-accounts.js).
 */
export function proxyAccess({ assistants, servers, accountIdOf }) {
  const active = (agent) =>
    !!agent &&
    !agent.archivedAt &&
    (typeof agent.userId !== "string" || assistants.userActive?.(agent.userId) !== false);
  const hermesAgent = (agentId) => {
    const agent = assistants.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === agentId && ownProcess(a));
    return active(agent) ? agent : null;
  };
  const boundTo = (serverId) => {
    let bindings = {};
    try {
      bindings = withInherited(
        servers.bindingsByTarget("agent"),
        () => assistants.workflows?.shares?.mcpBindings() || {},
      );
    } catch {
      bindings = {};
    }
    return (agent) => (bindings[agent.id] || []).includes(serverId);
  };
  return {
    chatgpt(agentId, profileId, { images = false } = {}) {
      const agent = hermesAgent(agentId);
      if (!agent) return false;
      const model = agent.model?.connectionId === accountIdOf(profileId);
      if (!images)
        return (
          model ||
          (personalCapabilities(agent).readPdfs === true &&
            assistants.pdfPolicy?.fallback?.()?.connectionId === accountIdOf(profileId))
        );
      return (
        personalCapabilities(agent).createImages === true &&
        (model ||
          assistants.accounts?.heldImageLogin?.(agent.model?.connectionId) === profileId)
      );
    },
    mcp(serverId, consumer) {
      const bound = boundTo(serverId);
      if (consumer === "openclaw")
        return assistants.store
          .listAssistants()
          .some((agent) => !ownProcess(agent) && active(agent) && bound(agent));
      const agent = hermesAgent(consumer);
      return !!agent && bound(agent);
    },
  };
}
