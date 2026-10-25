import { setTimeout as delay } from "node:timers/promises";

// OpenClaw 2026.10.7 inspects and prepares agent databases it cannot trust at once
// (after an unclean stop: a stale lease) in the background once it listens. Until an
// agent is admitted, agents.list reports it `status: "degraded"` with an admission
// refusal coded `agent-database-inspection-pending`. A runtime configuration change
// meanwhile (config.patch, agents.create, agents.update) supersedes that preparation,
// and OpenClaw never retries it: the agent stays refused
// (`agent-database-inspection-failed`) for the Gateway's lifetime, and its sessions
// answer UNAVAILABLE (AGENTPIER-238). Every AgentPier configuration write therefore
// waits here first, once per connection, until no agent is pending; writes that
// arrive meanwhile wait for the same answer and then go out one after the other
// (live-patch.js). The wait ends after `admissionWaitMs` without progress: each agent
// admitted meanwhile starts it again, so a slow host with many agents is never cut
// short. The roster is still watched after that, so agents refused later are known
// too. The agents refused are degraded until the Gateway restarts.
export const admissionWaitMs = 120000;
export const pendingAdmission = "agent-database-inspection-pending";
const admissionCode = /^agent-database-/;
const firstPollMs = 250;
const lastPollMs = 2000;
// Watching ends at the latest after this long (a preparation OpenClaw never ends).
const watchMs = 30 * 60000;
// Per Gateway client: the shared wait, its end and the agents refused.
const admissions = new WeakMap();
const starting = Symbol("starting");

function stateOf(client) {
  let state = admissions.get(client);
  if (!state) {
    state = { settled: null, done: null, degraded: new Set() };
    admissions.set(client, state);
    // A reconnect may reach a Gateway that started again in place: it asks anew.
    client.on?.("disconnected", () => {
      state.settled = state.done = null;
      state.degraded = new Set();
    });
  }
  return state;
}

// One roster read: the agents, `starting` while the Gateway cannot say yet (it
// answers UNAVAILABLE or the call timed out), or a throw when there is nothing to
// wait for (no connection, or a Gateway without this roster).
async function readRoster(client) {
  try {
    const roster = await client.call("agents.list", {});
    return Array.isArray(roster?.agents) ? roster.agents : [];
  } catch (error) {
    // Asked again while the Gateway is busy: it answered UNAVAILABLE, or the read
    // timed out. A closed connection fails the write itself instead.
    const busy = error?.answered
      ? error.code === "UNAVAILABLE"
      : error?.code === "TIMEOUT";
    if (client.ready === false || !busy) throw error;
    return starting;
  }
}

async function watch(client, state, { timeoutMs, now, sleep, warn, release }) {
  const started = now();
  let deadline = started + timeoutMs;
  let left = Infinity;
  for (let pause = firstPollMs; ; pause = Math.min(lastPollMs, pause * 2)) {
    const agents = await readRoster(client);
    if (agents !== starting) {
      const pending = agents.filter(
        (a) => a?.admissionRefusal?.code === pendingAdmission,
      );
      state.degraded = new Set([
        ...agents
          .filter(
            (a) => admissionCode.test(a?.admissionRefusal?.code) && !pending.includes(a),
          )
          .map((a) => a.id),
        // A refusal a call reported (noteRefusal) stays known.
        ...[...state.degraded].filter((id) => !agents.some((a) => a?.id === id)),
      ]);
      // Resolves whether this Gateway admitted agents in the background at all.
      if (!pending.length) return left !== Infinity;
      // Progress: every agent admitted gives the rest the whole wait again.
      if (pending.length < left) deadline = now() + timeoutMs;
      left = pending.length;
    }
    if (now() >= deadline && release()) {
      warn(`Assistant Gateway admitted no agent for ${timeoutMs} ms; writing.`);
    }
    if (now() - started >= watchMs) return true;
    await sleep(pause);
  }
}

/**
 * Resolves once the Gateway behind `client` admitted every agent it prepares in the
 * background, or after `timeoutMs` without progress. Never rejects: a failed roster
 * read is asked again by the next caller.
 */
export function settledAdmission(client, options = {}) {
  if (!client) return Promise.resolve();
  const state = stateOf(client);
  if (!state.settled) begin(client, state, options);
  return state.settled;
}

/**
 * Resolves once the roster watch of `client` ended: every agent admitted or refused
 * (or the watch gave up); the degraded agents are known then. True when the Gateway
 * admitted agents in the background, false when it had none or could not say.
 */
export function admissionDone(client) {
  if (!client) return Promise.resolve();
  const state = stateOf(client);
  if (!state.settled) begin(client, state);
  return state.done;
}

function begin(
  client,
  state,
  {
    timeoutMs = admissionWaitMs,
    now = Date.now,
    sleep = delay,
    warn = console.warn,
  } = {},
) {
  let released = false;
  let resolve;
  const settled = new Promise((r) => (resolve = r));
  const release = () => {
    if (released) return false;
    released = true;
    resolve();
    return true;
  };
  const done = watch(client, state, { timeoutMs, now, sleep, warn, release })
    .catch(() => {
      if (state.settled === settled) state.settled = state.done = null;
      return false;
    })
    .finally(release);
  state.settled = settled;
  state.done = done;
}

/** The runtime agent ids the Gateway behind `client` refused to admit. */
export function degradedAgents(client) {
  return (client && admissions.get(client)?.degraded) || new Set();
}

/** Whether the Gateway behind `client` refused to admit `runtimeAgentId`. */
export const agentDegraded = (client, runtimeAgentId) =>
  degradedAgents(client).has(runtimeAgentId);

/**
 * Records a refusal a Gateway call reported (gateway-client.js `admissionRefusal`):
 * a failed admission makes its agent degraded. Returns the refusal, or null.
 */
export function noteRefusal(client, error) {
  const refusal = error?.admissionRefusal;
  if (!refusal) return null;
  if (client && refusal.code !== pendingAdmission)
    stateOf(client).degraded.add(refusal.agentId);
  return refusal;
}

/**
 * The owner's list (assistant-service.js list): an agent the running Gateway refused
 * is `degraded`, and its chats show AGENT_DEGRADED before any session fault
 * (chat-reconcile.js `sessionFailures`).
 */
export function withAdmission(service, { assistants, conversations }) {
  const refused = degradedAgents(service.runtime?.client);
  const degraded = new Set(
    assistants.filter((a) => refused.has(a.runtimeAgentId)).map((a) => a.id),
  );
  return {
    assistants: assistants.map((a) =>
      degraded.has(a.id) ? { ...a, degraded: true } : a,
    ),
    conversations: conversations.map((c) => {
      const diagnostic = degraded.has(c.assistantId)
        ? "AGENT_DEGRADED"
        : service.sessionFailures?.get(c.id)?.diagnostic;
      return diagnostic ? { ...c, diagnostic } : c;
    }),
  };
}
