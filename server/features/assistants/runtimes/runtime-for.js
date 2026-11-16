import { assistantProblem } from "../assistant-validation.js";
import { DEFAULT_RUNTIME, RUNTIME_CAPABILITIES, unavailable } from "./agent-runtime.js";
import { DEFAULT_TRAITS } from "./runtime-traits.js";
import { RUNTIME_IDS, runtimeIdOf, traitOf } from "./runtime-descriptors.js";
import { openClawDescriptor } from "./openclaw/descriptor.js";
import { hermesDescriptor } from "./hermes/descriptor.js";
import { createOpenClawRuntime } from "./openclaw/openclaw-runtime.js";
import { openClawCompiler } from "./openclaw/openclaw-compiler.js";
import { sharedAgentAdapter } from "./openclaw/shared-prompts.js";
import { cronRunOf } from "./openclaw/openclaw-routine-jobs.js";
import { openClawAdvanced } from "./openclaw/openclaw-advanced.js";
import { openClawMemory } from "./openclaw/openclaw-memory.js";
import { hermesCompiler } from "./hermes/hermes-compiler.js";
import { HermesFleet } from "./hermes/hermes-fleet.js";
import { storedIdOf } from "./hermes/hermes-run-state.js";
import { hermesCronRunOf } from "./hermes/hermes-routine-jobs.js";
import { hermesAdvanced } from "./hermes/hermes-advanced.js";
import { hermesMemory } from "./hermes/hermes-memory.js";

// The runtimes this AgentPier ships, by the id agents record (`agent.runtime`). Each
// names its product, resolves an agent's adapter behind the host it runs on, and
// brings its pure configuration compiler and the routine-run reader of its session
// keys. OpenClaw: one adapter over the OpenClaw supervisor that every OpenClaw agent
// shares. Hermes Agent: one process set per agent (ADR 0006 decision 4), kept by the
// Hermes fleet attached to that supervisor as its agent hosts (attachAgentHosts); its
// routines run on each agent's gateway cron, their runs in
// `agent:<agent>:hermes:cron:<job>:<id>`.
// What each states about itself (its name, its traits) is its descriptor
// (docs/adr/0007-runtime-descriptor.md). `advanced` makes the port through which its
// host takes the advanced settings for all agents (advancedRuntimes); `memory` is how
// it writes an agent's memory files (memoryFor). A runtime with a host per agent
// (trait `host.process: "perAgent"`) also brings `idleHosts`, the agent hosts of a
// supervisor none were attached to, and `unavailable`, the translated refusal for an
// agent that cannot run on it now.
const registry = Object.freeze({
  [openClawDescriptor.id]: Object.freeze({
    descriptor: openClawDescriptor,
    resolve: (supervisor, agent) => {
      const adapter = openClawAdapter(supervisor);
      // An agent shared with users sends no prompt that loads a local image by path.
      return agent?.userAccess?.mode === "shared" ? sharedAgentAdapter(adapter) : adapter;
    },
    compiler: openClawCompiler,
    memory: openClawMemory,
    runOf: cronRunOf,
    advanced: (supervisor) =>
      openClawAdvanced(supervisor, () => openClawAdapter(supervisor)),
  }),
  [hermesDescriptor.id]: Object.freeze({
    descriptor: hermesDescriptor,
    resolve: (supervisor, agent) =>
      hostsOf(supervisor, hermesDescriptor.id).runtimeOf(agent),
    compiler: hermesCompiler,
    memory: hermesMemory,
    runOf: hermesCronRunOf,
    advanced: (supervisor) =>
      hermesAdvanced({
        fleet: () => hostsOf(supervisor, hermesDescriptor.id),
        available: () => !!attachedHosts(supervisor, hermesDescriptor.id)?.available(),
      }),
    // A fleet that never starts: its agents stay unavailable.
    idleHosts: () => new HermesFleet({ dataDir: null }),
    unavailable: "hermesUnavailable",
  }),
});

// The one OpenClaw adapter of `supervisor`, made at its first use.
function openClawAdapter(supervisor) {
  let adapter = adapters.get(supervisor);
  if (!adapter) adapters.set(supervisor, (adapter = createOpenClawRuntime(supervisor)));
  return adapter;
}

/**
 * A frame of the shared host's own event hub (its `agent` payloads) as a normalized
 * run event, for readers of that hub such as agent-hook-runs.js.
 */
export { openClawRunEvent as sharedHostFrameEvent } from "./openclaw/openclaw-events.js";

