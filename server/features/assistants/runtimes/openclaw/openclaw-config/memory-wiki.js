import { asDesired } from "./desired-agents.js";
import { openClawDescriptor } from "../descriptor.js";

// The memory wiki on OpenClaw (ADR 0007, step 7b; the pinned runtime's
// docs/plugins/memory-wiki.md). The bundled plugin `memory-wiki` serves the whole
// Gateway: one instance, its five tools registered for every agent. AgentPier loads it
// only while at least one agent keeps a wiki, with one vault per agent
// (`vault.scope: "agent"`, `<OPENCLAW_STATE_DIR>/wiki/<runtimeAgentId>`), and grants
// its tools to those agents alone: the global tools.allow is every agent's upper
// bound, each agent's own list decides. The plugin makes no model or embedding calls
// of its own; search stays local to the wiki and the memory search stays off.

/** OpenClaw's plugin id. */
export const wikiPlugin = "memory-wiki";
/** The plugin's tools, in the order AgentPier grants them. */
export const wikiTools = Object.freeze([
  "wiki_status",
  "wiki_search",
  "wiki_get",
  "wiki_apply",
  "wiki_lint",
]);

/**
 * The plugin's configuration as AgentPier compiles it. Unknown keys are refused by
 * the plugin's schema. Bridge: at each wiki tool call the plugin imports the agent's
 * own memory notes (MEMORY.md, its day notes under memory/ and dream reports, which
 * memory-core exports with search off) as source pages of the agent's vault, so the
 * wiki fills by itself and `wiki_apply` has sources to cite (a synthesis needs one;
 * isolated, nothing could be cited). Memory event logs stay out. Obsidian, URL
 * ingestion, the shared memory search and the compiled digest in the prompt stay off.
 */
export const wikiConfig = () => ({
  vaultMode: "bridge",
  vault: { scope: "agent", renderMode: "native" },
  obsidian: { enabled: false, useOfficialCli: false, openAfterWrites: false },
  bridge: {
    enabled: true,
    readMemoryArtifacts: true,
    indexMemoryRoot: true,
    indexDailyNotes: true,
    indexDreamReports: true,
    followMemoryEvents: false,
  },
  ingest: { autoCompile: true, allowUrlIngest: false },
  search: { backend: "local", corpus: "wiki" },
  context: { includeCompiledDigestPrompt: false },
});

/**
 * Whether the agent (its desired state, or a stored record) keeps a wiki on OpenClaw:
 * its own option, only for an agent of this runtime that is the owner's own (never
 * shared with users, never a user's, never a temporary member) and not archived.
 * The options module already reads the option as off for such an agent
 * (openclaw-options.js); this repeats the rule where the grant is compiled.
 */
export const hasWiki = (agent) => {
  const desired = asDesired(agent);
  return (
    desired.runtime === openClawDescriptor.id &&
    desired.eligible &&
    !desired.archived &&
    !desired.inherits &&
    !desired.locked &&
    !desired.shared &&
    desired.runtimeOptions?.memoryWiki === true
  );
};

/** The tools the wiki adds to the agent's entry, once native tools are ready. */
export const agentWikiTools = (agent, { nativeReady } = {}) =>
  nativeReady && hasWiki(agent) ? [...wikiTools] : [];

/** Whether the Gateway loads the plugin: at least one of `agents` keeps a wiki. */
export const hostWiki = (agents = []) => agents.some((agent) => hasWiki(agent));

/**
 * What an agent apply writes: the agent's own tools (agentWikiTools) and whether the
 * host's global list holds the wiki's tools (`global`, undefined while native tools
 * are not ready), from every agent's record (`profiles`, else the agent's alone).
 */
export const agentWiki = (agent, { nativeReady, profiles } = {}) => ({
  tools: agentWikiTools(agent, { nativeReady }),
  global: nativeReady ? hostWiki(profiles || [agent]) : undefined,
});

/**
 * The global tools.allow with the wiki's tools present exactly when `wanted`, or null
 * when they already are (or the wiki is not managed: `wanted` undefined).
 */
export function wikiAllow(allow = [], wanted) {
  if (wanted === undefined) return null;
  const has = wikiTools.every((tool) => allow.includes(tool));
  const none = !wikiTools.some((tool) => allow.includes(tool));
  if (wanted ? has : none) return null;
  return [
    ...allow.filter((tool) => !wikiTools.includes(tool)),
    ...(wanted ? wikiTools : []),
  ];
}

/** Whether `config` holds the global tools for `wanted` (undefined: not managed). */
export const wikiApplied = (config, wanted) =>
  wikiAllow(config?.tools?.allow, wanted) === null;

/**
 * A start's configuration with the plugin and the global tools while `wanted`;
 * without, nothing is written, so the configuration is the one from before.
 */
export function applyMemoryWiki(config, wanted) {
  if (!wanted) return;
  config.plugins.allow.push(wikiPlugin);
  config.plugins.entries[wikiPlugin] = { enabled: true, config: wikiConfig() };
  config.tools.allow = wikiAllow(config.tools.allow, true) ?? config.tools.allow;
}

/**
 * Whether a change of runtime options needs a Gateway restart: `profiles` (desired
 * agents or stored records, once the change is saved) keep a wiki, and the running
 * start (`running.memoryWiki`, what the supervisor recorded) did not load the plugin.
 * plugins.allow is read only at a start. Switching the last wiki off never needs one:
 * the tools leave the lists live, and the next start leaves the plugin out.
 */
export const optionsRestart = (profiles, running) =>
  hostWiki(profiles) && running?.memoryWiki !== true;
