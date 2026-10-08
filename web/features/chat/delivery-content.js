// Claude Code 2.1.288+ wraps longer bracketed pastes in its transcript. The server
// unwraps them; this copy covers rows cached before that (see claude-conversation-record.js).
const PASTED_CONTENT =
  /\n\n<pasted_content id="([0-9a-f]{1,16})">\n([\s\S]*?)\n<\/pasted_content id="\1">\n/g;
const unwrapped = (text) =>
  text.replace(PASTED_CONTENT, (match, _id, inner, offset, whole) => {
    const rest = whole.slice(offset + match.length);
    return `${offset ? "\n" : ""}${inner}${rest && !rest.startsWith("\n") ? "\n" : ""}`;
  });
const normalized = (text) => text.replaceAll("\r\n", "\n").trim();
// Exact evidence tolerates only the trailing whitespace Claude trims from a prompt.
const exactly = (text) => text.trimEnd();

const words = (text) => text.replace(/\s+/g, " ").trim();
const time = (value) => (typeof value === "number" ? value : Date.parse(value));

// A queued Claude image prompt has no path evidence (see claude-image-history.js).
// It matches only the same image count and, with Claude's labels and the composer's
// path lines removed, the same authored words.
function queuedImagesMatch(item, input) {
  const attachments = item.attachments;
  if (
    typeof input.text !== "string" ||
    !Number.isSafeInteger(input.count) ||
    !Array.isArray(attachments) ||
    !attachments.length ||
    attachments.length !== input.count
  )
    return false;
  const lines = item.text.replaceAll("\r\n", "\n").split("\n");
  const tail = lines.slice(-attachments.length);
  return (
    lines.length >= attachments.length &&
    attachments.every((attachment, i) => tail[i] === attachment.path) &&
    words(lines.slice(0, -attachments.length).join("\n")) === words(input.text)
  );
}

/**
 * A queued image row counts only for a delivery started before it, and only when
 * neither another delivery nor another fresh row could be the same message.
 */
export function queuedImagesUnique(item, message, items, messages) {
  const startedAt = item.observation?.startedAt;
  const fresh = (delivery, row) =>
    !delivery.baselineIds.includes(row.id) &&
    Number.isFinite(delivery.observation?.startedAt) &&
    time(row.timestamp) >= delivery.observation.startedAt;
  return (
    Number.isFinite(startedAt) &&
    fresh(item, message) &&
    !items.some(
      (other) =>
        other.id !== item.id &&
        (!other.matchedMessageId || other.matchedMessageId === message.id) &&
        !other.baselineIds.includes(message.id) &&
        deliveryContentMatches(other, message, true),
    ) &&
    !messages.some(
      (other) =>
        other.id !== message.id &&
        other.role === "user" &&
        other.claudeImageInput &&
        fresh(item, other) &&
        deliveryContentMatches(item, other, true),
    )
  );
}

/** Presentation evidence only; never changes transport receipts or resend eligibility. */
export function deliveryContentMatches(item, message, exact = false) {
  const equal = (native, sent) =>
    exact
      ? exactly(unwrapped(native)) === exactly(sent)
      : normalized(unwrapped(native)) === normalized(sent);
  if (equal(message?.text || "", item.text)) return true;
  if (message?.claudeImageInput) return queuedImagesMatch(item, message.claudeImageInput);
  const input = message?.imageInput;
  const attachments = item.attachments;
  if (
    !input ||
    typeof input.text !== "string" ||
    !Array.isArray(input.paths) ||
    !Array.isArray(attachments) ||
    !attachments.length ||
    attachments.length !== input.paths.length ||
    attachments.some((attachment, i) => !input.paths[i].includes(attachment.path))
  )
    return false;
  const reconstructed = [input.text, ...attachments.map((attachment) => attachment.path)]
    .filter(Boolean)
    .join("\n");
  return equal(reconstructed, item.text);
}
