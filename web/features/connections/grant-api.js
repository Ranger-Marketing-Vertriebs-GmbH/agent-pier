import api from "../../lib/api.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { grantAccessBody, mcpServersWith, sshGrantsBody } from "./agent-grants.js";

// The requests behind "Benutzt von" and the bulk grants: the agent's current access
// policy is read right before each write, so the write carries its latest revision; a
// change made in between still comes back as a 409 and is reported, not retried.
const accessOf = (agentId) => api(`/assistants/${encodeURIComponent(agentId)}/access`);
const saveAccess = (agentId, access) => assistantApi.saveWork(agentId, { access });

/** One grant of an SSH host, secret or GitHub profile set to `mode` (null revokes). */
export async function saveGrant(agentId, change) {
  const policy = await accessOf(agentId);
  const access = grantAccessBody(policy, change);
  return access ? saveAccess(agentId, access) : { access: policy };
}

/** Several SSH hosts for one agent in one write, each at `mode` (null revokes). */
export async function saveSshGrants(agentId, accessIds, mode) {
  const policy = await accessOf(agentId);
  return saveAccess(agentId, sshGrantsBody(policy, accessIds, mode));
}

/**
 * Adds (or removes) MCP servers to one agent, as the server wizard's Connect step does:
 * only these servers change, the agent's other bindings stay. `confirmStdio` carries
 * the owner's consent for local commands.
 */
export async function saveMcpBinding(agentId, serverIds, { add, confirmStdio = false }) {
  const agents = (await assistantApi.list())?.assistants ?? [];
  const agent = agents.find((item) => item.id === agentId);
  if (!agent || !Array.isArray(agent.mcpServers))
    throw Object.assign(new Error("AGENT_GONE"), { code: "AGENT_GONE" });
  return assistantApi.update(agentId, {
    mcpServers: mcpServersWith(agent.mcpServers, serverIds, add),
    revision: agent.revision,
    ...(confirmStdio && add ? { confirmStdio: true } : {}),
  });
}
