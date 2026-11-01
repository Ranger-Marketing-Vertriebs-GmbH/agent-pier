import { isDeepStrictEqual } from "node:util";
import { shellTools } from "../../../native-capabilities.js";
import { agentEntry } from "./agent-entry.js";

/**
 * The global tools.allow with exec and process present exactly when `wanted`, or
 * null when it already is (or the shell state is not managed: `wanted` undefined).
 */
export function shellAllow(allow = [], wanted) {
  if (wanted === undefined) return null;
  const has = shellTools.every((tool) => allow.includes(tool));
  const none = !shellTools.some((tool) => allow.includes(tool));
  if (wanted ? has : none) return null;
  return [
    ...allow.filter((tool) => !shellTools.includes(tool)),
    ...(wanted ? shellTools : []),
  ];
}

/**
 * The `config.patch` of the desired agent's model connection (`desired.model`): its
 * provider entry, written before the agent's own entry; null without a provider.
 */
export const providerPatch = ({ model } = {}) =>
  model?.provider
    ? { patch: { models: { providers: { [model.providerId]: model.provider } } } }
    : null;

/**
 * The live `config.patch` of one agent's entry over the running configuration
 * `config` (AssistantConfig.applyOnce): the paths of its desired state `desired`
 * (agent-desired-state.js) as agentEntry compiles them for what the runtime offers
 * now, the host's concurrency and the global shell tools. `state()`, read inside the
 * build as the write runs: agentEntry's options, plus `managed` (the team or native
 * tools are wired, so the entry's tools, skills and memory belong to AgentPier),
 * `hostCapacity` (a function: the host's member slots, when wired) and `shellGlobal`
 * (whether some agent has shell, undefined while that is not managed).
 */
export function agentPatch(config, desired, state) {
  const { managed, hostCapacity, shellGlobal, ...entryOptions } = state();
  const agentRuntime = desired.model?.agentRuntime;
  const agents = config.agents;
  const arrayKey = Array.isArray(agents.entries) ? "entries" : "list";
  // Live writes keep the managed paths even before the Gateway reports readiness.
  const configure = (entry = {}) =>
    agentEntry(entry, desired, { ...entryOptions, agentRuntime });
  const keyed = agents.entries && !Array.isArray(agents.entries);
  const keyedEntry = () => {
    const current = agents.entries[desired.runtimeAgentId];
    const next = configure(current);
    // A merge patch keeps omitted keys: null removes a lowered level's
    // override and keys the new level does not set (strictInlineEval).
    const before = current?.tools?.exec;
    if (managed && before && typeof before === "object")
      next.tools = {
        ...next.tools,
        exec: next.tools.exec
          ? {
              ...Object.fromEntries(Object.keys(before).map((key) => [key, null])),
              ...next.tools.exec,
            }
          : null,
      };
    // A merge patch keeps an omitted list: null removes the last skill, and the
    // hard lock's deny of an agent that is no user agent any more.
    if (managed && Array.isArray(current?.skills) && !next.skills) next.skills = null;
    if (managed && Array.isArray(current?.tools?.deny) && !next.tools?.deny)
      next.tools = { ...next.tools, deny: null };
    return next;
  };
  const patch = keyed
    ? { entries: { [desired.runtimeAgentId]: keyedEntry() } }
    : {
        [arrayKey]: (agents[arrayKey] || []).map((a) =>
          a.id === desired.runtimeAgentId ? configure(a) : a,
        ),
      };
  if (hostCapacity) patch.defaults = { maxConcurrent: hostCapacity() + 8 };
  // OpenClaw refuses to drop array items unless their exact path is named:
  // removing or changing the exec override drops pathPrepend entries.
  const replacePaths = keyed
    ? [
        `agents.entries.${desired.runtimeAgentId}.tools.allow`,
        `agents.entries.${desired.runtimeAgentId}.tools.exec.pathPrepend`,
      ]
    : [`agents.${arrayKey}`];
  // A shorter or removed skill list drops array items as well.
  if (keyed && Array.isArray(agents.entries[desired.runtimeAgentId]?.skills))
    replacePaths.push(`agents.entries.${desired.runtimeAgentId}.skills`);
  if (keyed && Array.isArray(agents.entries[desired.runtimeAgentId]?.tools?.deny))
    replacePaths.push(`agents.entries.${desired.runtimeAgentId}.tools.deny`);
  const globalAllow = shellAllow(config.tools?.allow, shellGlobal);
  if (globalAllow) replacePaths.push("tools.allow");
  return {
    patch: {
      agents: patch,
      ...(globalAllow && { tools: { allow: globalAllow } }),
    },
    replacePaths,
  };
}

/**
 * Whether the running configuration `config` holds anything else for the desired
 * agent than its apply wrote (`expected`): its tools (`tools`), exec override and
 * skills while `managed`, the global shell tools while `shellGlobal` is managed, its
 * memory search while `memory` is (a boolean), and the agent runtime and model of
 * its model connection, when it names one. True means the apply did not take.
 */
export function agentDrift(config, desired, expected) {
  const { managed, tools: allowed, exec, skills, shellGlobal, memory } = expected;
  const { runtimeAgentId, model: connection } = desired;
  const agentRuntime = connection?.agentRuntime;
  const entries = config?.agents?.entries;
  const entry = Array.isArray(entries)
    ? entries.find((a) => a.id === runtimeAgentId)
    : entries?.[runtimeAgentId];
  const legacy = config?.agents?.list?.find((a) => a.id === runtimeAgentId);
  const own = entry || legacy;
  if (managed && !isDeepStrictEqual(own?.tools?.allow, allowed)) return true;
  // OpenClaw's merge keeps existing keys first: compare regardless of key order.
  if (managed && !isDeepStrictEqual(own?.tools?.exec ?? null, exec ?? null)) return true;
  if (managed && !isDeepStrictEqual(own?.skills ?? [], skills)) return true;
  if (shellGlobal !== undefined && shellAllow(config?.tools?.allow, shellGlobal) !== null)
    return true;
  if (memory !== undefined && own?.memory?.search?.enabled !== memory) return true;
  if (
    agentRuntime &&
    own?.models?.[agentRuntime.model]?.agentRuntime?.id !== agentRuntime.id
  )
    return true;
  if (!connection) return false;
  const model = own?.model;
  return (typeof model === "string" ? model : model?.primary) !== connection.ref;
}
