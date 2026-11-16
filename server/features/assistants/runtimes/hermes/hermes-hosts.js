import { agentHosts, attachAgentHosts } from "../runtime-for.js";
import { hermesDescriptor } from "./descriptor.js";

// Hermes's agent hosts are its fleet (hermes-fleet.js): one process set per agent.
// The port keeps each supervisor's by runtime id (../runtime-for.js agentHosts);
// Hermes's own modules and its tests reach the fleet by name here.

/**
 * Attaches the Hermes `fleet` the wiring built (wiring.js hermesAgentFleet) to the
 * `supervisor` every caller passes, so runtimeFor resolves Hermes agents through it.
 * Returns the fleet.
 */
export const attachHermesFleet = (supervisor, fleet) =>
  attachAgentHosts(supervisor, hermesDescriptor.id, fleet);

/** The Hermes fleet behind `supervisor` (an idle one when none was attached). */
export const hermesFleetOf = (supervisor) =>
  agentHosts(supervisor, { runtime: hermesDescriptor.id });
