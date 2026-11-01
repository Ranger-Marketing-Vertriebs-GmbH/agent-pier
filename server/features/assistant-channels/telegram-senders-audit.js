// The audit trail of agents' own Telegram bots (telegram-senders.js).

/**
 * One audit record per change of an agent's bot (`before`, `after`: its stored
 * records, null when there was or is none); never a token, an id or a name.
 */
export function recordSenderChange(
  audit,
  assistantId,
  before,
  after,
  { token = false } = {},
) {
  const changes = [];
  if (!before) changes.push(["connected", after.people.length]);
  else if (!after) changes.push(["disconnected", before.people.length]);
  else {
    if (before.botId !== after.botId) changes.push(["botReplaced", 0]);
    else if (token) changes.push(["tokenReplaced", 0]);
    const ids = (list) => new Set(list.map((p) => p.id));
    const was = ids(before.people),
      now = ids(after.people);
    const added = [...now].filter((id) => !was.has(id)).length;
    const removed = [...was].filter((id) => !now.has(id)).length;
    if (added) changes.push(["peopleAdded", added]);
    if (removed) changes.push(["peopleRemoved", removed]);
    if (!changes.length) changes.push(["updated", 0]);
  }
  for (const [telegram, count] of changes)
    try {
      audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: assistantId,
        source: "user",
        outcome: "success",
        details: { kind: "telegram", telegram, count },
      });
    } catch (error) {
      console.error("Telegram sender audit failed:", error?.message);
    }
}
