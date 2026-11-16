// The traits of the agent runtimes (docs/adr/0007-runtime-descriptor.md): how a
// runtime behaves in a feature both AgentPier and the runtime have. AgentPier owns the
// vocabulary: each trait belongs to a capability (agent-runtime.js
// RUNTIME_CAPABILITIES), names behaviour (never a runtime) and has a default, which is
// OpenClaw's behaviour. A runtime states its values in its descriptor
// (runtimes/<id>/descriptor.js); feature code reads them (runtime-for.js traitOf,
// the web app's runtime-traits.js) instead of comparing a runtime id.

const oneOf = (...values) => ({
  default: values[0],
  allows: (value) => values.includes(value),
});
const flag = (value) => ({
  default: value,
  allows: (candidate) => typeof candidate === "boolean",
});
const SHELL_LEVELS = Object.freeze(["off", "approval", "every", "full"]);
const subsetOf = (all, value) => ({
  default: Object.freeze(value),
  allows: (candidate) =>
    Array.isArray(candidate) &&
    candidate.every((entry) => all.includes(entry)) &&
    new Set(candidate).size === candidate.length,
});

/**
 * `{ [feature]: { [trait]: { default, allows(value) } } }`.
 *
 * - approvals.shellLevels: the shell levels an agent may choose. "every" asks before
 *   every command, beside an "approval" that asks only for dangerous ones.
 * - approvals.allowlist: what "Always allow" keeps: `patterns` in the runtime's own
 *   allowlist, which AgentPier reads and writes through the approvals sub-port, or
 *   only the `exactCommands` AgentPier remembers (exec-remembered.js).
 * - agentFiles.memoryFormat: the memory file as `markdown` notes, or as separated
 *   `entries` with character limits.
 * - agentFiles.dreaming: who consolidates memory at night: the `host` for all its
 *   agents (the owner's dreaming switch), or each `agent` by itself.
 * - models.chatgptLogin: the ChatGPT logins an agent may use: `any`, or only one
 *   AgentPier holds (`agentpierHeld`), which reaches the runtime through its proxy.
 * - channelBots.peopleApply: how a change of the people an agent's own bot admits
 *   reaches the running agent: `live`, or with a `restart` of the agent.
 * - skills.learnsByDefault: whether an agent that never chose learns its own skills
 *   (skill-learning.js): reviews finished work and saves procedures as skills.
 * - skills.userAgentsLearn: whether an agent of restricted users may learn. False
 *   where learned skills bypass the skill lists that limit what such an agent reads.
 * - skills.writesWhenAsked: whether an agent with learning off still writes a skill
 *   when asked to; false where learning off takes the skill-writing tool away.
 * - sessions.chatFolders: whether each chat keeps its files in a folder of its own.
 * - host.process: one `shared` host for every agent, or a process set `perAgent`.
 * - host.install: `builtin` (comes with switching agents on) or `optional` (the
 *   owner installs it).
 */
export const RUNTIME_TRAITS = Object.freeze({
  approvals: Object.freeze({
    shellLevels: subsetOf(SHELL_LEVELS, ["off", "approval", "full"]),
    allowlist: oneOf("patterns", "exactCommands"),
  }),
  agentFiles: Object.freeze({
    memoryFormat: oneOf("markdown", "entries"),
    dreaming: oneOf("host", "agent"),
  }),
  models: Object.freeze({ chatgptLogin: oneOf("any", "agentpierHeld") }),
  channelBots: Object.freeze({ peopleApply: oneOf("live", "restart") }),
  skills: Object.freeze({
    learnsByDefault: flag(false),
    userAgentsLearn: flag(false),
    writesWhenAsked: flag(false),
  }),
  sessions: Object.freeze({ chatFolders: flag(false) }),
  host: Object.freeze({
    process: oneOf("shared", "perAgent"),
    install: oneOf("builtin", "optional"),
  }),
});

const frozenValue = (value) => (Array.isArray(value) ? Object.freeze([...value]) : value);

/**
 * Every trait with the value `stated` (`{ [feature]: { [trait]: value } }`) gives it,
 * else its default; deep-frozen. A feature or trait the schema does not name and a
 * value it refuses throw a TypeError naming `feature.trait`.
 */
export function resolveTraits(stated = {}) {
  for (const [feature, traits] of Object.entries(stated)) {
    if (!Object.hasOwn(RUNTIME_TRAITS, feature))
      throw new TypeError(`Unknown runtime trait feature: ${feature}`);
    for (const [trait, value] of Object.entries(traits || {})) {
      const name = `${feature}.${trait}`;
      if (!Object.hasOwn(RUNTIME_TRAITS[feature], trait))
        throw new TypeError(`Unknown runtime trait: ${name}`);
      if (!RUNTIME_TRAITS[feature][trait].allows(value))
        throw new TypeError(`Runtime trait ${name} refuses ${JSON.stringify(value)}`);
    }
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(RUNTIME_TRAITS).map(([feature, traits]) => [
        feature,
        Object.freeze(
          Object.fromEntries(
            Object.entries(traits).map(([trait, { default: fallback }]) => [
              trait,
              frozenValue(
                Object.hasOwn(stated[feature] || {}, trait)
                  ? stated[feature][trait]
                  : fallback,
              ),
            ]),
          ),
        ),
      ]),
    ),
  );
}

/** Every trait at its default: OpenClaw's behaviour. */
export const DEFAULT_TRAITS = resolveTraits();
