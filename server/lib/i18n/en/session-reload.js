/** English counterpart of de/session-reload.js with identical keys. */
export const sessionReload = Object.freeze({
  conflictingNativeSelection: "Conflicting native conversation selection.",
  notReloadable: "This session cannot be reloaded.",
  cliUnavailable: "The coding CLI is unavailable.",
  projectDirectoryUnavailable: "The project directory is unavailable.",
  providerAccountLocked:
    "Choose another account for the same CLI. Provider sessions cannot switch accounts.",
  modelSelectionPending: "Finish the current model selection before reloading.",
  providerChanged:
    "The provider changed. Restore the original provider before reloading.",
  accessModeChanged: "The account access mode changed.",
  conversationAlreadyRunning:
    "This conversation is already running in the target account.",
  accountUnavailable: "The selected account is no longer available.",
  conversationChangedBeforeReload:
    "The native conversation changed before reload. No process was stopped.",
  modelChangedBeforeReload: "The model changed before reload. No process was stopped.",
  notIdle: "The session is no longer idle. Reload was not started.",
  modelNotPreservable:
    "The current model cannot be preserved reliably. Confirm an exact native model before reloading.",
  shuttingDown: "Session reload is shutting down.",
  invalidRequest: "Invalid session reload request.",
  requestLimit: "The reload request limit for this session has been reached.",
  pending: "A session reload is already pending.",
  noVerifiedConversation: "No verified native conversation is available for reload.",
  confirmInterruption: "Confirm interruption before reloading this session.",
  resumedCliExited: "The resumed CLI exited.",
  resumedCliDifferentConversation: "The resumed CLI selected a different conversation.",
  conversationChangedWhileWaiting: "The native conversation changed while waiting.",
  alreadyRestarting: "The session is already restarting.",
  intentMissing: "Reload intent is missing.",
});
