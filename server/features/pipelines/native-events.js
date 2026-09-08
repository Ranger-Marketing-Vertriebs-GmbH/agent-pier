const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const message = (value) => (typeof value === "string" ? value.slice(0, 2000) : undefined);
const identity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)
    ? value
    : undefined;

export function reduceNativeEvent(tool, previous, event) {
  const state = { ...previous };
  if (!event || typeof event !== "object") return state;
  const nativeId = identity(
    tool === "codex"
      ? event.thread_id
      : tool === "claude"
        ? event.session_id
        : event.sessionID,
  );
  if (nativeId) {
    if (state.nativeId && state.nativeId !== nativeId)
      return {
        ...state,
        result: "failed",
        error: "Native conversation identity changed during the turn.",
      };
    state.nativeId = nativeId;
  }
  if (state.result === "failed") return state;
  const failed =
    event.type === "error" ||
    event.type === "turn.failed" ||
    (tool === "claude" && event.type === "result" && event.is_error === true);
  if (failed) {
    state.result = "failed";
    const errorCode =
      event.error?.data?.statusCode ?? event.error?.code ?? event.api_error_status;
    if (typeof errorCode === "number" || typeof errorCode === "string")
      state.errorCode = errorCode;
    state.error =
      message(event.error?.data?.message) ||
      message(event.error?.message) ||
      message(event.message) ||
      message(event.errors?.join("; ")) ||
      message(event.subtype) ||
      "The native CLI reported an error.";
    return state;
  }
  if (tool === "opencode" && event.type === "step_finish") {
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
  } else if (
    (tool === "codex" && event.type === "turn.completed") ||
    (tool === "claude" && event.type === "result")
  ) {
    state.result = "completed";
    const usage = event.usage;
    if (
      usage &&
      (count(usage.input_tokens) !== undefined ||
        count(usage.output_tokens) !== undefined)
    )
      state.usage = {
        inputTokens: count(usage.input_tokens) || 0,
        outputTokens: count(usage.output_tokens) || 0,
        ...(typeof event.total_cost_usd === "number" &&
        Number.isFinite(event.total_cost_usd) &&
        event.total_cost_usd >= 0
          ? { costUsd: event.total_cost_usd }
          : {}),
      };
  }
  return state;
}