// The ids agents may record, the id an agent records and its runtime's traits need
// no adapter (runtime-descriptors.js); they are part of this module's interface too.
export { RUNTIME_IDS, runtimeIdOf, traitOf };

// The advanced settings for all agents (advanced-config.js): AgentPier's shared ones,
// and what a runtime describes of its own.
export { sharedSetting, sharedSettings, validSharedValue } from "./shared-settings.js";
export {
  RuntimeSettingStore,
  hostFields,
  ownSettings,
  storedSettings,
} from "./runtime-settings.js";
export { validFieldValue } from "./runtime-surfaces.js";

// One OpenClaw adapter per supervisor, so every caller of one host shares it.
const adapters = new WeakMap();
// The agent hosts of each supervisor, by runtime id: what a runtime with a host per
// agent keeps its agents' hosts in (Hermes: its fleet, hermes/hermes-fleet.js). A
// supervisor without them (a test double, a setup without that runtime) gets idle
// ones at the first use (the registry's `idleHosts`).
const hostSets = new WeakMap();
// The runtimes with a host per agent, in registry order.
const perAgentIds = RUNTIME_IDS.filter(
  (id) => registry[id].descriptor.traits.host.process === "perAgent",
);
const usable = (supervisor) => !!supervisor && typeof supervisor === "object";

/**
 * Attaches the agent hosts of runtime `id` that its wiring built
 * (runtime-wiring.js wireAgentHosts) to the `supervisor` every caller passes, so
 * runtimeFor resolves that runtime's agents through them. Returns the hosts.
 */
export function attachAgentHosts(supervisor, id, hosts) {
  let attached = hostSets.get(supervisor);
  if (!attached) hostSets.set(supervisor, (attached = new Map()));
  attached.set(assertRuntime(id), hosts);
  return hosts;
}

// The agent hosts of runtime `id` attached to `supervisor` or made idle for it
// earlier; undefined before either, and without a supervisor.
const attachedHosts = (supervisor, id) =>
  usable(supervisor) ? hostSets.get(supervisor)?.get(id) : undefined;

// The agent hosts of per-agent runtime `id` behind `supervisor`, idle ones when
// none were attached.
const hostsOf = (supervisor, id) =>
  attachedHosts(supervisor, id) ??
  attachAgentHosts(supervisor, id, registry[id].idleHosts());

/**
 * The agent hosts that hold the host of `agent` behind `supervisor`: for an agent
 * of a runtime with a host per agent the object that starts, applies, stops and
 * removes each agent's host (`start`, `apply`, `stop`, `remove`, `list`,
 * `on("status")`); null for an agent on the shared host and without a supervisor.
 */
export const agentHosts = (supervisor, agent) =>
  usable(supervisor) && ownProcess(agent)
    ? hostsOf(supervisor, runtimeIdOf(agent))
    : null;

/** The agent hosts of every runtime with a host per agent behind `supervisor`. */
export const agentHostSets = (supervisor) =>
  perAgentIds.map((id) => hostsOf(supervisor, id));

/**
 * Whether an agent may be created and run on the runtime of `agent` now: always on
 * the built-in shared host (its own start decides when it takes calls, hostReady);
 * on a runtime with a host per agent while that runtime is switched on and installed
 * (its agent hosts' `available()`). False for such an agent without a supervisor.
 */
export const runtimeReady = (supervisor, agent) =>
  !ownProcess(agent) || !!attachedHosts(supervisor, runtimeIdOf(agent))?.available();

/**
 * Refuses (409) an agent whose runtime cannot run it now (runtimeReady), with that
 * runtime's own translated refusal (Hermes: `hermesUnavailable`).
 */
export function assertRuntimeReady(supervisor, agent) {
  if (!runtimeReady(supervisor, agent))
    throw assistantProblem(registry[runtimeIdOf(agent)].unavailable, 409);
}

/**
 * The agents of `profiles` the built-in shared host runs: those recording the
 * default runtime. An agent of a runtime with hosts of its own, or of a runtime this
 * AgentPier lacks, is never compiled into it.
 */
export const sharedHostAgents = (profiles) =>
  profiles.filter((profile) => runtimeIdOf(profile) === DEFAULT_RUNTIME);

/**
 * Whether the runtime of `agent` keeps an exec allowlist AgentPier reads and writes
 * through its approvals sub-port (OpenClaw's). Hermes keeps none AgentPier may write:
 * its "Always allow" is the exact command AgentPier remembers (exec-remembered.js). A
 * runtime this AgentPier lacks is refused as in runtimeFor (409).
 */
