// OpenClaw's chat.history (2026.10.3) cuts each message text at `maxChars` (8000 by
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
  // The chat history marks a message it could not complete with `cut` instead.
  const page =
    message?.cut === true
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

// How many cut messages one history page reads on its own, and how many at once.
export const pageCompletions = 8;
const parallelReads = 4;
const continues = (page, text) =>
  typeof text === "string" &&
  text.length > page.text.length &&
  text.startsWith(page.text);

/**
 * A history page's messages as complete as OpenClaw serves them. A message the page
 * cut keeps an earlier completion of the same id (`known`), or is read on its own
 * (`read(id)`: its text, or null when the Gateway does not serve it), newest first and
 * at most `pageCompletions` per page. The result is what the cache keeps: a completed
 * text; a text still incomplete after its read, without OpenClaw's marker and with
 * `cut: true`; or, when no read was done, the page's text, so a later page reads it.
 * `withoutMarks` turns the last kind into the served one.
 */
export async function completePage(messages, { known = new Map(), read }) {
  const pages = messages.map((m) => historyText(m.text));
  const result = messages.map((m, i) => {
    const page = pages[i];
    if (!page.cut) return m;
    const prior = known.get(m.id);
    const kept =
      typeof prior?.text === "string" &&
      !historyText(prior.text).cut &&
      (continues(page, prior.text) || (prior.cut === true && prior.text === page.text));
    return kept
      ? { ...m, text: prior.text, ...(prior.cut === true && { cut: true }) }
      : null;
  });
  const pending = result
    .map((m, i) => (m ? -1 : i))
    .filter((i) => i >= 0)
    .reverse()
    .slice(0, pageCompletions);
  let next = 0;
  const work = async () => {
    while (next < pending.length) {
      const i = pending[next++];
      let alone;
      try {
        alone = historyText(await read(messages[i].id));
      } catch {
        continue; // Read again on a later page.
      }
      result[i] = continues(pages[i], alone.text)
        ? { ...messages[i], text: alone.text, ...(alone.cut && { cut: true }) }
        : { ...messages[i], text: pages[i].text, cut: true };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallelReads, pending.length) }, work),
  );
  return result.map((m, i) => m ?? messages[i]);
}

/** Messages as served: OpenClaw's marks become `cut: true`. */
export function withoutMarks(messages) {
  return messages.map((m) => {
    if (typeof m.text !== "string") return m;
    const shown = historyText(m.text);
    return shown.cut ? { ...m, text: shown.text, cut: true } : m;
  });
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
