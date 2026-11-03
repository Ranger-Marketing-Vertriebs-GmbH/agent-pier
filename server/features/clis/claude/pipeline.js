/** See codex/pipeline.js. `claudeDefault` is the mode the CLI calls "default". */
export function command({
  args,
  mode,
  sessionId,
  resumeNativeId,
  headless,
  claudeDefault,
}) {
  let permissions = [];
  // The shared lifecycle preassigns a new native session ID. Resuming must
  // retain the original conversation instead of combining both CLI options.
  for (let index = args.length - 1; index >= 0; index--) {
    if (args[index] === "--session-id") args.splice(index, 2);
    else if (args[index].startsWith("--session-id=")) args.splice(index, 1);
  }
  if (headless) args.push("--permission-mode", "bypassPermissions");
  else {
    permissions = ["--permission-mode", mode === "default" ? claudeDefault : mode];
    args.push(...permissions);
  }
  if (resumeNativeId) args.push("--resume", resumeNativeId);
  else args.push("--session-id", sessionId);
  if (headless)
    return {
      args: ["--print", "--output-format", "stream-json", "--verbose", ...args],
      permissions,
    };
  return { args, permissions };
}

export const sessionArgs = (sessionId) => ["--session-id", sessionId];

export const promptArgs = (prompt) => ["--", prompt];

/** Reading `--output-format stream-json` events. */
export const events = {
  nativeId: (event) => event.session_id,
  failed: (event) => event.type === "result" && event.is_error === true,
  progress: () => false,
  completed: (event) => event.type === "result",
};
