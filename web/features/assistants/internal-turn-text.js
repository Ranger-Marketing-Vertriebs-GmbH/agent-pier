// Lines for a request that ended without a result, by the internal turn's kind.
const outcomeLines = { "member-result": "memberOutcomes", "peer-result": "peerOutcomes" };

/**
 * The chat's line for an internal turn (server conversations.js internalKinds). A
 * member's question or task that ended without a result names how it ended instead
 * of "a member's answer arrived" (`outcome`, server lead-requests.js deliveryTarget
 * and peer-requests.js target), in the lead's and in the asking member's chat.
 */
export function internalTurnText(copy, kind, outcome) {
  const lines = copy.team[outcomeLines[kind]];
  if (lines && outcome) return lines[outcome] ?? lines.failed;
  return copy.team.internalTurns[kind];
}
