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
 * ones without an agent. A skill the agent learned itself (its Skill Workshop,
 * `source: "openclaw-workshop"`, from `<agentDir>/workshop-skills`) also carries the
 * port's `origin: "local"`, so its skills page lists it as the agent's own; the
 * report names it only for the agent it belongs to.
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

function skillsOver(current, version) {
  const call = async (...args) => current().call(...args);
  return {
    // `refresh`: rescan first, after a local change; only where the Gateway takes it.
    status: async ({ agentId, refresh } = {}) =>
      withOrigins(
        await call("skills.status", {
          ...(agentId && { agentId }),
          ...(refresh && atLeast(version(), skillRefreshRuntime) && { refresh: true }),
        }),
      ),
    unknownAgent,
  };
}
