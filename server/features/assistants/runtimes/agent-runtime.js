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
 *   - connected(connection): synchronously, whether that connection still takes
 *     calls, current or not; onDisconnect(connection, listener): `listener()` once
 *     when it drops; returns unsubscribe.
 *   - status(): `{ availability, sync, version, diagnostic }`, availability one of
 *     HOST_AVAILABILITY; version(): the running version or null.
 *   - subscribe(listener): calls `listener(status)` on each change; returns unsubscribe.
 *   - start(), stop(), restart(): promises that settle once the host got there;
 *     assertStopped(): rejects while a process of the host still runs.
 *   Install, update and rollback serve AgentPier's update journal
 *   (runtime-updates.js), which owns the selection (`runtime.json`), the staged
 *   candidate, maintenance and the snapshot; install records are opaque objects with
 *   at least `version` and `nodeVersion`.
 *   - install({ dataDir }): installs the version this AgentPier ships beside the
 *     selected one; resolves its record. sameInstall(a, b): whether two records name
 *     the same installation.
 *   - target(): `{ version, nodeVersion }` this AgentPier ships; current(record):
 *     whether a record is that version (install status: false means an update is
 *     due). stageUpdate({ dataDir }): after an AgentPier update, installs the shipped
 *     version in the background when it is due; the job, or null.
 *   - migrate(paths, record, { onSpawn }): applies an update to the stopped state
 *     (`paths`: runtime-paths.js); `onSpawn(handle)` hears a migration process
 *     before it is awaited, so a rollback after a crash can stop it.
 *   - stopMigration(handle): stops such a process before a rollback restores the
 *     snapshot; clearMigration(paths): removes what a migration left beside it.
 *   Restart reasons: AgentPier records why a saved change waits for a restart
 *   (pending-restart.js); the host tells whether and when one is needed.
 *   - restartNeeded(): synchronously, whether a change the running host cannot load
 *     needs a restart now; false while stopped, as the next start loads it.
 *   - generation(): synchronously, an id of the start that loaded the running
 *     configuration, or null; a start of another generation loaded every change
 *     saved before it.
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
 *   Every message get and history answer carries, beside the runtime's own fields,
 *   its normalized `entry`: `{ id, role, text, timestamp, runId, turnKey, internal,
 *   compaction }`. `id` is the runtime's stable message id or null (callers then
 *   derive one); `role` the runtime's role ("user", "assistant", "system", …); `text`
 *   its text blocks joined; `timestamp` milliseconds, 0 when unknown; `runId` the run
 *   that wrote it or null; `turnKey` the run id AgentPier sent the turn with (the
 *   attempt id) when the runtime keeps it on the turn's user message, else null;
 *   `internal` true for a user turn the runtime made itself, never the owner's words;
 *   `compaction` null, or `{ id, tokensBefore, tokensAfter }` for a compaction marker.
 *   - downloadArtifact({ sessionKey, artifactId, maxBytes, timeoutMs }): `{ body }`;
 *     an error with `artifactRefusal` ("gone", "location", "size") never changes on
 *     a retry.
 *   - backgroundRunning({ key }): whether the session still runs background work.
 *   - title({ agentId, message, reply }): `{ title }`, a chat title the agent's own
 *     model proposes from a message and its reply, outside any session.
 *   - reviewMemory({ agentId, instructions, input, maxTokens = 4000 }): `{ text }`,
 *     one answer of the agent's own (just switched) model to `instructions` as the
 *     system prompt and `input` as the only user message, outside any session and
 *     chat history, with no tools (memory-review.js, and Hermes's nightly dream,
 *     hermes-dream.js). `maxTokens` bounds the answer; OpenClaw ignores it.
 *   - on(connection): the same methods (without `on`) bound to a handle of
 *     host.connection(): while it is current they act as above; once the runtime
 *     replaced that connection they reject (code "UNAVAILABLE", status 503) and the
 *     new connection receives nothing. A caller that captured the connection before
 *     an await uses this view for the calls after it.
 * - events: normalized run events
 *   - subscribe(listener): `listener(event)` for each event of the current connection;
 *     returns unsubscribe (a no-op without a connection). Once the host is ready
 *     again callers subscribe anew. `event` is `{ kind, sessionKey, runId, reason,
 *     reply, step, event, payload }`: `kind` one of RUN_EVENT_KINDS, `reason` why a
 *     run failed (`"timeout"`) or null, and `event`/`payload` the runtime's own frame
 *     name and payload (raw readers that remain runtime-specific).
 *   - reply: null, or `{ text, delta, replace }` for an event carrying reply text:
 *     `text` the whole reply so far when the event carries it (a snapshot), else
 *     undefined; `delta` the appended text, else undefined; `replace` true when
 *     `delta` is the whole text instead (chat-stream.js nextChatText).
 *   - step: null, or the run's activity the event shows (run-steps.js):
 *     `{ type: "tool", id, name, title, phase, failed }` (`phase` "start", "update"
 *     or "end"; `title` a short summary the runtime gives of the call, or null;
 *     `failed` whether an ended call failed), `{ type: "thinking" }`,
 *     `{ type: "writing" }`, `{ type: "status", phase, attempt, of, reason }`
 *     (`phase` "retrying" with its attempt of `of` and why, or "starting_model"),
 *     `{ type: "lifecycle", phase }` ("start", "model", "waiting-approval" while an
 *     approval of the run waits, "approval-resolved") and `{ type: "compaction",
 *     phase }` ("start", "end").
 *   - Approvals: an "approval.requested" event's payload is the normalized request
 *     `{ id, request: { command, cwd, agentId, sessionKey, runId, allowedDecisions,
 *     warningText? }, createdAtMs, expiresAtMs }` (`cwd` the folder the command runs
 *     in or null, `allowedDecisions` among "allow-once", "allow-session",
 *     "allow-always" and "deny"; runtime-specific fields ride along); approvals.list
 *     answers the same items. "approval.resolved" names `{ id, decision, sessionKey,
 *     runId, … }`.
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
 *     returns it, or null; admitting(refusal): synchronously, whether such a refusal
 *     only says the runtime still admits that agent (it may run once admitted).
 *   - on(connection): these methods bound to a connection, as sessions.on.
 * - agentFiles: instructions, memory and workspace files
 *   - get({ agentId, name }): `{ file: { content, hash, missing } }`.
 *   - set({ agentId, name, content, expectedHash, expectedMissing }): writes only
 *     over the expected hash (or absence) given.
 *   - searchMemory({ agentId, query, maxResults }): `{ ok, output: { details:
 *     { results } } }`.
 *   - on(connection), as sessions.on.
 * - config: apply the compiled desired state; whether a restart is needed.
 *   The desired state is AgentPier's, runtime-neutral (ADR 0006 decision 3), built
 *   by agent-desired-state.js from AgentPier's stores and never in a runtime's terms.
 *   `desiredState(inputs)` is `{ agents, host }`, frozen:
 *   - agents: one desiredAgent per agent: `{ id, runtimeAgentId, name, archived,
 *     eligible` (its own settings apply), `inherits` (a temporary member running on
 *     its lead's grants), `locked` (a user agent under the hard lock), `team:
 *     { memberOf, permanent }`, `tools` (grants in offer order, each `{ tools,
 *     needs }` or `{ mcp: true, needs }` for its MCP servers' tools; `needs` of
 *     "teams", "native", "guard" and `available:<capability>`, resolved by
 *     native-capabilities.js grantedTools), `shell: { level, pathPrepend }` (level
 *     "off", "approval" or "full"; the folders its PATH starts with), `memory`,
 *     `skills: { assigned, compiled }` (switched on; compiled with the built-ins),
 *     `mcp: { eligible, servers }` (bound server ids), `web` (web capability on or
 *     released, by key), `browser: { wanted, visible, profile }`, `channels:
 *     { telegram: { eligible } }` (may own a bot for other people), `ssh` (holds an
 *     SSH grant) }`, and for a live apply `instructions` (its AGENTS.md, which
 *     agentFiles writes) and `model: { ref, providerId, provider, agentRuntime }`.
 *   - host: `{ team: { plugin: { directory, connection } | null, native,
 *     maxConcurrent }, dreaming, webTools, mcp` (the MCP store's servers, secrets,
 *     redirect URL and placeholder root; bindings are the agents'), `telegram` (the
 *     bots and the speech key) `}`.
 *   Runtime-only settings (OpenClaw's advanced settings, locked core paths, plugin
 *   entries, skill shadows) stay inside the adapter.
 *   - compiler: synchronously, the runtime's configuration compiler, the same object
 *     in every view and the one runtime-for.js `compilerFor(agent)` returns without a
 *     host. Pure: it turns AgentPier's state into the runtime's configuration, live
 *     patch builders for `patch` and the runtime's process environment, and never
 *     reaches the runtime. Feature code compiles only through it.
 *     compile({ desired, ...start }): a start's whole configuration from the desired
 *     state and the start's own facts (OpenClaw: existing, paths, port, token,
 *     overrides, runtime, tls, shell, skillShadows); the same inputs always yield
 *     the same configuration and leave `desired` as it was. `advancedSettings`
 *     (`{ list, byPath, byId, bounds, valid, auditable, validate, runtime }`) exists
 *     exactly while the `advancedSettings` capability is available.
 *   - applyModel({ desired }), apply({ desired, state }): write one agent's model
 *     connection, then its tools, shell, skills and memory, on the running
 *     configuration as `patch` does; `state()` tells what the runtime offers as the
 *     write runs (readiness, available web tools, MCP tools, skills left out).
 *     applied({ desired, config, expected }): synchronously, whether a `get()`
 *     configuration holds what the apply wrote (`expected`: the tools, skills,
 *     memory and shell it compiled).
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
 * - approvals: pending approvals, resolve, history, allowlist. Requests and their end
 *   arrive as run events (events.subscribe, "approval.requested"/"approval.resolved").
 *   Async methods reject while the runtime is unreachable; answers are the runtime's.
 *   - list(): the pending requests, `[{ id, request, … }]`.
 *   - resolve({ id, decision }): "allow-once", "allow-always" or "deny".
 *   - history(): `{ items: [{ id, status, decision }] }`, how requests ended.
 *   - ask({ sessionKey, command, description }), optional (Hermes): raises a request
 *     for a run the runtime asks nobody in (a routine run) and resolves with the
 *     owner's decision, or null once it expired.
 *   - readAllowlist(): `{ file, hash }`, the allowlist file with entries per runtime
 *     agent id; writeAllowlist({ baseHash, file }) replaces it over that hash, and
 *     staleAllowlist(error) tells (synchronously) a refusal a fresh read fixes.
 *   - allowAlwaysPlan(payload, { pathDirs, wrapperDirs }): synchronously, what
 *     "Always allow" writes for a request the runtime withheld it from:
 *     `{ kind: "paths", paths, writable }` or `{ kind: "once", reason, program }`.
 *   - questions(), answer({ id, answer }): only on a runtime whose agent asks the
 *     person in the chat (Hermes's clarify tool, hermes/hermes-questions.js): the
 *     waiting questions and the answer, a choice's label or free text. They arrive
 *     as run events of kind "other" (events "question.requested" and
 *     "question.resolved"); a runtime without them never sends either.
 *   - on(connection), as sessions.on.
 * - routines: add, update, remove, run, list runs. Routines are AgentPier's own model
 *   (../routine-definition.js: schedule, prompt, target, delivery, marker, …), which
 *   the adapter translates into its scheduler's jobs and back. Async methods reject
 *   while the runtime is unreachable.
 *   - list({ agentId }): every routine of the agent (of every agent without one),
 *     disabled ones included; rejects (unavailable, 503) on a listing it cannot page.
 *   - add({ routine }): the created routine; update({ id, patch }): the routine
 *     after it, `patch` naming the fields that change; remove({ id }).
 *   - run({ id, force }): `{ queued, refused }`, whether the run was queued or the
 *     runtime refused it; `force` runs a disabled routine or one not due.
 *   - runs({ id, limit }): `{ entries }`, the routine's recent run records.
 *   - status(): `{ enabled }`, whether the scheduler runs routines at all.
 *   - runOf(sessionKey): synchronously, the routine run a runtime session key
 *     belongs to (`{ agentId, routineId, runId, routineSession }`), or null.
 *   - on(connection), as sessions.on.
 * - skills: per-agent skill status and eligibility
 *   - status({ agentId }): `{ skills: [{ name, source, eligible, … }] }` for the
 *     agent's workspace, or the bundled and host-wide skills without one; rejects
 *     while unreachable. unknownAgent(error): synchronously, whether the runtime
 *     refused it for an agent it has not created yet. An entry may name its
 *     `origin`: "bundled", "catalog" (AgentPier's catalog copy), "builtIn"
 *     (AgentPier's own, built-in-skills.js) or "local" (a skill the agent wrote or
 *     installed in the runtime itself); without one (OpenClaw)
 *     agent-skills.js reads the runtime's `source`.
 *   - on(connection), as sessions.on.
 * - browser: profiles, live view, input, takeover
 *   - request({ method, path, query, body, timeoutMs }): one call of the runtime's
 *     browser control API (the profile in `query`), answered with its body.
 *   - openStream({ path }): synchronously, the live-view socket a screencast ticket
 *     names; throws for a path off the runtime's origin.
 *   - on(connection), as sessions.on.
 * - models: catalog, probe, login, logout, status. Account sign-ins are host-wide.
 *   Async methods reject while unreachable; answers are the runtime's.
 *   - catalog({ provider, refresh, timeoutMs }): the provider's model list.
 *   - status({ timeoutMs }): `{ providers: [{ provider, profiles }] }`.
 *   - probe({ provider, profileId, probeTimeoutMs, timeoutMs }): `{ status }`.
 *   - logout({ provider, profileIds, timeoutMs }).
 *   - login({ sessionId, authChoice, timeoutMs }) starts a sign-in wizard;
 *     loginStep({ sessionId, answer, timeoutMs }) answers its step and resolves the
 *     next (`{ done, status, step }`); cancelLogin({ sessionId, timeoutMs }).
 *   - writeAccess({ profileId, credential }), removeAccess({ profileId }): an
 *     AgentPier-held ChatGPT login as the runtime's own access-only profile (no
 *     refresh token), written while the runtime runs or not; `{ reloaded }`.
 *   - readStored({ profileId }): the runtime's own stored credential of a profile,
 *     or null; takeStored({ profileId }) reads it and drops its refresh token in
 *     one step, for the one move of a login it holds to AgentPier.
 *   - on(connection), as sessions.on.
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

// The availability states a runtime host reports (openclaw/runtime-supervisor.js).
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

// One capability per sub-port, and finer ones as ports grow: `advancedSettings`, the
// owner's overrides of runtime settings beyond AgentPier's model (config.compiler
// `advancedSettings`; OpenClaw has them, a runtime without reports it unavailable);
// `everyCommandApproval`, a shell level beside "approval" on which every command asks
// the owner (Hermes, whose "approval" asks only for dangerous commands; OpenClaw's
// "approval" already asks for every command, so it reports the option unavailable);
// `channelBots`, an agent's own Telegram bot for other people, which the runtime runs
// itself (OpenClaw's Telegram channel), beside the owner's chat AgentPier's channel
// layer serves for every runtime (`channels`).
export const RUNTIME_CAPABILITIES = Object.freeze([
  ...RUNTIME_PORTS,
  "advancedSettings",
  "everyCommandApproval",
  "channelBots",
]);

// The runtime of an agent that records none: every agent from before the field, and a
// new agent created without a choice (ADR 0006, decision 1).
export const DEFAULT_RUNTIME = "openclaw";

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
