import { AgentHooks } from "./agent-hooks.js";
import { hookAddresses } from "./agent-hook-addresses.js";
import { NativeHeartbeats } from "./native-heartbeats.js";
import { onAgentRuntimeReady } from "./runtimes/runtime-for.js";
import { deletePendingSessions } from "./chat-removal.js";

/**
 * What wakes an agent besides the owner's turns, reminders and routines: check-ins,
 * reached as `reminders.heartbeats` (they share the reminder webhook), and incoming
 * hooks, reached as `routines.hooks`. Both converge again whenever a Hermes agent's
 * own process set became ready, hook runs included. A hook's addresses follow the configuration
 * the server runs with (Tailscale Serve, network mode) on every read.
 */
export function attachWakeups({ reminders, routines, host }) {
  const heartbeats = new NativeHeartbeats({
    reminders,
    notifications: host.notifications,
  });
  // A Hermes agent's own set that became ready: its check-ins and routines converge,
  // as every agent's do when OpenClaw's Gateway is ready (assistant-graph.js).
  const { assistants } = reminders;
  onAgentRuntimeReady(assistants.runtime, (runtimeAgentId) => {
    const agent = assistants.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === runtimeAgentId);
    if (!agent || assistants.maintenance) return;
    heartbeats.resync(agent.id).catch(() => {});
    routines.resync(agent.id).catch(() => {});
    // Its hook jobs and lost hook events too, whether or not OpenClaw runs.
    routines.hooks?.runs.reconcile().catch(() => {});
    // Deletes of its chats that waited for the set.
    deletePendingSessions(assistants, agent);
  });
  new AgentHooks({
    reminders,
    routines,
    notifications: host.notifications,
    addresses: (id) =>
      hookAddresses(
        {
          config: host.effectiveConfig?.() || host.config,
          networkUrls: host.networkState?.urls || [],
        },
        id,
      ),
  });
}
