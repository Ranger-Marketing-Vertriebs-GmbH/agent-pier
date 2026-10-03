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

/** Presentation evidence only; never changes transport receipts or resend eligibility. */
export function deliveryContentMatches(item, message, exact = false) {
  const equal = (native, sent) =>
    exact
      ? exactly(unwrapped(native)) === exactly(sent)
      : normalized(unwrapped(native)) === normalized(sent);
  if (equal(message?.text || "", item.text)) return true;
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
