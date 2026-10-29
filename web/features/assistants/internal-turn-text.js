/**
 * The chat's line for an internal turn (server conversations.js internalKinds). A
 * member's question or task that ended without a result names how it ended instead
 * of "a member's answer arrived" (`outcome`, server lead-requests.js deliveryTarget).
 */
export function internalTurnText(copy, kind, outcome) {
  if (kind === "member-result" && outcome)
    return copy.team.memberOutcomes[outcome] ?? copy.team.memberOutcomes.failed;
  return copy.team.internalTurns[kind];
}