export const keepsExecAllowlist = (agent) =>
  assertRuntime(runtimeIdOf(agent), 409) &&
  traitOf(agent, "approvals", "allowlist") === "patterns";

/** Whether this AgentPier has an adapter for runtime `id`. */
export const knownRuntime = (id) => typeof id === "string" && Object.hasOwn(registry, id);

/**
 * `id` when it names a known runtime; otherwise the translated refusal
 * `runtimeUnknown` (key "runtimeUnknown"), with `status` (400 for a request choosing
 * it, 409 for a stored agent this AgentPier cannot run).
 */
export function assertRuntime(id, status = 400) {
  if (!knownRuntime(id)) throw assistantProblem("runtimeUnknown", status, String(id));
  return id;
}

/**
 * The agent runtime port (agent-runtime.js) that runs `agent`, picked by the runtime
 * it records (runtimeIdOf). OpenClaw runs behind `supervisor`
 * (openclaw/runtime-supervisor.js). An agent recording a runtime this AgentPier lacks
 * (a backup from a newer one) is refused with `runtimeUnknown` (409).
 */
export function runtimeFor(agent, supervisor) {
  if (!supervisor || typeof supervisor !== "object")
    throw new TypeError("runtimeFor needs the runtime supervisor.");
  return registry[assertRuntime(runtimeIdOf(agent), 409)].resolve(supervisor, agent);
}

/**
 * The runtime that holds session `sessionKey`: a Hermes agent's for its keys
 * (`agent:<runtimeAgentId>:hermes:<id>`), OpenClaw's otherwise. For callers that
 * know a session but not its agent (reconciliation, aborts, history reads).
 */
export function runtimeForSession(sessionKey, supervisor) {
  const hermes = hermesSessionAgent(sessionKey);
  return hermes
    ? runtimeFor({ runtime: "hermes", runtimeAgentId: hermes }, supervisor)
    : runtimeFor(null, supervisor);
}

// The runtime agent id a Hermes session key names, or null.
function hermesSessionAgent(sessionKey) {
  const match = /^agent:([A-Za-z0-9][A-Za-z0-9_-]{0,63}):hermes:/.exec(
    typeof sessionKey === "string" ? sessionKey : "",
  );
  return match && storedIdOf(match[1], sessionKey) ? match[1] : null;
}

/**
 * Whether `sessionKey` is a session key of an agent on a host of its own (a Hermes
 * agent's, hermes/hermes-run-state.js sessionKeyOf), whatever became of the agent.
 */
export const ownHostSessionKey = (sessionKey) =>
  /^agent:[A-Za-z0-9][A-Za-z0-9_-]{0,63}:hermes:/.test(
    typeof sessionKey === "string" ? sessionKey : "",
  );

/**
 * Run events of every agent behind `supervisor` that runs on a host of its own (the
 * Hermes fleet's), subscribed once and followed across each host's restarts. The
 * shared host's own events go through `runtimeFor(null, supervisor).events`,
 * subscribed anew per connection.
 */
export const agentRuntimeEvents = (supervisor) => ({
  subscribe: (listener) => {
    const stops = agentHostSets(supervisor).map((hosts) => hosts.subscribe(listener));
    return () => stops.forEach((stop) => stop());
  },
});

/**
 * Calls `listener(runtimeAgentId, status)` at every status change of an agent's own
 * host behind `supervisor`. Returns unsubscribe.
 */
export function onAgentHostStatus(supervisor, listener) {
  const sets = agentHostSets(supervisor);
  for (const hosts of sets) hosts.on("status", listener);
  return () => sets.forEach((hosts) => hosts.off("status", listener));
}

/**
 * Calls `listener(runtimeAgentId)` whenever the own process set of an agent behind
 * `supervisor` (Hermes) became ready, a start or restart; OpenClaw's own readiness
 * reaches its callers through the supervisor. Returns unsubscribe; a no-op without a
 * supervisor.
 */
export function onAgentRuntimeReady(supervisor, listener) {
  if (!usable(supervisor)) return () => {};
  return onAgentHostStatus(
    supervisor,
    (agentId, status) => status?.availability === "ready" && listener(agentId),
  );
}

/**
 * The work folder of `agent` when it runs on its own process set (Hermes: the folder
 * its commands and file tools start in), else null: OpenClaw's workspaces are the
 * runtime paths' own.
 */
export const agentWorkspace = (supervisor, agent) =>
  agentHosts(supervisor, agent)?.workspaceOf(agent) ?? null;

