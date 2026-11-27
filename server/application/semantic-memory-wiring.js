import { withSemanticMemory } from "../features/assistants/agent-desired-state.js";
import { SemanticMemory } from "../features/assistants/runtimes/openclaw/semantic-memory.js";

/**
 * The owner's semantic memory search (runtimes/openclaw/semantic-memory.js) on the
 * connected assistant graph:
 * - its switch restarts the Gateway like the owner's "Restart now" (running agent
 *   work is interrupted; never an account sign-in or an executing workflow);
 * - every Gateway start compiles local embeddings only while the setting is on and
 *   usable, and rebuilds the agents' memory indexes before the spawn whenever they
 *   were built for the other search;
 * - every change of its state, and of the Gateway's own, signals the live topic
 *   `runtime.semantic-memory` (`live` answers the hub, read at each change).
 */
export function connectSemanticMemory(graph, live = () => null) {
  const { assistantRuntime: runtime, assistantProviderSynchronization } = graph;
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
  return memory;
}
