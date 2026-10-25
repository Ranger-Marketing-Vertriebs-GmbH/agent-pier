import { AgentHooks } from "./agent-hooks.js";
import { hookAddresses } from "./agent-hook-addresses.js";
import { NativeHeartbeats } from "./native-heartbeats.js";

/**
 * What wakes an agent besides the owner's turns, reminders and routines: check-ins,
 * reached as `reminders.heartbeats` (they share the reminder webhook), and incoming
 * hooks, reached as `routines.hooks`. A hook's addresses follow the configuration
 * the server runs with (Tailscale Serve, network mode) on every read.
 */
export function attachWakeups({ reminders, routines, host }) {
  new NativeHeartbeats({ reminders, notifications: host.notifications });
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
