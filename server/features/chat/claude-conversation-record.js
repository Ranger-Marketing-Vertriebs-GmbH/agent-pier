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
