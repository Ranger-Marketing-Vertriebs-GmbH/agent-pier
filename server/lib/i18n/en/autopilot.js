export const autopilot = Object.freeze({
  orderNotFound: "This Autopilot order could not be found.",
  projectUnavailable: "Open a registered local Git project for this order.",
  unsafeOrderFile: "The Composer order's storage location has changed or is unsafe.",
  orderFileUnavailable: "Restore the original Composer order file.",
  requestConflict:
    "This request ID already belongs to a different order or different start options.",
  requestRemoved: "The order created by this request has already been removed.",
  cleanupUnavailable:
    "Only completed orders managed by AgentPier with no outstanding work can be removed.",
  invalidOrder: "Check the Autopilot order fields.",
  selectionRequired: "Choose a coding CLI or CLI account for the Composer session.",
  composerSkillUnavailable:
    "Install the current bundled version of agentpier-composer in the selected CLI profile.",
  sessionRecoveryRequired:
    "The linked Composer session is missing. Recover the session from the saved order.",
  sessionUnavailable:
    "Check the Composer session's state and resume it from the session view.",
  worktreeBusy:
    "Stop active sessions, processes and runs in the Composer worktree before removal.",
  worktreeDirty:
    "Preserve local changes and extra files in the Composer worktree before removal.",
  worktreeUnmerged: "The Composer branch contains commits missing from its base branch.",
  ownershipMismatch:
    "The Composer worktree or session does not match the recorded ownership.",
  deliveryFailed: "Check message delivery in the Composer session and retry.",
  unmanaged: "This order has no session managed by AgentPier.",
  executionUnavailable:
    "Resume this order and authorize implementation before starting another pipeline.",
  inactive: "This order is complete or is being removed.",
});
