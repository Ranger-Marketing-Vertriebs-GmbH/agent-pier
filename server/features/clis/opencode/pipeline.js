const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);

/** See codex/pipeline.js. */
export function command({ args, mode, resumeNativeId, headless }) {
  let permissions = [];
  if (headless) args.push("--auto");
  else if (mode === "auto") {
    permissions = ["--auto"];
    args.push(...permissions);
  }
  if (resumeNativeId) args.push("--session", resumeNativeId);
  if (headless) return { args: ["run", "--format", "json", ...args], permissions };
  return { args, permissions };
}

export const sessionArgs = () => [];

export const promptArgs = (prompt) => ["--prompt", prompt];

/** Reading `opencode run --format json` events. */
export const events = {
  nativeId: (event) => event.sessionID,
  failed: () => false,
  // Steps carry OpenCode's usage and completion; returns whether `event` was one.
  progress(state, event) {
    // A new OpenCode step after a final one means the turn continues.
    if (event.type === "step_start") delete state.result;
    else if (event.type === "step_finish") {
      const tokens = event.part?.tokens;
      if (
        tokens &&
        (count(tokens.input) !== undefined || count(tokens.output) !== undefined)
      )
        state.usage = {
          inputTokens: (state.usage?.inputTokens || 0) + (count(tokens.input) || 0),
          outputTokens: (state.usage?.outputTokens || 0) + (count(tokens.output) || 0),
        };
      if (event.part?.reason === "stop") state.result = "completed";
    } else return false;
    return true;
  },
  completed: () => false,
};
