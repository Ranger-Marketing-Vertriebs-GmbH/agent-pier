import { RUNTIME_IDS, runtimeIdOf } from "./runtime-descriptors.js";
import { hermesDescriptor } from "./hermes/descriptor.js";
import * as hermesWiring from "./hermes/wiring.js";

// How the composition roots wire each runtime's own services, naming none
// (docs/adr/0007-runtime-descriptor.md, decision 7). A runtime with services of its
// own has a `<id>/wiring.js` with up to three hooks:
//
// - `wire(services, context)`: once per application (application/services.js), with
//   the application's `services` (read lazily: the agent services exist only while
//   agents are on) and `context` (`{ config }`). It makes what lives as long as the
//   application (Hermes: the owner's switch) and returns what the application keeps:
//   `{ services, install, routes, listening }`, each optional.
// - `agentHosts(supervisor, context)`: once per assistant graph, which is built anew
//   whenever agents are switched on (application/assistant-graph.js). It builds the
//   runtime's agent hosts and attaches them (runtime-for.js attachAgentHosts).
// - `applyInputs(connected)`: once per connected graph; returns `(assistant) =>
//   inputs`, what an apply of one of its agents reads beside the agent's record.
//
// OpenClaw has none: it is the built-in runtime, whose supervisor and services the
// assistant graph constructs itself (ADR 0007).
//
// Read at each call, never when this module loads: a wiring imports feature modules.
const wirings = () => ({ [hermesDescriptor.id]: hermesWiring });
/** The ids of the runtimes with a wiring: each with a `<id>/wiring.js`. */
export const wiredRuntimes = () => Object.keys(wirings());

// Every runtime's hook `name`, in registry order: `[id, hook]`.
const hooks = (name) =>
  RUNTIME_IDS.map((id) => [id, wirings()[id]?.[name]]).filter(([, hook]) => hook);

/**
 * Calls every runtime's `wire(services, context)` once, in registry order, and
 * merges what each returns onto `services`:
 *
 * - its `services` by their names (Hermes: `hermesRuntime`);
 * - its `install` (`() => state`) as `services.runtimeInstalls[id]`, the install
 *   state the runtime list shows (runtime-for.js runtimeList);
 * - its `routes` (`(services) => Router`) into `services.runtimeWiring.routes`, which
 *   the agent routes mount (http/routes/assistants.js);
 * - its `listening` (`() => void`) into `services.runtimeWiring.listening`, which
 *   startRuntimes calls once the server listens.
 *
 * Returns `{ services, installs, routes, listening }` as merged.
 */
export function wireRuntimes(services, context) {
  const wired = { services: {}, installs: {}, routes: [], listening: [] };
  for (const [id, wire] of hooks("wire")) {
    const made = wire(services, context) || {};
    Object.assign(wired.services, made.services);
    Object.assign(services, made.services);
    if (made.install) wired.installs[id] = made.install;
    if (made.routes) wired.routes.push(made.routes);
    if (made.listening) wired.listening.push(made.listening);
  }
  services.runtimeInstalls = wired.installs;
  services.runtimeWiring = { routes: wired.routes, listening: wired.listening };
  return wired;
}

/** Once the server listens: each runtime's own start, in registry order. */
export const startRuntimes = (services) =>
  (services.runtimeWiring?.listening ?? []).map((start) => start());

/** The routers the runtimes bring to the agent routes, in registry order. */
export const runtimeRouters = (services) =>
  (services.runtimeWiring?.routes ?? []).map((routes) => routes(services));

/**
 * Builds the agent hosts of every runtime with a host per agent for one assistant
 * graph and attaches them to its `supervisor`. `context`: `{ dataDir, store,
 * created }`, `created` being the graph's services as they come to exist.
 */
export function wireAgentHosts(supervisor, context) {
  for (const [, agentHosts] of hooks("agentHosts")) agentHosts(supervisor, context);
}

/**
 * The configuration service's wiring for agents on a host of their own
 * (AssistantConfig applyOwnProcess): `hostInputs(assistant)` answers what the
 * runtime of `assistant` reads at an apply beside the agent's record, undefined for
 * a runtime that brings none. `connected`: `{ bridge, webTools, proxy }`.
 */
export function ownProcessWiring(connected) {
  const inputs = new Map(
    hooks("applyInputs").map(([id, applyInputs]) => [id, applyInputs(connected)]),
  );
  return {
    hostInputs: (assistant) => inputs.get(runtimeIdOf(assistant))?.(assistant),
  };
}
