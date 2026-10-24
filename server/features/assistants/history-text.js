// OpenClaw's chat.history (2026.10.3 and 2026.10.7) cuts each message text at
// `maxChars` (8000 by default) and marks the cut; a message whose JSON exceeds
// 128 KiB is replaced by a placeholder. Neither marker nor placeholder is ever shown or sent as reply text.
export const historyTextLimit = 65536;
const cutMarker = "\n...(truncated)...";
const placeholder = /^\[chat\.history (?:omitted|unavailable)\b[^\]]*\]$/;

/** The text OpenClaw returned, without its marks, and whether it is incomplete. */
export function historyText(text) {
  if (typeof text !== "string") return { text: "", cut: false };
  if (placeholder.test(text.trim())) return { text: "", cut: true };
  if (text.endsWith(cutMarker))
    return { text: text.slice(0, -cutMarker.length), cut: true };
  return { text, cut: false };
}

/**
 * One assistant message as complete as OpenClaw serves it: the page's text, or,
 * when the page cut it, the message read on its own with the large limit
 * (`assistants.message`). Still incomplete beyond that limit or the size cap.
 */
export async function completeMessage(assistants, conversationId, message) {
  // The chat history serves an incomplete message without OpenClaw's marks: `cut`
  // after its own read, `partial` while that read is still due.
  const page =
    message?.cut === true || message?.partial === true
      ? { text: String(message.text ?? ""), cut: true }
      : historyText(message?.text);
  if (!page.cut || !assistants.message) return page;
  try {
    const alone = historyText(await assistants.message(conversationId, message.id));
    // Only a longer text that continues the page's one is the same message.
    if (alone.text.length > page.text.length && alone.text.startsWith(page.text))
      return alone;
  } catch {
    /* The page's text is what there is. */
  }
  return page;
}

/**
 * A text within `limit` code units, cut by code point; `cut` when anything is
 * missing. OpenClaw cuts by code unit, so a page or single read may end in half a
 * surrogate pair: that half is dropped.
 */
export function boundedText({ text, cut }, limit = historyTextLimit) {
  let kept = "";
  for (const point of text) {
    if (kept.length + point.length > limit) {
      cut = true;
      break;
    }
    kept += point;
  }
  if (cut && /[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return { text: kept, cut: !!cut };
}

/**
 * The reply a run left in a history page, as complete as OpenClaw serves it. Like
 * OpenClaw's own channel reply (2026.10.3, buildEmbeddedRunPayloads), that is the
 * run's last assistant message with text; text it wrote before a tool call is
 * interim commentary, not part of the answer.
 */
export async function runReply(assistants, conversationId, messages, attempt) {
  const message = messages
    .filter(
      (m) =>
        m.role === "assistant" &&
        !!m.runId &&
        [attempt.id, attempt.runtimeRunId].includes(m.runId),
    )
    .at(-1);
  if (!message) return { text: "", cut: false };
  return boundedText(await completeMessage(assistants, conversationId, message));
}

/** Text plus a closing note, within `limit` code units; the note always fits. */
export function withNote(text, note, limit = historyTextLimit) {
  const room = limit - note.length - 2;
  const points = Array.from(text.trimEnd());
  let kept = "";
  for (const point of points) {
    if (kept.length + point.length > room) break;
    kept += point;
  }
  return kept ? `${kept}\n\n${note}` : note;
}