/** The private folders of a Hermes agent outside its work folder (hermes-fleet.js). */
export const agentPrivateFolders = (supervisor, agent) =>
  agentHosts(supervisor, agent)?.privateFoldersOf(agent) ?? null;

/**
 * Whether `agent` runs on a host of its own rather than the shared one: its
 * runtime's trait `host.process` is `perAgent`.
 */
export const ownProcess = (agent) => traitOf(agent, "host", "process") === "perAgent";

/**
 * Whether a configuration change of `agent` can reach its runtime now: the shared
 * OpenClaw host is ready, or for a Hermes agent Hermes is available (its apply starts
 * the agent's own process set). False without a supervisor.
 */
export const runtimeAccepts = (supervisor, agent) =>
  ownProcess(agent) ? runtimeReady(supervisor, agent) : hostReady(supervisor, agent);

/**
 * What the agents list and an agent's settings show of its runtime: `{ id, name,
 * version, capabilities, surfaces }`. `version` is the running version, or null while
 * the host is stopped or unknown; `surfaces` the UI of its own the runtime registers
 * (runtime-surfaces.js). A runtime this AgentPier lacks is shown, never hidden: its
 * id as name, every capability unavailable with the reason `runtimeUnknown`, and no
 * surface.
 */
export function runtimeDetails(agent, supervisor) {
  const id = runtimeIdOf(agent);
  if (!knownRuntime(id)) {
    const missing = unavailable("runtimeUnknown");
    const capabilities = Object.fromEntries(
      RUNTIME_CAPABILITIES.map((name) => [name, { ...missing, ...DEFAULT_TRAITS[name] }]),
    );
    return { id, name: id, version: null, capabilities, surfaces: [] };
  }
  const { name, traits, surfaces } = registry[id].descriptor;
  // Without a host nothing tells what is available; the traits are known anyway.
  if (!supervisor || typeof supervisor !== "object")
    return { id, name, version: null, capabilities: traits, surfaces };
  const runtime = runtimeFor(agent, supervisor);
  let version = null;
  try {
    version = runtime.host.version() ?? null;
  } catch {
    /* A host that cannot report its status has no known version. */
  }
  return { id, name, version, capabilities: runtime.capabilities(), surfaces };
}

/**
 * The configuration compiler of the runtime that runs `agent` (runtimeIdOf): the pure
 * part of its config sub-port (agent-runtime.js `config.compiler`), the same object as
 * `runtimeFor(agent, supervisor).config.compiler`. It needs no host, so callers
 * without a supervisor (an audit record, a CLI environment) use it too; `null` means
 * DEFAULT_RUNTIME. A runtime this AgentPier lacks is refused as in runtimeFor (409).
 */
export const compilerFor = (agent) =>
  registry[assertRuntime(runtimeIdOf(agent), 409)].compiler;

/**
 * How the runtime that runs `agent` (runtimeIdOf) writes its memory files: the pure
 * part of its agentFiles sub-port (agent-runtime.js `agentFiles.memory`), the same
 * object as `runtimeFor(agent, supervisor).agentFiles.memory`. It reads only the
 * text it is given, so it needs no host. A runtime this AgentPier lacks answers the
 * default runtime's format, as its traits answer the defaults (traitOf).
 */
export const memoryFor = (agent) =>
  (registry[runtimeIdOf(agent)] ?? registry[DEFAULT_RUNTIME]).memory;

// The advanced host ports of each supervisor, by runtime id: made once, so what a
// port remembers of its host (OpenClaw's reload kinds per version) is kept.
const advancedHosts = new WeakMap();

/**
 * Every runtime this AgentPier ships as the advanced settings for all agents see it
 * (advanced-config.js), the default first: `{ id, name, shortName, process,
 * descriptor, host }`. `process` is its trait `host.process`; `descriptor` states
 * the advanced fields of its own (runtime-settings.js hostFields); `host` is the port
 * through which its host behind `supervisor` takes a setting (advanced-config.js
 * describes the port; openclaw/openclaw-advanced.js, hermes/hermes-advanced.js).
 */
export function advancedRuntimes(supervisor) {
  if (!supervisor || typeof supervisor !== "object")
    throw new TypeError("advancedRuntimes needs the runtime supervisor.");
  let hosts = advancedHosts.get(supervisor);
  if (!hosts) advancedHosts.set(supervisor, (hosts = new Map()));
  return RUNTIME_IDS.map((id) => {
    const { descriptor, advanced } = registry[id];
    if (!hosts.has(id)) hosts.set(id, advanced(supervisor));
    return Object.freeze({
      id,
      name: descriptor.name,
      shortName: descriptor.shortName,
      process: descriptor.traits.host.process,
      descriptor,
      host: hosts.get(id),
    });
  });
}

