import { boundPort } from "./openclaw-agents.js";

// OpenClaw answers INVALID_REQUEST `unknown agent id "<id>"` for an agent it has not
// created yet (gateway-client.js keeps the reason as remoteMessage).
const unknownAgent = (error) =>
  error?.code === "INVALID_REQUEST" && /unknown agent/i.test(error?.remoteMessage || "");

/**
 * The skills sub-port (agent-runtime.js) over OpenClaw's `skills.status`: the skills
 * an agent's workspace resolves, with OpenClaw's own entry fields (`name`, `source`,
 * `eligible`, `missing`, `blockedByAgentFilter`, …), or the bundled and host-wide
 * ones without an agent.
 */
export const openClawSkills = (supervisor, clientOf) =>
  boundPort(skillsOver, supervisor, clientOf);

function skillsOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    status: ({ agentId } = {}) => call("skills.status", agentId ? { agentId } : {}),
    unknownAgent,
  };
}
