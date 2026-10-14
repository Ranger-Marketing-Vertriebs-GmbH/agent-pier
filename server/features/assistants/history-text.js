// OpenClaw's chat.history (2026.9.9) cuts each message text at `maxChars` (8000 by
// default) and marks the cut; a message whose JSON exceeds 128 KiB is replaced by a
// placeholder. Neither marker nor placeholder is ever shown or sent as reply text.
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
  const page = historyText(message?.text);
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
