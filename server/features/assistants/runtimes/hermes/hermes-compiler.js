import { isDesiredAgent, isDesiredState } from "../../agent-desired-state.js";
import { unavailable } from "../agent-runtime.js";
import { compileHome } from "./hermes-config/home.js";
import { writeHermesHome } from "./hermes-config/home-writer.js";

/**
 * What the Hermes config sub-port offers of the capabilities (../agent-runtime.js
 * RUNTIME_CAPABILITIES): no owner overrides of Hermes settings beyond AgentPier's
 * model yet, so `advancedSettings` is unavailable and the compiler has none.
 */
export const hermesConfigCapabilities = Object.freeze({
  advancedSettings: unavailable("advancedSettingsUnsupported"),
});

/**
 * Every agent's Hermes home from AgentPier's desired state (agent-desired-state.js
 * desiredState): `{ homes: { [runtimeAgentId]: home } }` for each agent that is not
 * archived (hermes-config/home.js compileHome). `agents`: desiredAgent reads that
 * carry the model connection and instructions of a live apply, replacing the entry
 * of the same agent; `workspaces` and `homes` (each agent's files as found, `{
 * "config.yaml", ".env" }`) are by runtime agent id; `strictShell`: the runtime
 * agent ids on every-command approval. Facts other runtimes take (`existing`,
 * `paths`, `port`, `token`) are ignored. Pure.
 */
function compile({
  desired,
  agents = [],
  workspaces = {},
  homes = {},
  strictShell = [],
}) {
  if (!isDesiredState(desired)) throw new TypeError("Hermes compiles a desired state.");
  if (!agents.every(isDesiredAgent))
    throw new TypeError("Hermes compiles agents from their desired state.");
  const live = new Map(agents.map((agent) => [agent.id, agent]));
  const listed = desired.agents.map((agent) => live.get(agent.id) || agent);
  const extra = agents.filter((agent) => !desired.agents.some((a) => a.id === agent.id));
  const entries = [...listed, ...extra]
    .filter((agent) => !agent.archived)
    .map((agent) => [
      agent.runtimeAgentId,
      compileHome(agent, {
        workspace: workspaces[agent.runtimeAgentId],
        strict: strictShell,
        existing: homes[agent.runtimeAgentId] || {},
      }),
    ]);
  return Object.freeze({ homes: Object.freeze(Object.fromEntries(entries)) });
}

/**
 * The Hermes configuration compiler, the pure part of the Hermes config sub-port
 * (../agent-runtime.js `config.compiler`), shaped like OpenClaw's
 * (../openclaw/openclaw-compiler.js) where the meaning is the same. Each agent runs
 * in its own Hermes process and home (ADR 0006 decision 4); docs/hermes-runtime.md
 * describes what AgentPier writes there. `write(dir, home)` is the one part that
 * touches the disk: it merges a compiled home into the agent's HERMES_HOME.
 */
export const hermesCompiler = Object.freeze({
  compile,
  // One agent's home: compileHome(agent, { workspace, strict, existing }).
  compileHome,
  write: writeHermesHome,
});
