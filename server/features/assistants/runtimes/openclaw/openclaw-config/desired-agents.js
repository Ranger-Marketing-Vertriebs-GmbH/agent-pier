import {
  desiredAgent,
  desiredState,
  isDesiredAgent,
  isDesiredState,
} from "../../../agent-desired-state.js";

// The compiler reads agents only as AgentPier's desired state
// (../../../agent-desired-state.js). Feature code hands it desired states; a stored
// agent record, as unit tests of single compile steps hand them, is read as its
// desired state with `context` (desiredAgent's options).
export const asDesired = (agent, context) =>
  isDesiredAgent(agent) ? agent : desiredAgent(agent, context);

/** A whole desired state; the stores' reads (desiredState's inputs) are built into one. */
export const asDesiredState = (state) =>
  isDesiredState(state) ? state : desiredState(state || {});
