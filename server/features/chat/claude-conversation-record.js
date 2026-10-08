const blocks = (record) =>
  Array.isArray(record?.message?.content) ? record.message.content : [];
const recordText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  const texts = blocks(record).filter((block) => block?.type === "text");
  return texts.length === 1 && typeof texts[0].text === "string" ? texts[0].text : null;
};
// Claude Code 2.1.288+ stores longer bracketed pastes as
// "\n\n<pasted_content id=\"e8ae\">\n" + text + "\n</pasted_content id=\"e8ae\">\n".
// Only that exact shape with the same id at both ends is unwrapped; text that merely
// mentions the tag stays as written. Keep in sync with web/features/chat/delivery-content.js.
const PASTED_CONTENT =
  /\n\n<pasted_content id="([0-9a-f]{1,16})">\n([\s\S]*?)\n<\/pasted_content id="\1">\n/g;
const unwrapClaudePaste = (text) =>
  text.replace(PASTED_CONTENT, (match, _id, inner, offset, whole) => {
    const rest = whole.slice(offset + match.length);
    return `${offset ? "\n" : ""}${inner}${rest && !rest.startsWith("\n") ? "\n" : ""}`;
  });
function unwrapPastes(record) {
  if (record?.type !== "user") return record;
  const content = record.message?.content;
  if (typeof content === "string") {
    const text = unwrapClaudePaste(content);
    return text === content
      ? record
      : { ...record, message: { ...record.message, content: text } };
  }
  if (!Array.isArray(content)) return record;
  let changed = false;
  const next = content.map((block) => {
    if (block?.type !== "text" || typeof block.text !== "string") return block;
    const text = unwrapClaudePaste(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...record, message: { ...record.message, content: next } } : record;
}
const COMMAND_NAME = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

/** A typed slash command or skill is shown as the user typed it: `/review foo`. */
function slashCommand(record) {
  if (record?.type !== "user" || record.isMeta) return record;
  const text = recordText(record);
  const name = typeof text === "string" && COMMAND_NAME.exec(text)?.[1]?.trim();
  if (!name || !/^\s*<command-(name|message|args)>/.test(text)) return record;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim() || "";
  const command = [name.startsWith("/") ? name : `/${name}`, args]
    .filter(Boolean)
    .join(" ");
  return { ...record, message: { ...record.message, content: command } };
}

// A queued prompt with images is an array of text and image blocks only.
const queuedBlocks = (prompt) =>
  Array.isArray(prompt) &&
  prompt.length > 0 &&
  prompt.every(
    (block) =>
      (block?.type === "text" && typeof block.text === "string") ||
      block?.type === "image",
  );
const queuedContent = (prompt) =>
  typeof prompt === "string"
    ? unwrapClaudePaste(prompt)
    : prompt.map((block) =>
        block.type === "text" ? { ...block, text: unwrapClaudePaste(block.text) } : block,
      );

/** Claude surfaces human messages absorbed mid-turn as queued-command attachments.
 * Queue operations alone are not conversation messages (they may be cancelled).
 */
export function claudeConversationRecord(record) {
  // Native API failures are system records, not assistant content blocks.
  // Preserve the provider's explanation (including reset time), not its raw error object.
  if (record?.type === "system" && record.subtype === "api_error") {
    const text = record.error?.error?.message || record.error?.message;
    if (typeof text === "string" && text.trim())
      return {
        ...record,
        type: "assistant",
        isApiErrorMessage: true,
        message: { role: "assistant", content: text },
      };
  }
  const attachment = record?.attachment;
  if (
    record?.type !== "attachment" ||
    record.isSidechain ||
    attachment?.type !== "queued_command" ||
    attachment.commandMode !== "prompt" ||
    attachment.origin?.kind !== "human" ||
    typeof attachment.source_uuid !== "string" ||
    !attachment.source_uuid ||
    !(
      (typeof attachment.prompt === "string" && attachment.prompt) ||
      queuedBlocks(attachment.prompt)
    )
  )
    return slashCommand(unwrapPastes(record));
  const images = Array.isArray(attachment.prompt);
  return {
    ...record,
    type: "user",
    uuid: attachment.source_uuid,
    origin: attachment.origin,
    ...(images && {
      queuedCommand: true,
      imagePasteIds: attachment.imagePasteIds,
    }),
    message: { role: "user", content: queuedContent(attachment.prompt) },
  };
}

// Claude-generated input written as user records (Claude Code 2.1: notifications,
// peer and channel messages, automatic continuations, observer activity). Unknown
// origin kinds stay visible so new user input is never silently dropped.
const GENERATED_ORIGINS = new Set([
  "task-notification",
  "peer",
  "channel",
  "auto-continuation",
  "observer-activity",
  "unclassified",
]);
// Output of local commands, not something the user wrote.
const LOCAL_OUTPUT =
  /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat)>/;

/** User records Claude writes for notifications or local command output. */
function providerInput(record) {
  if (record.type !== "user") return false;
  if (blocks(record).some((block) => block?.type === "tool_result")) return false;
  if (GENERATED_ORIGINS.has(record.origin?.kind)) return true;
  const text = recordText(record);
  return typeof text === "string" && LOCAL_OUTPUT.test(text);
}

/** One visibility rule for live pages, indexed pages and full normalization. */
export function claudeVisibleRecord(record) {
  return Boolean(
    record &&
    ["user", "assistant"].includes(record.type) &&
    !record.isMeta &&
    !record.isCompactSummary &&
    !record.isSidechain &&
    (!record.message?.role || record.message.role === record.type) &&
    !providerInput(record),
  );
}
