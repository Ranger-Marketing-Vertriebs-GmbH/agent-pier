/** English messages of the data directory cleanup (System status). */
export const storageCleanup = Object.freeze({
  notFound: "Not found. Reload the list.",
  updateRunning:
    "An agent runtime update is running or a recovery still needs the backups. Try again afterwards.",
  busy: "A cleanup is already running. Wait until it has finished.",
  invalidAge: "Choose 30, 90 or 180 days.",
  profileUnsupported: "AgentPier cannot delete transcripts for this CLI profile.",
  sessionsUnreadable:
    "AgentPier could not check which sessions it still knows. Nothing was deleted.",
  agentBusy:
    "The agent is working or a command runs in its workspace. Try again when it has finished.",
  processesUnreadable:
    "AgentPier could not check whether a command runs in the workspace. Nothing was deleted.",
});
