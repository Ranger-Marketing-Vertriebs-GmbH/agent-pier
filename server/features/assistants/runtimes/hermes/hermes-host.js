import { HermesSupervisor } from "./hermes-supervisor.js";
import { hermesLifecycle } from "./hermes-lifecycle.js";

// One opaque handle per channel: a restart replaces the channel, so the handle tells
// callers whether an await crossed one (as openclaw-runtime.js does per client).
const handles = new WeakMap();
const transports = new WeakMap();
function handleOf(transport) {
  if (!transport) return null;
  let handle = handles.get(transport);
  if (!handle) {
    handles.set(transport, (handle = Object.freeze({})));
    transports.set(handle, transport);
  }
  return handle;
}

/** The channel (hermes-transport.js) behind a handle of host.connection(), or null. */
export const transportOf = (connection) =>
  (connection && typeof connection === "object" && transports.get(connection)) || null;

/**
 * The host sub-port (../agent-runtime.js) of one Hermes agent over its supervised
 * process set (hermes-supervisor.js). `ready()` and `status()` answer synchronously;
 * start, stop and restart return the supervisor's promises; install, update,
 * rollback and restart reasons come from hermes-lifecycle.js. `transport()` is the
 * current JSON-RPC channel for the Hermes sessions, events and approvals sub-ports.
 * Not registered in runtime-for.js yet.
 */
export function createHermesHost(supervisor) {
  return {
    ready: () => supervisor.status().availability === "ready",
    connection: () => handleOf(supervisor.transport),
    connected: (connection) => {
      const transport = transportOf(connection);
      return !!transport && !transport.closed;
    },
    onDisconnect(connection, listener) {
      const transport = transportOf(connection);
      return transport ? transport.onClose(listener) : () => {};
    },
    status: () => supervisor.status(),
    version: () => supervisor.status().version ?? null,
    subscribe(listener) {
      supervisor.on("status", listener);
      return () => supervisor.off("status", listener);
    },
    start: (options) => supervisor.start(options),
    stop: (options) => supervisor.stop(options),
    restart: () => supervisor.restart(),
    // Hermes's gateway listens on loopback for its own clients only; AgentPier
    // reaches it through the bridge and opens no port of its own for the agent.
    loopbackPorts: () => [],
    transport: () => supervisor.transport,
    ...hermesLifecycle(supervisor),
  };
}

/**
 * A Hermes agent's host: its supervisor (options as HermesSupervisor: `dataDir`,
 * `agentId`, `pathPrepend`, `extra`, …) and the host sub-port over it.
 */
export function createHermesAgentHost(options) {
  const supervisor = new HermesSupervisor(options);
  return { supervisor, host: createHermesHost(supervisor) };
}
