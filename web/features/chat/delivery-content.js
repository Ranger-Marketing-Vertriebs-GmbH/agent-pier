// Claude Code 2.1.288+ wraps longer bracketed pastes in its transcript. The server
// unwraps them; this copy covers rows cached before that (see claude-conversation-record.js).
const PASTED_CONTENT =
  /\n\n<pasted_content id="([0-9a-f]{1,16})">\n([\s\S]*?)\n<\/pasted_content id="\1">\n/g;
const unwrapped = (text) =>
  text.replace(PASTED_CONTENT, (match, _id, inner, offset, whole) => {
    const rest = whole.slice(offset + match.length);
    return `${offset ? "\n" : ""}${inner}${rest && !rest.startsWith("\n") ? "\n" : ""}`;
  });
// Claude bash mode: the server shows "<bash-input> ls</bash-input>" as "! ls"; this
// copy covers rows cached before that. `!ls` and `! ls` are the same command.
const bashInput = (text) => {
  const trimmed = text.trim();
  return trimmed.startsWith("<bash-input>") && trimmed.endsWith("</bash-input>")
    ? `! ${trimmed.slice("<bash-input>".length, -"</bash-input>".length).trim()}`
    : text;
};
const bang = (text) => text.replace(/^\s*!\s*/, "! ");
const normalized = (text) => text.replaceAll("\r\n", "\n").trim();
// Exact evidence tolerates only the trailing whitespace Claude trims from a prompt.
const exactly = (text) => text.trimEnd();

const words = (text) => text.replace(/\s+/g, " ").trim();
// The image files the server pastes as chips (claude-image-paste.js): absolute paths.
const IMAGE = /^\/.*\.(?:png|jpe?g|gif|webp)$/i;
// The sent text without one path line per image: what follows the chips natively.
function withoutLines(text, images) {
  const left = images.map((image) => image.path);
  const kept = text.split("\n").filter((line) => {
    const index = left.indexOf(line.trim());
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
  return kept.join("\n");
}
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
      ? exactly(bang(bashInput(unwrapped(native)))) === exactly(bang(sent))
      : normalized(bang(bashInput(unwrapped(native)))) === normalized(bang(sent));
  if (equal(message?.text || "", item.text)) return true;
  if (message?.claudeImageInput) return queuedImagesMatch(item, message.claudeImageInput);
  const input = message?.imageInput;
  // Only image attachments become chips; other files stay path lines of the text.
  const images = Array.isArray(item.attachments)
    ? item.attachments.filter((attachment) => IMAGE.test(attachment.path))
    : [];
  if (
    !input ||
    typeof input.text !== "string" ||
    !Array.isArray(input.paths) ||
    !images.length ||
    images.length !== input.paths.length ||
    images.some((image, i) => !input.paths[i].includes(image.path))
  )
    return false;
  return equal(input.text, withoutLines(item.text, images));
}
