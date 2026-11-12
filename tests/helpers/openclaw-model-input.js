// OpenClaw 2026.11.2 sends its runtime context (interrupted inputs, the time zone) as
// a user message of its own after the turn's text ("OpenClaw runtime context:"). The
// scripted model servers decide by the turn's own text, so they skip it.
const contextStart = "OpenClaw runtime context:";
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text || "").join("")
      : "";

/** Whether a model message is OpenClaw's runtime context, not a turn's text. */
export const runtimeContext = (message) =>
  message?.role === "user" && textOf(message.content).startsWith(contextStart);

/** The index of the newest user message that is a turn's own text, or -1. */
export const lastUserIndex = (messages = []) =>
  messages.findLastIndex((m) => m.role === "user" && !runtimeContext(m));

/** The newest user message that is a turn's own text. */
export const lastUser = (messages = []) => messages[lastUserIndex(messages)];
