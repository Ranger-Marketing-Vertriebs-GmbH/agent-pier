import { defineAgentRuntime } from "../agent-runtime.js";
import { createGatewaySession } from "../../session-create.js";

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
  const call = async (method, params, options) =>
    supervisor.client.call(method, params, options);
  return defineAgentRuntime({
    id: "openclaw",
    sessions: {
      // Retries a session the Gateway has not created yet (session-create.js).
      create: async (params, options) => createGatewaySession({ call }, params, options),
      subscribe: ({ key }) => call("sessions.messages.subscribe", { key }),
    },
    host: openClawHost(supervisor),
    channels: {
      status: ({ probe = false } = {}) => call("channels.status", { probe }),
    },
  });
}

/**
 * The host sub-port over the supervisor: one Gateway per host, so every agent shares
 * it. `ready()` and `status()` answer synchronously, as callers check them inline;
 * lifecycle methods return the supervisor's promises.
 */
function openClawHost(supervisor) {
  return {
    // The Gateway client is connected and authenticated: calls may go out now.
    ready: () => !!supervisor.client?.ready,
    // { availability, sync, version, diagnostic } as the supervisor reports it.
    status: () => supervisor.status(),
    version: () => supervisor.status().version ?? null,
    // Calls `listener(status)` on every change; returns the unsubscribe function.
    subscribe(listener) {
      supervisor.on("status", listener);
      return () => supervisor.off("status", listener);
    },
    start: (options) => supervisor.start(options),
    stop: (options) => supervisor.stop(options),
    restart: () => supervisor.restart(),
  };
}
