/**
 * The agent runtime port (docs/adr/0006-assistant-runtime-port.md). Feature code talks
 * to an `AgentRuntime` resolved per agent (runtime-for.js), never to a runtime's own
 * client. Each runtime adapter (runtimes/openclaw/, later runtimes/hermes/) implements
 * the same sub-ports; tests/helpers/runtime-port-contract.js pins what every adapter
 * must do.
 *
 * Sub-ports and their responsibility (methods are added port by port as callers move):
 * - host: install, start, stop, health, version, update, rollback, restart reasons
 *   - ready(): true while the runtime takes calls; synchronous, as callers check inline.
 *   - status(): `{ availability, sync, version, diagnostic }`, availability one of
 *     HOST_AVAILABILITY; version(): the running version or null.
 *   - subscribe(listener): calls `listener(status)` on each change; returns unsubscribe.
 *   - start(), stop(), restart(): promises that settle once the host got there.
 * - sessions: create, send, abort, wait, describe, list, delete, archive, history
 *   - create({ agentId, label }, { budgetMs, now, sleep }): resolves `{ key }` of a
 *     new native session; rejects when the runtime cannot create it.
 *   - subscribe({ key }): delivers the session's messages to AgentPier.
 * - events: normalized run events (started, text, tool step, approvals, finished)
 * - agents: the runtime-side agent (create, update, delete, list)
 * - agentFiles: instructions, memory and workspace files
 * - config: apply the compiled desired state; whether a restart is needed
 * - approvals: pending approvals, resolve, history, allowlist
 * - routines: add, update, remove, run, list runs
 * - skills: per-agent skill status and eligibility
 * - browser: profiles, live view, input, takeover
 * - models: catalog, probe, login, logout, status
 * - channels: channel status
 *   - status({ probe }): resolves `{ channelAccounts: { telegram: [account] } }`,
 *     each account `{ accountId, running, connected, lastError }`; rejects when the
 *     runtime cannot be reached.
 */
export const RUNTIME_PORTS = Object.freeze([
  "host",
  "sessions",
  "events",
  "agents",
  "agentFiles",
  "config",
  "approvals",
  "routines",
  "skills",
  "browser",
  "models",
  "channels",
]);

// The availability states a runtime host reports (runtime-supervisor.js).
export const HOST_AVAILABILITY = Object.freeze([
  "disabled",
  "installing",
  "starting",
  "ready",
  "reconnecting",
  "failed",
  "stopping",
]);

// One capability per sub-port for now; finer capabilities join as ports grow.
export const RUNTIME_CAPABILITIES = RUNTIME_PORTS;

/** A capability the runtime offers. */
export const available = () => Object.freeze({ available: true });

/**
 * A capability the runtime lacks. `reason` is a stable message id the owner sees
 * translated; a lacking capability is never silently hidden.
 */
export function unavailable(reason) {
  if (typeof reason !== "string" || !reason)
    throw new TypeError("An unavailable capability needs a reason id.");
  return Object.freeze({ available: false, reason });
}

/**
 * Builds an `AgentRuntime`: `{ id, capabilities(), host, sessions, … }`. Sub-ports
 * left out are empty; `capabilities` maps capability ids to available()/unavailable()
 * and defaults to available. The result and its sub-ports are frozen.
 */
export function defineAgentRuntime({ id, capabilities = {}, ...ports }) {
  if (typeof id !== "string" || !id) throw new TypeError("A runtime needs an id.");
  const unknown = Object.keys(ports).filter((name) => !RUNTIME_PORTS.includes(name));
  if (unknown.length) throw new TypeError(`Unknown runtime ports: ${unknown.join(", ")}`);
  const strange = Object.keys(capabilities).filter(
    (name) => !RUNTIME_CAPABILITIES.includes(name),
  );
  if (strange.length)
    throw new TypeError(`Unknown runtime capabilities: ${strange.join(", ")}`);
  const offered = Object.freeze(
    Object.fromEntries(
      RUNTIME_CAPABILITIES.map((name) => [name, capabilities[name] || available()]),
    ),
  );
  return Object.freeze({
    id,
    capabilities: () => offered,
    ...Object.fromEntries(
      RUNTIME_PORTS.map((name) => [name, Object.freeze({ ...ports[name] })]),
    ),
  });
}