/**
 * Every runtime this AgentPier ships as runtimeDetails shows it, the default first:
 * what a new agent may choose from and how each would behave, before an agent exists.
 * Each entry adds `install` and `ready` (whether a new agent may run on it now). A
 * built-in runtime (trait `host.install`) is `{ kind: "builtin" }` and ready. An
 * optional one is `{ kind: "optional", ...state }`, the state its entry of `installs`
 * answers (`{ [runtimeId]: () => state }`, the composition root's `runtimeInstalls`),
 * ready while that is `enabled` and `installed`; without an entry it is off and not
 * installed. A runtime with a host per agent has none to ask without an agent, so it
 * answers its traits alone, and as version the installed one its state names.
 */
export const runtimeList = (supervisor, installs) =>
  RUNTIME_IDS.map((id) => {
    const { host } = registry[id].descriptor.traits;
    const shared = host.process === "shared";
    const details = runtimeDetails({ runtime: id }, shared ? supervisor : null);
    if (host.install !== "optional")
      return { ...details, install: { kind: "builtin" }, ready: true };
    const install = { kind: "optional", ...installState(installs, id) };
    return {
      ...details,
      version: shared ? details.version : (install.version ?? null),
      install,
      ready: install.enabled === true && install.installed === true,
    };
  });

// What the install source of runtime `id` answers; off and not installed without one.
function installState(installs, id) {
  const read = installs && Object.hasOwn(installs, id) ? installs[id] : null;
  const state = typeof read === "function" ? read() : null;
  return state && typeof state === "object"
    ? state
    : { enabled: false, installed: false };
}

/** A copy of the agent view `agent` with its `runtimeInfo` (runtimeDetails). */
export const withRuntime = (agent, supervisor) => ({
  ...agent,
  runtimeInfo: runtimeDetails(agent, supervisor),
});

/** A resolver `(agent) => AgentRuntime` bound to the supervisor `supervisor()` returns. */
export const runtimeResolver = (supervisor) => (agent) => runtimeFor(agent, supervisor());

/** The host sub-port of the runtime of `agent` behind `supervisor`. */
export const hostOf = (supervisor, agent) => runtimeFor(agent, supervisor).host;

/**
 * Whether the runtime host of `agent` behind `supervisor` takes calls now
 * (host.ready()); false without a supervisor, as during setup or in a closed service.
 */
export const hostReady = (supervisor, agent) =>
  !!supervisor &&
  typeof supervisor === "object" &&
  runtimeFor(agent, supervisor).host.ready();

/**
 * Whether some runtime host behind `supervisor` takes calls: the shared OpenClaw host
 * or the process set of a Hermes agent. Background passes that serve agents of every
 * runtime (the team scheduler, lead requests) run while this holds; each step checks
 * the host of its own agent (hostReady, runtimeAccepts).
 */
export const anyHostReady = (supervisor) =>
  hostReady(supervisor) ||
  (!!supervisor &&
    typeof supervisor === "object" &&
    perAgentIds.some((id) =>
      (attachedHosts(supervisor, id)?.list() || []).some(({ runtime }) =>
        runtime.host.ready(),
      ),
    ));

/**
 * The current connection of the runtime of `agent` behind `supervisor`
 * (host.connection()), or null without a supervisor. Compared across an await, it
 * tells whether the runtime was replaced meanwhile.
 */
export const hostConnection = (supervisor, agent) =>
  !!supervisor && typeof supervisor === "object"
    ? runtimeFor(agent, supervisor).host.connection()
    : null;

/**
 * The routine run a runtime session key of `agent` belongs to (routines.runOf), or
 * null. It reads only the key, so it needs no supervisor; the runtime is the one
 * `agent` records (runtimeIdOf), for a null `agent` the one the key names (a Hermes
 * key, else DEFAULT_RUNTIME), and a runtime this AgentPier lacks owns no run here.
 */
export const routineRunOf = (agent, sessionKey) => {
  // Without an agent the key tells its runtime.
  const hermes = /^agent:[^:]+:hermes:/.test(
    typeof sessionKey === "string" ? sessionKey : "",
  );
  const id = agent ? runtimeIdOf(agent) : hermes ? "hermes" : DEFAULT_RUNTIME;
  return knownRuntime(id) ? registry[id].runOf(sessionKey) : null;
};
