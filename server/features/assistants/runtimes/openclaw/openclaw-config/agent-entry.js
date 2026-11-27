import { grantedTools, senderLockedTools } from "../../../native-capabilities.js";
import { agentExec } from "./shell.js";
import { lockEntry } from "../../../../users/user-agent-lock.js";
import { asDesired } from "./desired-agents.js";
import { learningTools } from "./skill-learning.js";
import { agentWikiTools } from "./memory-wiki.js";

// One definition for a Gateway start and a live apply: the same agent (its desired
// state, agent-desired-state.js) and runtime state always yield the same managed
// entry paths. `toolsManaged` and
// `memoryManaged` let a caller whose readiness probes are wired but report "not
// ready" still reset those paths; they default to the readiness itself. `available`
// (see webToolsAvailability) withholds web tools whose browser or provider is absent;
// `mcpTools` are the agent's MCP globs the Gateway was started with (mcpSections).
// `pathPrepend` is the owner's login PATH for an agent with shell (see shell.js); the
// exec override accompanies exec in the tool list, so both follow native readiness.

/**
 * How the agent's model works, as its entry holds it: OpenClaw's `thinkingDefault`
 * and `fastModeDefault` from the agent's options (openclaw-options.js; a temporary
 * member's are its lead's). A key the agent leaves unset is absent, so OpenClaw's own
 * order decides: the model's parameters, then agents.defaults, then the provider.
 */
export function modelDefaults(agent) {
  const { thinking, fastMode } = asDesired(agent).runtimeOptions;
  return {
    ...(typeof thinking === "string" && { thinkingDefault: thinking }),
    ...(typeof fastMode === "boolean" && { fastModeDefault: fastMode }),
  };
}
/** The entry keys modelDefaults manages; a live apply removes the ones left out. */
export const modelDefaultKeys = Object.freeze(["thinkingDefault", "fastModeDefault"]);

/**
 * Whether the agent's entry switches OpenClaw's rolling loop detectors on
 * (`tools.loopDetection.enabled`, off by default): the owner's choice
 * (openclaw-options.js `loopDetection`), else automatically for a model of an
 * endpoint connection, the owner's own and often a small or local model. A Gateway
 * start knows no model connection (`model` comes with a live apply) and keeps what
 * the last apply wrote into `entry`; the agent's next apply decides again. Off is
 * never written as `false`: that would also disable OpenClaw's guard after a
 * compaction, which stays on while the key is absent.
 */
export function loopProtection(agent, entry) {
  const desired = asDesired(agent);
  const chosen = desired.runtimeOptions.loopDetection;
  if (typeof chosen === "boolean") return chosen;
  if (!desired.model) return entry?.tools?.loopDetection?.enabled === true;
  return desired.model.kind === "endpoint";
}

export function agentEntry(
  entry,
  assistant,
  {
    teamsReady,
    nativeReady,
    guardProven,
    agentRuntime,
    toolsManaged = !!(teamsReady || nativeReady),
    memoryManaged = !!nativeReady,
    available = {},
    mcpTools = [],
    pathPrepend = [],
    // The agent owns a bot for other people (openclaw-config/telegram-senders.js).
    senderFacing = false,
    // The agent holds an SSH grant (agentpier_ssh).
    ssh = false,
    // Assigned skills a same-named workspace, workshop or managed skill would replace
    // (skill-shadows.js), and catalog skills that must not load (damaged, needing
    // settings, not checked or bundled by the runtime): never compiled.
    shadowedSkills = [],
  },
) {
  const agent = asDesired(assistant, { ssh });
  const next = { ...entry };
  const exec = nativeReady ? agentExec(agent.shell.level, pathPrepend) : undefined;
  if (toolsManaged)
    next.tools = {
      allow: [
        ...grantedTools(agent.tools, {
          teamsReady,
          nativeReady,
          writeGuard: guardProven,
          available,
          mcpTools,
        }).filter((tool) => !senderFacing || !senderLockedTools.includes(tool)),
        // "Learns its own skills" (skill-learning.js): OpenClaw's skill_workshop.
        ...learningTools(agent, { nativeReady, senderFacing }),
        // The memory wiki (memory-wiki.js): OpenClaw's five wiki tools.
        ...agentWikiTools(agent, { nativeReady, senderFacing }),
      ],
      ...(exec && { exec }),
      ...(loopProtection(agent, entry) && { loopDetection: { enabled: true } }),
    };
  if (toolsManaged) {
    for (const key of modelDefaultKeys) delete next[key];
    Object.assign(next, modelDefaults(agent));
  }
  // The agent's final skill list (agents.defaults.skills is []): the bundled and
  // catalog skills the owner switched on, plus AgentPier's built-in skills the agent
  // gets (built-in-skills.js), and only once native tools are ready.
  if (toolsManaged) {
    const skills = nativeReady
      ? agent.skills.compiled.filter((name) => !shadowedSkills.includes(name))
      : [];
    if (skills.length) next.skills = skills;
    else delete next.skills;
  }
  if (memoryManaged)
    next.memory = {
      search: {
        enabled: !!nativeReady && agent.memory,
        rememberAcrossConversations: false,
      },
    };
  if (agentRuntime)
    next.models = {
      ...entry.models,
      [agentRuntime.model]: {
        ...entry.models?.[agentRuntime.model],
        agentRuntime: { id: agentRuntime.id },
      },
    };
  // Last, so nothing above can hand a user agent a locked tool (user-agent-lock.js).
  return lockEntry(next, agent.locked);
}
