import { createOpenClawRuntime } from "./openclaw/openclaw-runtime.js";
import { openClawCompiler } from "./openclaw/openclaw-compiler.js";

// One adapter per supervisor, so every caller of one host shares it.
const adapters = new WeakMap();

/**
 * The agent runtime port (agent-runtime.js) that runs `agent`. Agents have no runtime
 * field yet, so every agent, and a missing one, runs on OpenClaw behind `supervisor`
 * (openclaw/runtime-supervisor.js). Once agents record `runtime`, this picks its
 * adapter.
 */
export function runtimeFor(agent, supervisor) {
  if (!supervisor || typeof supervisor !== "object")
    throw new TypeError("runtimeFor needs the runtime supervisor.");
  let adapter = adapters.get(supervisor);
  if (!adapter) adapters.set(supervisor, (adapter = createOpenClawRuntime(supervisor)));
  return adapter;
}

/**
 * The configuration compiler of the runtime that runs `agent`: the pure part of its
 * config sub-port (agent-runtime.js `config.compiler`), the same object as
 * `runtimeFor(agent, supervisor).config.compiler`. It needs no host, so callers
 * without a supervisor (an audit record, a CLI environment) use it too. Every agent
 * runs on OpenClaw until agents record `runtime`.
 */
export const compilerFor = (_agent) => openClawCompiler;

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
 * The current connection of the runtime of `agent` behind `supervisor`
 * (host.connection()), or null without a supervisor. Compared across an await, it
 * tells whether the runtime was replaced meanwhile.
 */
export const hostConnection = (supervisor, agent) =>
  !!supervisor && typeof supervisor === "object"
    ? runtimeFor(agent, supervisor).host.connection()
    : null;
