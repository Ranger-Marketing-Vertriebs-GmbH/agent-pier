import { setTimeout as delay } from "node:timers/promises";

// OpenClaw 2026.10.7 inspects and prepares agent databases it cannot trust at once
// (after an unclean stop: a stale lease) in the background once it listens. Until an
// agent is admitted, agents.list reports it `status: "degraded"` with an admission
// refusal coded `agent-database-inspection-pending`. A runtime configuration change
// meanwhile (config.patch, agents.create, agents.update) supersedes that preparation,
// and OpenClaw never retries it: the agent stays refused
// (`agent-database-inspection-failed`) for the Gateway's lifetime, and its sessions
// answer UNAVAILABLE (AGENTPIER-238). Every AgentPier configuration write therefore
// waits here first, once per connection, until no agent is pending or for at most
// `admissionWaitMs`; writes that arrive meanwhile wait for the same answer and go out
// after it. The agents still refused afterwards are degraded until the Gateway
// restarts.
export const admissionWaitMs = 120000;
export const pendingAdmission = "agent-database-inspection-pending";
const firstPollMs = 250;
const lastPollMs = 2000;
// Per Gateway client: the shared wait and the agents it reported degraded.
const admissions = new WeakMap();
const starting = Symbol("starting");

function stateOf(client) {
  let state = admissions.get(client);
  if (!state) {
    state = { settled: null, degraded: new Set() };
    admissions.set(client, state);
    // A reconnect may reach a Gateway that started again in place: it asks anew.
    client.on?.("disconnected", () => {
      state.settled = null;
    });
  }
  return state;
}

async function watch(client, state, { timeoutMs, now, sleep, warn }) {
  const deadline = now() + timeoutMs;
  for (let pause = firstPollMs; ; pause = Math.min(lastPollMs, pause * 2)) {
    const roster = await client.call("agents.list", {}).catch((error) => {
      // Still starting: asked again. Anything else is no admission to wait for.
      if (error?.answered && error.code === "UNAVAILABLE") return starting;
      throw error;
    });
    if (roster !== starting) {
      const agents = Array.isArray(roster?.agents) ? roster.agents : [];
      const pending = agents.filter(
        (a) => a?.admissionRefusal?.code === pendingAdmission,
      );
      state.degraded = new Set(
        agents
          .filter((a) => a?.status === "degraded" && !pending.includes(a))
          .map((a) => a.id),
      );
      if (!pending.length) return;
    }
    const left = deadline - now();
    if (left <= 0) {
      warn(`Assistant Gateway still admitted agents after ${timeoutMs} ms; writing.`);
      return;
    }
    await sleep(Math.min(pause, left));
  }
}

/**
 * Resolves once the Gateway behind `client` admitted every agent it prepares in the
 * background, or after `timeoutMs`. Never rejects: a failed roster read is asked
 * again by the next caller.
 */
export function settledAdmission(
  client,
  {
    timeoutMs = admissionWaitMs,
    now = Date.now,
    sleep = delay,
    warn = console.warn,
  } = {},
) {
  if (!client) return Promise.resolve();
  const state = stateOf(client);
  if (!state.settled) {
    const settled = watch(client, state, { timeoutMs, now, sleep, warn }).catch(() => {
      if (state.settled === settled) state.settled = null;
    });
    state.settled = settled;
  }
  return state.settled;
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
