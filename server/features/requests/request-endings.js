// Why a request ended without an answer from chat, as `request.expired` records it
// in `details.cause`:
// - `timeout`: the hook's lifetime ran out; Claude's own dialog is left.
// - `native`: decided in the CLI itself (its terminal dialog or TUI).
// - `stale`: the CLI moved on to a later call, so nothing waits for this one.
// - `socket`: the CLI's request channel closed (the process ended or was killed).
// - `discard`: the session stopped or was removed.
// - `startup`: a Claude startup screen left the terminal.
export const endCauses = ["timeout", "native", "stale", "socket", "discard", "startup"];

/** The cause a native channel reported with `resolved`; any other outcome is native. */
export const endCause = (outcome) =>
  ["timeout", "native", "stale"].includes(outcome) ? outcome : "native";

// Claude's startup screens arrive as permissions, but they are not tool approvals.
export const startupPresentations = ["claudeFolderTrust", "claudeStartupPrompt"];
