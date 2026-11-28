import { withSemanticMemory } from "../features/assistants/agent-desired-state.js";
import { memoryEnabled } from "../features/assistants/native-capabilities.js";
import { hostReady, runtimeFor } from "../features/assistants/runtimes/runtime-for.js";
import { runtimeIdOf } from "../features/assistants/runtimes/runtime-descriptors.js";
import { DEFAULT_RUNTIME } from "../features/assistants/runtimes/agent-runtime.js";
import { SemanticMemory } from "../features/assistants/runtimes/openclaw/semantic-memory.js";

// A query no note answers: a check search embeds it, finds nothing and so records
// no recall. An agent with notes answers it without embeddings only when they fail.
const checkQuery = "agentpier-embedding-check-7f3a91c2";
// How many agents one check asks, and how often an agent's own search starts one.
const checkAgents = 8;
export const searchCheckMs = 10 * 60000;

/**
 * The owner's semantic memory search (runtimes/openclaw/semantic-memory.js) on the
 * connected assistant graph:
 * - its switch restarts the Gateway like the owner's "Restart now" (running agent
 *   work is interrupted; never an account sign-in or an executing workflow);
 * - every Gateway start compiles local embeddings only while the setting is on and
 *   usable, and rebuilds the agents' memory indexes before the spawn whenever they
 *   were built for the other search;
 * - every change of its state, and of the Gateway's own, signals the live topic
 *   `runtime.semantic-memory` (`live` answers the hub, read at each change);
 * - it learns whether embeddings really answer from the searches themselves: every
 *   memory search AgentPier issues reports its answer (`memorySearched`), the owner
 *   opening the Runtime tab checks once per Gateway process (`opened`), and an
 *   agent's own search that ended checks at most every ten minutes
 *   (`onMemorySearch`: the embedding server runs then anyway). Nothing is timed.
 */
export function connectSemanticMemory(graph, live = () => null) {
  const {
    assistantRuntime: runtime,
    assistantProviderSynchronization,
    assistants,
  } = graph;
  const changed = () => live()?.invalidate("runtime.semantic-memory");
  const memory = new SemanticMemory({
    supervisor: runtime,
    restart: () =>
      assistantProviderSynchronization.restartGateway(() => null, { force: true }),
    changed,
  });
  // Whether it can be switched, and whether a rebuild still waits for a start,
  // follow the Gateway's own state.
  runtime.on("status", changed);
  const { teamConfiguration, beforeSpawn } = runtime;
  runtime.teamConfiguration = async (installed) =>
    withSemanticMemory(await teamConfiguration(installed), memory.compiled(installed));
  runtime.beforeSpawn = async () => {
    // With this start's openclaw.json written and no Gateway running.
    await memory.beforeSpawn();
    return beforeSpawn();
  };
  // The agents of the shared Gateway: those of the built-in runtime.
  const shared = (agent) => runtimeIdOf(agent) === DEFAULT_RUNTIME;
  // One search per agent with memory on the shared Gateway, until one answers
  // without embeddings; an agent that cannot be asked is passed over.
  const probe = async () => {
    const answers = [];
    if (!assistants?.store || !hostReady(runtime)) return answers;
    const agents = assistants.store
      .listAssistants()
      .filter((agent) => shared(agent) && !agent.archivedAt && memoryEnabled(agent));
    for (const agent of agents.slice(0, checkAgents)) {
      const result = await runtimeFor(agent, runtime)
        .agentFiles.searchMemory({
          agentId: agent.runtimeAgentId,
          query: checkQuery,
          maxResults: 1,
        })
        .catch(() => null);
      const details = result?.output?.details;
      if (details) answers.push(details);
      if (details?.provider === "none") break;
    }
    return answers;
  };
  memory.opened = () => memory.check(probe, { everyMs: Infinity });
  if (assistants) {
    assistants.memorySearched = (agent, details) => {
      if (shared(agent)) memory.observe(details);
    };
    assistants.onMemorySearch = () => memory.check(probe, { everyMs: searchCheckMs });
  }
  return memory;
}
