/** Owner-facing copy of agents' coding sessions (assistantProblem keys). */
export const agentCodingSessions = Object.freeze({
  sessionsNotEnabled:
    "Coding sessions are not switched on for this agent in any project.",
  grantRevoked:
    "The agent may no longer control this coding session: its access or the project grant was removed.",
  sessionLimit: "The agent already runs the most coding sessions allowed at a time.",
  promptAnswered: "This prompt of the session was already answered or has changed.",
  sessionRunning: "The session is still working.",
  worktreeDirty: "The worktree has uncommitted changes and is kept.",
  worktreeNotMerged:
    "The worktree's branch is not merged into its base branch on origin yet; the worktree is kept.",
  noRepository:
    "The project folder is not a Git repository with an origin remote; a worktree is not possible.",
});
