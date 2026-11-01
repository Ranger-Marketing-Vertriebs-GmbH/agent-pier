import { HermesRpcClient, hermesError } from "./hermes-rpc-client.js";
import { HermesRuns } from "./hermes-run-state.js";
import { HermesApprovalQueue } from "./hermes-approval-queue.js";
import { HermesQuestionQueue } from "./hermes-questions.js";

// One Hermes process set per agent (ADR 0006, section 4): its supervisor
// (hermes-supervisor.js) runs the messaging gateway and the RPC bridge, wraps the
// bridge's channel as a transport (hermes-transport.js rpcTransport) and keeps the
// client createHermesClient makes as `supervisor.client`, replacing it with each
// start. The sub-ports here read `supervisor.client` at each call and
// `supervisor.agentId`, the runtime agent id the gateway serves, never binding to
// one client.

const states = new WeakMap();

/**
 * A client over `transport` with what the sub-ports keep per connection: the session
 * keys and runs (hermes-run-state.js), the approvals Hermes asks for
 * (hermes-approval-queue.js) and its clarify questions (hermes-questions.js). All
 * listen from the first line on, so nothing the process sends before connect()
 * resolves is lost. `client.connect()` then waits for
 * the gateway. `workspace` is the folder the agent's commands run in, which its
 * approval requests name as `cwd`.
 */
export function createHermesClient(transport, { agentId, timeoutMs, workspace } = {}) {
  if (typeof agentId !== "string" || !agentId)
    throw new TypeError("A Hermes client needs the runtime agent id it serves.");
  const client = new HermesRpcClient(transport, { timeoutMs });
  const runs = new HermesRuns(client, { agentId });
  const approvals = new HermesApprovalQueue(client, runs, { cwd: workspace });
  const questions = new HermesQuestionQueue(client, runs);
  states.set(client, Object.freeze({ agentId, runs, approvals, questions }));
  return client;
}

/** The per-connection state createHermesClient attached, or null. */
export const stateOf = (client) => (client && states.get(client)) || null;

// One opaque handle per client, as OpenClaw's adapter keeps (openclaw-runtime.js): a
// restart replaces the client, so the handle tells callers whether an await crossed
// one, and calls bound to it reach that client alone.
const connections = new WeakMap();
const clients = new WeakMap();
export function connectionOf(client) {
  if (!client || typeof client !== "object") return null;
  let connection = connections.get(client);
  if (!connection) {
    connections.set(client, (connection = Object.freeze({})));
    clients.set(connection, client);
  }
  return connection;
}
export const clientOf = (connection) =>
  (connection && typeof connection === "object" && clients.get(connection)) || null;

/**
 * The host sub-port's connection methods (agent-runtime.js) over the supervisor's
 * client: ready while the gateway takes calls; a closed client is never ready again.
 */
export function hermesConnectionHost(supervisor) {
  return {
    ready: () => !!supervisor.client?.ready,
    connection: () => connectionOf(supervisor.client),
    connected: (connection) => !!clientOf(connection)?.ready,
    onDisconnect(connection, listener) {
      const client = clientOf(connection);
      if (!client) return () => {};
      client.once("disconnected", listener);
      return () => client.off("disconnected", listener);
    },
  };
}

/**
 * A sub-port over the supervisor's current client, with `on(connection)` binding the
 * same methods to the client behind that handle: once a restart replaced it, the
 * closed client rejects every call (UNAVAILABLE, 503) and the new one receives none.
 */
export const boundPort = (over, supervisor) => ({
  ...over(() => supervisor.client),
  on: (connection) => Object.freeze(over(() => clientOf(connection))),
});

/** The client and its state when it takes calls; rejects (UNAVAILABLE) otherwise. */
export function reachable(client) {
  const state = stateOf(client);
  if (!client?.ready || !state) throw hermesError();
  return { client, ...state };
}

/**
 * The refusal of a method Hermes lacks (a capability gap): code UNSUPPORTED (501),
 * `unsupported` naming the method. It never changes on a retry.
 */
export function unsupported(method) {
  return Object.assign(Error(`Hermes does not support ${method}.`), {
    code: "UNSUPPORTED",
    status: 501,
    unsupported: method,
  });
}
