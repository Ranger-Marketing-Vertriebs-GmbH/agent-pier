const replyText = (text) => String(text).replace(/\r\n?/g, "\n").trim();

/**
 * Whether the history already shows the streamed reply. The stream bubble lives only
 * in the browser, and history refreshes while the attempt is still unresolved can
 * already contain the stored reply. A reply counts when it belongs to the same run
 * (the delta's run or the latest attempt) and its text ends the streamed text, so an
 * earlier reply of a tool-using run keeps the live stream visible.
 */
export function streamInHistory(stream, history) {
  if (!stream?.text) return false;
  const attempt = history.requests?.at(-1)?.attempt;
  const runs = [stream.runId, attempt?.id, attempt?.runtimeRunId].filter(Boolean);
  if (!runs.length) return false;
  const streamed = replyText(stream.text);
  return history.messages.some((m) => {
    if (m.role !== "assistant" || !runs.includes(m.runId)) return false;
    const stored = replyText(m.text);
    return Boolean(stored) && streamed.endsWith(stored);
  });
}
