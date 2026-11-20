const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value) => (typeof value === "string" ? value : "");

/**
 * The error OpenCode stored on an assistant message (`info.error`, often without any
 * part): a provider's refusal, an auth failure, a context overflow. Shown as a failed
 * reply with the `provider-error` notice; a reply the owner stopped stays quiet.
 */
export function openCodeErrorMessage(info) {
  const error = object(info?.error);
  if (info?.role !== "assistant" || !string(error.name)) return null;
  if (error.name === "MessageAbortedError") return null;
  const text = string(error.data?.message) || string(error.message) || error.name;
  const time = info.time?.completed ?? info.time?.created;
  return {
    id: `opencode-error:${typeof info.id === "string" || typeof info.id === "number" ? info.id : ""}`,
    role: "assistant",
    text,
    status: "failed",
    notice: "provider-error",
    ...(typeof time === "string" || typeof time === "number" ? { timestamp: time } : {}),
  };
}
