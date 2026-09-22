const blocks = (record) =>
  Array.isArray(record?.message?.content) ? record.message.content : [];
const recordText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  const texts = blocks(record).filter((block) => block?.type === "text");
  return texts.length === 1 && typeof texts[0].text === "string" ? texts[0].text : null;
};
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
    return slashCommand(record);
  return {
    ...record,
    type: "user",
    uuid: attachment.source_uuid,
    message: { role: "user", content: attachment.prompt },
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
