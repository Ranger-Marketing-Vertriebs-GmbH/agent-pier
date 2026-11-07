/** Owner-facing copy of the agent pinboard (assistantProblem keys). */
export const agentPinboard = Object.freeze({
  pinboardListNotFound: "This pinboard list does not exist.",
  pinboardEntryNotFound: "This pinboard entry does not exist.",
  pinboardListLimit: (max) =>
    `The pinboard already has the most open lists allowed (${max}). Archive or delete one first.`,
  pinboardEntryLimit: (max) =>
    `This list already holds the most entries allowed (${max}). Remove one first.`,
  pinboardOwnerOnly: "Only the owner can use the pinboard of an agent.",
  pinboardUnavailable: "The pinboard is not available right now.",
});
