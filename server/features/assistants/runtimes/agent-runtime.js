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
 *   - connection(): an opaque handle of the current connection, null without one; the
 *     same value until the runtime replaces it, so a caller compares the handle from
 *     before an await with the one after it to learn whether a restart came between.
 *   - status(): `{ availability, sync, version, diagnostic }`, availability one of
 *     HOST_AVAILABILITY; version(): the running version or null.
 *   - subscribe(listener): calls `listener(status)` on each change; returns unsubscribe.
 *   - start(), stop(), restart(): promises that settle once the host got there.
 * - sessions: create, send, abort, wait, describe, list, delete, archive, history.
 *   Keys are the runtime's own session keys, kept by AgentPier as opaque strings.
 *   Every method returns a promise that rejects while the runtime is unreachable;
 *   answers are the runtime's own fields as callers read them.
 *   - create({ agentId, label }, { budgetMs, now, sleep }): `{ key }`, retried within
 *     the budget while the runtime proves it created nothing; notCreated(error) is
 *     true (synchronously) for such a refusal.
 *   - send({ key, turn, idempotencyKey, onLate }): `{ runId }`; `onLate(ok)` hears
 *     an acknowledgement that arrived after the call timed out.
 *   - abort({ key, runId }); wait({ runId, waitMs, timeoutMs }): the run's outcome
 *     (`status`, `stopReason`, …) after waiting up to `waitMs` for it.
 *   - describe({ key }): `{ session }`; get({ key, limit, timeoutMs }): `{ messages }`;
 *     list({ agentId, label }): the agent's sessions with that label (`[{ key }]`).
 *   - delete({ key, deleteTranscript }); compact({ key, timeoutMs }).
 *   - keepOpen({ key }): "reopened", "pinned", "open" or "missing"; the runtime's own
 *     maintenance never archives the session then. reopenRefused({ key, error }):
 *     whether a refused turn may go again because its archived session reopened.
 *   - subscribeMessages({ key }): the session's messages reach this connection.
 *   - history({ sessionKey, limit, offset, messageId, maxChars }): `{ messages,
 *     sessionInfo, hasMore, sessionId }`.
 *   - downloadArtifact({ sessionKey, artifactId, maxBytes, timeoutMs }): `{ body }`;
 *     an error with `artifactRefusal` ("gone", "location", "size") never changes on
 *     a retry.
 *   - on(connection): the same methods (without `on`) bound to a handle of
 *     host.connection(): while it is current they act as above; once the runtime
 *     replaced that connection they reject (code "UNAVAILABLE", status 503) and the
 *     new connection receives nothing. A caller that captured the connection before
 *     an await uses this view for the calls after it.
 * - events: normalized run events
 *   - subscribe(listener): `listener(event)` for each event of the current connection;
 *     returns unsubscribe (a no-op without a connection). Once the host is ready
 *     again callers subscribe anew. `event` is `{ kind, sessionKey, runId, reason,
 *     event, payload }`: `kind` one of RUN_EVENT_KINDS, `reason` why a run failed
 *     (`"timeout"`) or null, and `event`/`payload` the runtime's own frame name and
 *     payload, which the reply text, tool steps and approvals are still read from.
 * - agents: the runtime-side agent. Its async methods reject while the runtime is
 *   unreachable; answers are the runtime's own fields.
 *   - list(): `{ agents: [{ id, … }] }`.
 *   - create({ name, workspace, model }): `{ agentId }`; update({ agentId, name,
 *     model }); delete({ agentId, deleteFiles }). Each is a configuration write: it
 *     waits for settled() and runs after every earlier write of the connection.
 *   - waitListed({ agentId, timeoutMs, … }): resolves once list() names the agent; a
 *     new agent appears only after the runtime reloaded (problem agentLoading).
 *   - settled(): resolves, never rejects, once the runtime admitted the agents it
 *     prepares in the background; admitted(): once each was admitted or refused,
 *     true when there were any.
 *   - degraded(): synchronously, the runtime agent ids this connection refused;
 *     noteRefusal({ error }): records the admission refusal a call reported and
 *     returns it, or null.
 *   - on(connection): these methods bound to a connection, as sessions.on.
 * - agentFiles: instructions, memory and workspace files
 *   - get({ agentId, name }): `{ file: { content, hash, missing } }`.
 *   - set({ agentId, name, content, expectedHash, expectedMissing }): writes only
 *     over the expected hash (or absence) given.
 *   - searchMemory({ agentId, query, maxResults }): `{ ok, output: { details:
 *     { results } } }`.
 *   - on(connection), as sessions.on.
 * - config: apply the compiled desired state; whether a restart is needed
 *   - get(): `{ config, hash }`, the running configuration and its hash.
 *   - lookup({ path }): the schema entry, `reloadKind` "hot", "none" or "restart"
 *     telling whether a change there needs a restart.
 *   - patch({ build, maxWaitMs, wait, now }): `build(config)` returns `{ patch,
 *     replacePaths }` or null; applied over the hash it was computed from, after
 *     every earlier write, waiting out a rate limit within `maxWaitMs` (problem
 *     configBusy) and failing with conflict (409) when another write came between.
 *     Resolves to the `{ config, hash }` it was built from, or null without change.
 *   - watchAdoption({ timeoutMs, warn }): synchronously `{ watching, mark(),
 *     settle(baseHash, writtenHash), close() }`: settle resolves once the runtime
 *     runs the written configuration, or after the timeout.
 *   - on(connection), as sessions.on.
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

// The kinds of run events (events.subscribe). Approvals pass through; "progress" is any
// other frame of a run (a sign of life), "other" a frame of no run.
export const RUN_EVENT_KINDS = Object.freeze([
  "started",
  "text",
  "tool",
  "progress",
  "finished",
  "aborted",
  "failed",
  "approval.requested",
  "approval.resolved",
  "other",
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
