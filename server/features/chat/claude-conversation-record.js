/** Claude surfaces human messages absorbed mid-turn as queued-command attachments.
 * Queue operations alone are not conversation messages (they may be cancelled).
 */
export function claudeConversationRecord(record) {
  const attachment = record?.attachment;
  if (
    record?.type !== "attachment" ||
    record.isSidechain ||
    attachment?.type !== "queued_command" ||
    attachment.commandMode !== "prompt" ||
    attachment.origin?.kind !== "human" ||
    typeof attachment.source_uuid !== "string" ||
    !attachment.source_uuid ||
    typeof attachment.prompt !== "string" ||
    !attachment.prompt
  )
    return record;
  return {
    ...record,
    type: "user",
    uuid: attachment.source_uuid,
    message: { role: "user", content: attachment.prompt },
  };
}

const LOCAL_COMMAND =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;
const blocks = (record) =>
  Array.isArray(record?.message?.content) ? record.message.content : [];

/** User records Claude writes for task notifications or slash-command output. */
function providerInput(record) {
  if (record.type !== "user") return false;
  if (blocks(record).some((block) => block?.type === "tool_result")) return false;
  const kind = record.origin?.kind;
  if (kind !== undefined && kind !== "human") return true;
  const content = record.message?.content;
  const text =
    typeof content === "string"
      ? content
      : blocks(record).find((block) => block?.type === "text")?.text;
  return typeof text === "string" && LOCAL_COMMAND.test(text);
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
