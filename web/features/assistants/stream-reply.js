const replyText = (text) => String(text).replace(/\r\n?/g, "\n").trim();

/**
 * Whether the history already shows the streamed reply. The stream bubble lives only
 * in the browser, and history refreshes while the attempt is still unresolved can
 * already contain the stored reply. A reply counts when it belongs to the same run
 * (the delta's run or the latest attempt) and either the stream has not caught up with
 * it yet (the stored text starts with the streamed text) or it is the run's newest reply
 * (it ends the streamed text). An earlier reply of a tool-using run therefore keeps a
 * diverging live stream visible; a very short stream that happens to prefix such an
 * earlier reply stays hidden until it diverges.
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
    return Boolean(stored) && (stored.startsWith(streamed) || streamed.endsWith(stored));
  });
}

/**
 * The reply so far after a feed `stream` frame ({runId, from, text}): `from: 0` is the
 * whole text, any other `from` appends where the held text ends. Null when the frame
 * does not fit what is held; the feed then reconnects and sends the whole text again.
 */
export function nextStream(current, frame) {
  if (
    typeof frame?.runId !== "string" ||
    typeof frame.text !== "string" ||
    !Number.isInteger(frame.from) ||
    frame.from < 0
  )
    return null;
  if (frame.from === 0) return { runId: frame.runId, text: frame.text };
  if (current?.runId !== frame.runId || current.text.length !== frame.from) return null;
  return { runId: frame.runId, text: current.text + frame.text };
}
