const normalized = (text) => text.replaceAll("\r\n", "\n").trim();

/** Presentation evidence only; never changes transport receipts or resend eligibility. */
export function deliveryContentMatches(item, message, exact = false) {
  const equal = (a, b) => (exact ? a === b : normalized(a) === normalized(b));
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
