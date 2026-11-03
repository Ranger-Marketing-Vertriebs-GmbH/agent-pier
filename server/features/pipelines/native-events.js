import { cliDriver } from "../clis/drivers.js";

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : undefined);
const message = (value) => (typeof value === "string" ? value.slice(0, 2000) : undefined);
const identity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value)
    ? value
    : undefined;

export function reduceNativeEvent(tool, previous, event) {
  const state = { ...previous };
  if (!event || typeof event !== "object") return state;
  const events = cliDriver(tool).pipeline.events;
  const nativeId = identity(events.nativeId(event));
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
    event.type === "error" || event.type === "turn.failed" || events.failed(event);
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
  // OpenCode reports usage and completion per step, the others once per turn.
  if (events.progress(state, event)) {
    // The step changed `state`.
  } else if (events.completed(event)) {
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
