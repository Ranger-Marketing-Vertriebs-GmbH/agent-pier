import { createOpenClawRuntime } from "./openclaw/openclaw-runtime.js";

// One adapter per supervisor, so every caller of one host shares it.
const adapters = new WeakMap();

/**
 * The agent runtime port (agent-runtime.js) that runs `agent`. Agents have no runtime
 * field yet, so every agent, and a missing one, runs on OpenClaw behind `supervisor`
 * (runtime-supervisor.js). Once agents record `runtime`, this picks its adapter.
 */
export function runtimeFor(agent, supervisor) {
  if (!supervisor || typeof supervisor !== "object")
    throw new TypeError("runtimeFor needs the runtime supervisor.");
  let adapter = adapters.get(supervisor);
  if (!adapter) adapters.set(supervisor, (adapter = createOpenClawRuntime(supervisor)));
  return adapter;
}

/** A resolver `(agent) => AgentRuntime` bound to the supervisor `supervisor()` returns. */
export const runtimeResolver = (supervisor) => (agent) => runtimeFor(agent, supervisor());

/**
 * Whether the runtime host of `agent` behind `supervisor` takes calls now
 * (host.ready()); false without a supervisor, as during setup or in a closed service.
 */
export const hostReady = (supervisor, agent) =>
  !!supervisor &&
  typeof supervisor === "object" &&
  runtimeFor(agent, supervisor).host.ready();
