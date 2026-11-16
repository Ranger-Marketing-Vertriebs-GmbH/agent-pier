import { DEFAULT_RUNTIME } from "./agent-runtime.js";
import { DEFAULT_TRAITS, RUNTIME_TRAITS } from "./runtime-traits.js";
import { openClawDescriptor } from "./openclaw/descriptor.js";
import { hermesDescriptor } from "./hermes/descriptor.js";

// What the runtimes this AgentPier ships state about themselves
// (docs/adr/0007-runtime-descriptor.md), by the id agents record, the default first.
// This module imports the descriptors alone, never an adapter, so any module may read
// a trait: also one an adapter imports itself. runtime-for.js adds what needs a host.
const descriptors = Object.freeze({
  [openClawDescriptor.id]: openClawDescriptor,
  [hermesDescriptor.id]: hermesDescriptor,
});

/** The runtime ids an agent may record, the default first. */
export const RUNTIME_IDS = Object.freeze(Object.keys(descriptors));

/**
 * The runtime id `agent` records; an agent without one (and a missing agent) runs on
 * DEFAULT_RUNTIME. A team member's read already carries its lead's (assistant-store.js).
 */
export const runtimeIdOf = (agent) =>
  typeof agent?.runtime === "string" && agent.runtime ? agent.runtime : DEFAULT_RUNTIME;

/** The descriptor of runtime `id`, or undefined for one this AgentPier lacks. */
export const descriptorOf = (id) =>
  typeof id === "string" && Object.hasOwn(descriptors, id) ? descriptors[id] : undefined;

/**
 * How the runtime of `agent` behaves in `feature`: the value of `trait` its
 * descriptor states (runtime-traits.js names every trait). It reads only the runtime
 * the agent records (runtimeIdOf), so it needs no supervisor; a runtime this
 * AgentPier lacks answers the default. A trait the schema does not name is a
 * TypeError.
 */
export function traitOf(agent, feature, trait) {
  if (!Object.hasOwn(RUNTIME_TRAITS[feature] || {}, trait))
    throw new TypeError(`Unknown runtime trait: ${feature}.${trait}`);
  return (descriptorOf(runtimeIdOf(agent))?.traits ?? DEFAULT_TRAITS)[feature][trait];
}
