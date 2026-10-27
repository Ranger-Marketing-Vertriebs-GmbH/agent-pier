/** Owner-facing copy of agents' coding sessions (assistantProblem keys). */
export const agentCodingSessions = Object.freeze({
  sessionsNotEnabled:
    "Coding-Sessions sind für diesen Agenten in keinem Projekt aktiviert.",
  grantRevoked:
    "Der Agent darf diese Coding-Session nicht mehr steuern: Freigabe oder Projektzugriff wurde entzogen.",
  sessionLimit: "Der Agent hat bereits die höchste Zahl gleichzeitiger Coding-Sessions.",
  promptAnswered:
    "Diese Rückfrage der Session wurde bereits beantwortet oder hat sich geändert.",
  sessionRunning: "Die Session arbeitet noch.",
  worktreeDirty: "Der Worktree enthält nicht übernommene Änderungen und bleibt bestehen.",
  worktreeNotMerged:
    "Der Branch des Worktrees ist noch nicht in seinen Basis-Branch auf origin übernommen; der Worktree bleibt bestehen.",
  noRepository:
    "Der Projektordner ist kein Git-Repository mit einem origin-Remote; ein Worktree ist nicht möglich.",
});
