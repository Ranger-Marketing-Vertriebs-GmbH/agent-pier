export const launchDialogCopy = {
  nativeModeDescription:
    "Uses the permissions in your tool profile and its native defaults.",
  codexYoloDescription:
    "YOLO runs commands without approval prompts or a sandbox. Applies only to this new session.",
  claudeAutoDescription:
    "Auto evaluates actions using Claude’s safety checks. Availability depends on version, model and account policies; approval prompts may still appear.",
  opencodeAutoDescription:
    "Auto approves permission requests automatically. Explicit denials remain active. Applies only to this new session.",
  codingSessionDescription: "A real terminal. Your tool, your account, your project.",
  shellSessionDescription:
    "A local shell for commands and tools in your working directory.",
  sessionNameLabel: "Session name",
  sessionNamePlaceholder: "e.g. Redesign website",
  accountLabel: "Account",
  noAvailableAccounts: "No available account",
  nativeModeOption: "Standard · tool defaults",
  codexYoloOption: "YOLO · no approval prompts or sandbox",
  claudeAutoOption: "Auto · with safety checks",
  opencodeAutoOption: "Auto · approve requests automatically",
  agentbusLaunchLabel: "AgentBus · connect sessions in the same project",
  agentbusLaunchHint:
    "CLIs can send messages to each other. This may trigger additional model work.",
};
export const sessionWorkspaceCopy = {
  openNavigation: "Open navigation",
  interruptKeyboardLabel: "Interrupt with Control C",
  sessionTitleDescription: "Account removed",
  terminalTab: "Terminal",
  chatTab: "Chat",
  terminalTopbarDisconnected: "Disconnected · retrying …",
  chatNotice: "Loading terminal …",
  keyboardToolbarAriaLabel: "Terminal keyboard",
  sessionFooterLabel: "The session keeps running when the browser is closed.",
};

export const sessionReloadCopy = {
  openTerminal: "Open terminal",
  terminalHint:
    "If the CLI asks to allow hooks or trust the project, confirm in the terminal. Reload continues when you close this dialog.",
  submitting: "Sending reload request …",
  prepareFailed:
    "The reload request could not be prepared. Try a browser with secure connection support.",
  title: "Reload & resume",
  hint: "Restart the CLI with this exact conversation and refreshed integrations. Your session, chat draft and assigned hosts stay in place.",
  loading: "Checking whether this conversation can resume …",
  now: "Reload now",
  queue: "Wait until idle",
  cancel: "Cancel queued reload",
  interrupt: "I understand that reloading now interrupts the current work.",
  uncertain:
    "The session is busy or its activity is uncertain. Wait until confirmed idle, or acknowledge the interruption.",
  unsupported: "This session cannot be reloaded.",
  unverified:
    "The native conversation has not been verified yet. The running process will stay untouched.",
  failed: "Reload failed. You can retry with the same conversation.",
  requestFailed:
    "The reload request could not be confirmed. Retry the same request to safely check its result.",
  retry: "Retry request",
  waiting: "Reload queued · waiting until idle",
  reloading: "Reloading the same conversation …",
  completed: "Conversation resumed with refreshed integrations.",
  close: "Close",
  refresh: "Check again",
};
