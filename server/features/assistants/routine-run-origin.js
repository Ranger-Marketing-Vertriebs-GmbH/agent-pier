import { personalCapabilities } from "./native-capabilities.js";
import { isLeadRoutine } from "./lead-routines.js";

// A routine is standing work its owner configured for this agent: its run may
// change the agent's own workspace like an owner turn. This origin is only the
// run session of a bound, enabled routine of the calling agent with memory and
// routines on; reminders, check-ins and every other session never match, and it
// grants nothing to delegated tasks by itself: only a routine the owner marked
// "May write" starts tasks that may write (lead-request-store.js).
export function routineWrite(bridge, input) {
  const agent = bridge.agentOf(input.agentId);
  if (!agent || agent.archivedAt) return false;
  const capabilities = personalCapabilities(agent);
  if (!capabilities.memory || !capabilities.reminders) return false;
  const run = bridge.assistants.routines?.runOrigin(agent, input.sessionKey);
  // A lead's routine on its member writes only with the owner's "May write" or the
  // lead's autonomous team usage (lead-routines.js); the owner's own always may.
  if (run && isLeadRoutine(run.binding))
    return bridge.assistants.routines.writable(run.binding);
  return !!run;
}

// The run session of a bound, enabled routine of a personal agent with routines on.
export function routineRun(bridge, input) {
  const agent = bridge.agentOf(input.agentId);
  if (
    !agent ||
    agent.archivedAt ||
    (agent.teamMemberId && agent.lifetime !== "permanent") ||
    !personalCapabilities(agent).reminders
  )
    return null;
  return bridge.assistants.routines?.runOrigin(agent, input.sessionKey) || null;
}
