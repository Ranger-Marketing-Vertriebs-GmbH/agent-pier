/** English product copy, addressed through the same semantic keys as the German catalog. */
export const sessions = Object.freeze({
  invalidSandboxProfile: "Invalid sandbox profile.",
  sandboxUnavailable:
    "nono is not installed on this machine. The session was not started.",
  sandboxProfileUnknown:
    "This sandbox profile is unavailable. Please select another one.",
  sandboxNotForLogin: "Sign-in sessions cannot run in the sandbox.",
  sandboxNotForPipeline: "Pipeline steps cannot run in the sandbox in this version.",
  sandboxNotForTaskProfile:
    "Sandbox profiles are unavailable when launching with a task profile.",
  invalidAgentBusSelection: "Invalid AgentBus selection.",
  loginNameSuffix: " · Sign-in",
  sessionLimitReached: "At most 30 sessions at a time. Please stop a session first.",
  stopBeforeLogin: "Please stop this account's running sessions before a new sign-in.",
  invalidNativeBinding: "Invalid native session binding.",
  invalidNativeBindingKey: "Invalid key for the native session binding.",
  nativeProjectMismatch: "The native session belongs to a different project.",
  nativeProcessAlreadyBound: "Another running process has already bound this session.",
  codexHooksCannotBeMerged: "The temporary Codex hooks cannot be merged safely.",
  unknownCodexHookFormat: "The temporary Codex hooks have an unknown format.",
  temporaryTuiConfigConflict:
    "An additional temporary OpenCode TUI configuration is already set.",
  activityWorking: "Working",
  activityReady: "Ready",
  activityWaiting: "Waiting for input",
  activityUnknown: "Activity unknown",
  activityStopped: "Stopped",
  shellConfigurationRestricted:
    "Shell sessions only use the local terminal without AgentBus or a CLI launch mode.",
  shellModelPickerUnavailable: "Model selection is not available in shell sessions.",
  loginModelPickerUnavailable: "Model selection is not available during sign-in.",
  stopped: "The session has stopped.",
  nativeProcessStopped: "The native session process has stopped.",
  nativeSessionIdMissing: "The native session ID is missing.",
  nativeBindingAlreadyExists: "This native session binding already exists.",
});
