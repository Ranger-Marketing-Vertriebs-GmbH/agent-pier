import { boundPort } from "./openclaw-agents.js";

// OpenClaw answers INVALID_REQUEST `unknown agent id "<id>"` for an agent it has not
// created yet (gateway-client.js keeps the reason as remoteMessage).
const unknownAgent = (error) =>
  error?.code === "INVALID_REQUEST" && /unknown agent/i.test(error?.remoteMessage || "");

/**
 * The skills sub-port (agent-runtime.js) over OpenClaw's `skills.status`: the skills
 * an agent's workspace resolves, with OpenClaw's own entry fields (`name`, `source`,
 * `eligible`, `missing`, `blockedByAgentFilter`, …), or the bundled and host-wide
 * ones without an agent. A skill the agent learned itself (its Skill Workshop,
 * `source: "openclaw-workshop"`, from `<agentDir>/workshop-skills`) also carries the
 * port's `origin: "local"`, so its skills page lists it as the agent's own; the
 * report names it only for the agent it belongs to.
 */
export const openClawSkills = (supervisor, clientOf) =>
  boundPort((current) => skillsOver(current), supervisor, clientOf);

// OpenClaw rescans skill folders about once a minute instead of watching them
// (openclaw#170341, 2026.11.3), and `refresh: true` rescans before it reports.

/** The source OpenClaw reports for a skill of the agent's Skill Workshop. */
export const learnedSource = "openclaw-workshop";
const withOrigins = (report) =>
  Array.isArray(report?.skills)
    ? {
        ...report,
        skills: report.skills.map((entry) =>
          entry?.source === learnedSource ? { ...entry, origin: "local" } : entry,
        ),
      }
    : report;

function skillsOver(current) {
  const call = async (...args) => current().call(...args);
  return {
    // `refresh`: rescan first, after a local change.
    status: async ({ agentId, refresh } = {}) =>
      withOrigins(
        await call("skills.status", {
          ...(agentId && { agentId }),
          ...(refresh && { refresh: true }),
        }),
      ),
    unknownAgent,
  };
}
