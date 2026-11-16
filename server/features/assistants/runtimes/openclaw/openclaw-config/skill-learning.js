import { asDesired } from "./desired-agents.js";

// "Learns its own skills" on OpenClaw (the runtime's docs/tools/self-learning.md and
// skill-workshop.md, verified for 2026.10.9). OpenClaw's review mode
// (`skills.workshop.autonomous.mode`) is Gateway-wide; what it has per agent is tool
// policy: an agent whose tools lack `skill_workshop` is never reviewed and saves no
// skill. So an agent that learns holds the tool, and the mode is "auto" while at
// least one agent does, else "off" as before the option existed. Learned skills live
// in the agent's own `workshop-skills/` and bypass the skill lists of its entry.

/** OpenClaw's tool for every change of a learned skill. */
export const learningTool = "skill_workshop";

/**
 * Whether the agent (its desired state, or a stored record) learns on OpenClaw: its
 * own setting, never an archived agent, a task member or an agent of restricted
 * users (`locked`), whatever its record says.
 */
export const learns = (agent) => {
  const desired = asDesired(agent);
  return (
    desired.eligible &&
    !desired.archived &&
    !desired.inherits &&
    !desired.locked &&
    desired.skills.learning === true
  );
};

/**
 * The tools learning adds to the agent's entry, once native tools are ready. An
 * agent with a bot for other people gets none: the background review reads the
 * agent's other sessions, which are those people's chats.
 */
export const learningTools = (agent, { nativeReady, senderFacing = false } = {}) =>
  nativeReady && !senderFacing && learns(agent) ? [learningTool] : [];

/** Whether the host reviews at all: at least one of `agents` learns. */
export const hostLearns = (agents = []) => agents.some(learns);

/** The Gateway-wide review mode for `wanted`. */
export const learningMode = (wanted) => (wanted ? "auto" : "off");

/**
 * The global tools.allow with the learning tool present exactly when `wanted`, or
 * null when it already is (or learning is not managed: `wanted` undefined).
 */
export function learningAllow(allow = [], wanted) {
  if (wanted === undefined || allow.includes(learningTool) === wanted) return null;
  return [
    ...allow.filter((tool) => tool !== learningTool),
    ...(wanted ? [learningTool] : []),
  ];
}

/**
 * The review mode a live apply must write into `config` for `wanted`, or null: "auto"
 * unless it is there, "off" only over a written "auto". A running Gateway AgentPier
 * started with native tools always names its mode (applyLearning).
 */
export function learningModeChange(config, wanted) {
  if (wanted === undefined) return null;
  const current = config?.skills?.workshop?.autonomous?.mode;
  if (wanted ? current === "auto" : current !== "auto") return null;
  return learningMode(wanted);
}

/** Whether `config` holds the review mode and the global tool for `wanted`. */
export const learningApplied = (config, wanted) =>
  learningAllow(config?.tools?.allow, wanted) === null &&
  learningModeChange(config, wanted) === null;

/** A start's configuration with the mode and the global tool for its agents. */
export function applyLearning(config, wanted) {
  config.skills = {
    ...config.skills,
    workshop: { ...config.skills?.workshop, autonomous: { mode: learningMode(wanted) } },
  };
  const allow = learningAllow(config.tools.allow, wanted);
  if (allow) config.tools.allow = allow;
}
