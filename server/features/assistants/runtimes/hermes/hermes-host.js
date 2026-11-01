import { HermesSupervisor } from "./hermes-supervisor.js";
import { hermesLifecycle } from "./hermes-lifecycle.js";
import { hermesConnectionHost } from "./hermes-connection.js";

/**
 * The host sub-port (../agent-runtime.js) of one Hermes agent over its supervised
 * process set (hermes-supervisor.js). `ready()` and `status()` answer synchronously;
 * start, stop and restart return the supervisor's promises; install, update,
 * rollback and restart reasons come from hermes-lifecycle.js. A connection is the
 * JSON-RPC client of one start (hermes-connection.js): a restart replaces it, so a
 * handle from before an await tells whether one came between, and the sessions,
 * events and approvals sub-ports bound to it (`on(connection)`) reject afterwards.
 */
export function createHermesHost(supervisor) {
  const connection = hermesConnectionHost(supervisor);
  return {
    ...connection,
    ready: () => supervisor.status().availability === "ready" && connection.ready(),
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
    ...hermesLifecycle(supervisor),
  };
}

/**
 * A Hermes agent's host: its supervisor (options as HermesSupervisor: `dataDir`,
 * `agentId`, `pathPrepend`, `extra`, `prepare`, …) and the host sub-port over it.
 */
export function createHermesAgentHost(options) {
  const supervisor = new HermesSupervisor(options);
  return { supervisor, host: createHermesHost(supervisor) };
}
