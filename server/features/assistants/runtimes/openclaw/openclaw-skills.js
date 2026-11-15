import { atLeast } from "../../../tools/cli-version.js";
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
  boundPort(
    (current) => skillsOver(current, () => supervisor.status?.()?.version),
    supervisor,
    clientOf,
  );

// Since 2026.11.3 (openclaw#170341) OpenClaw rescans skill folders about once a
// minute instead of watching them, and `refresh: true` rescans before it reports.
// 2026.10.9 and earlier still watch them and refuse a parameter they do not know.
export const skillRefreshRuntime = "2026.11.3";

function skillsOver(current, version) {
  const call = async (...args) => current().call(...args);
  return {
    // `refresh`: rescan first, after a local change; only where the Gateway takes it.
    status: ({ agentId, refresh } = {}) =>
      call("skills.status", {
        ...(agentId && { agentId }),
        ...(refresh && atLeast(version(), skillRefreshRuntime) && { refresh: true }),
      }),
    unknownAgent,
  };
}
