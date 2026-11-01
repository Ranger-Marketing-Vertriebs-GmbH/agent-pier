import { defineAgentRuntime, unavailable } from "../agent-runtime.js";
import { openClawAgentFiles, openClawAgents } from "./openclaw-agents.js";
import { openClawApprovals } from "./openclaw-approvals.js";
import { openClawConfig } from "./openclaw-configuration.js";
import { openClawEvents } from "./openclaw-events.js";
import { openClawLifecycle } from "./openclaw-lifecycle.js";
import { openClawBrowser } from "./openclaw-browser.js";
import { openClawModels } from "./openclaw-models.js";
import { openClawRoutines } from "./openclaw-routines.js";
import { openClawSkills } from "./openclaw-skills.js";
import { openClawSessions } from "./openclaw-sessions.js";
import { lastCdpOffset } from "./openclaw-config/browser-profiles.js";

// One opaque handle per Gateway client: a restart replaces the client, so the handle
// tells callers whether an await crossed one. Shared by every adapter of a process.
// The handle keeps its client, so calls bound to it (`on(connection)` of sessions,
// agents, agentFiles, config, approvals, routines, skills, browser and models)
// reach that client.
const connections = new WeakMap();
const clients = new WeakMap();
function connectionOf(client) {
  if (!client || typeof client !== "object") return null;
  let connection = connections.get(client);
  if (!connection) {
    connections.set(client, (connection = Object.freeze({})));
    clients.set(connection, client);
  }
  return connection;
}
const clientOf = (connection) =>
  (connection && typeof connection === "object" && clients.get(connection)) || null;

const portOf = (url) => {
  try {
    return Number(new URL(url).port) || null;
  } catch {
    return null;
  }
};

/** The Gateway's loopback ports: its own, its CDP ports and the browser profiles'. */
function loopbackPorts(supervisor) {
  const ports = [];
  const gateway = portOf(supervisor?.client?.url) ?? supervisor?.webTools?.port;
  if (gateway) {
    ports.push(gateway);
    // OpenClaw's CDP ports: gateway + 11 up to + lastCdpOffset (web-tools.js).
    for (let offset = 11; offset <= lastCdpOffset; offset++) ports.push(gateway + offset);
  }
  for (const profile of Object.values(supervisor?.webTools?.browserProfiles || {}))
    ports.push(profile?.cdpPort);
  return ports.filter((port) => Number.isInteger(port) && port > 0);
}

/**
 * The OpenClaw adapter of the agent runtime port (../agent-runtime.js) over the
 * runtime supervisor (runtime-supervisor.js). Once every caller has moved, this
 * directory is the only place that calls the Gateway client
 * (tests/unit/runtime-port-rules.test.js).
 *
 * The supervisor's client is read at each call: a Gateway restart replaces it, so the
 * adapter never binds to one. Every Gateway method is async, so a missing client
 * rejects like an unreachable Gateway.
 */
export function createOpenClawRuntime(supervisor) {
  const call = async (method, params) => supervisor.client.call(method, params);
  return defineAgentRuntime({
    id: "openclaw",
    // OpenClaw's "approval" level already asks before every command.
    capabilities: { everyCommandApproval: unavailable("approvalAsksEveryCommand") },
    host: openClawHost(supervisor),
    sessions: openClawSessions(supervisor, clientOf),
    events: openClawEvents(supervisor),
    agents: openClawAgents(supervisor, clientOf),
    agentFiles: openClawAgentFiles(supervisor, clientOf),
    config: openClawConfig(supervisor, clientOf),
    approvals: openClawApprovals(supervisor, clientOf),
    routines: openClawRoutines(supervisor, clientOf),
    skills: openClawSkills(supervisor, clientOf),
    browser: openClawBrowser(supervisor, clientOf),
    models: openClawModels(supervisor, clientOf),
    channels: {
      status: ({ probe = false } = {}) => call("channels.status", { probe }),
    },
  });
}

/**
 * The host sub-port over the supervisor: one Gateway per host, so every agent shares
 * it. `ready()` and `status()` answer synchronously, as callers check them inline;
 * lifecycle methods return the supervisor's promises. Install, update, rollback and
 * restart reasons come from openclaw-lifecycle.js.
 */
function openClawHost(supervisor) {
  return {
    // The Gateway client is connected and authenticated: calls may go out now.
    ready: () => !!supervisor.client?.ready,
    // The current client's handle, or null: the same until the client is replaced.
    connection: () => connectionOf(supervisor.client),
    // Whether the client behind `connection` still takes calls, current or not.
    connected: (connection) => !!clientOf(connection)?.ready,
    // Calls `listener()` once when the client behind `connection` disconnects;
    // returns the unsubscribe function (a no-op without a client).
    onDisconnect(connection, listener) {
      const client = clientOf(connection);
      if (!client) return () => {};
      client.once("disconnected", listener);
      return () => client.off("disconnected", listener);
    },
    // { availability, sync, version, diagnostic } as the supervisor reports it.
    status: () => supervisor.status(),
    version: () => supervisor.status().version ?? null,
    // Calls `listener(status)` on every change; returns the unsubscribe function.
    // A supervisor that emits no events (a test double) never calls it.
    subscribe(listener) {
      supervisor.on?.("status", listener);
      return () => supervisor.off?.("status", listener);
    },
    start: (options) => supervisor.start(options),
    stop: (options) => supervisor.stop(options),
    restart: () => supervisor.restart(),
    // Synchronous: a preview checks its target against these ports on every open.
    loopbackPorts: () => loopbackPorts(supervisor),
    ...openClawLifecycle(supervisor),
  };
}
