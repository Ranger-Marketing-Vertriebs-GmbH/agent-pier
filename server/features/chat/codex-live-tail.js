import { JsonlHistoryReader } from "./jsonl-history-reader.js";

// A resumed Codex writer can append complete items to the rollout while its
// paginated history index still ends at the pre-resume turn. Reconcile only the
// suffix through the newest indexed turn, without reading the old conversation.
export async function reconcileCodexTail(history, session, thread) {
  if (!thread.path || !history.codexRolloutIdentity) return thread;
  try {
    return await readTail(history, session, thread);
  } catch {
    // A missing/replaced/oversized supplemental source must not hide API history.
    return { ...thread, tailUnavailable: true };
  }
}
async function readTail(history, session, thread) {
  const reader = await JsonlHistoryReader.open(thread.path);
  try {
    if ((await history.codexRolloutIdentity(session, thread.path)) !== thread.id)
      return { ...thread, tailUnavailable: true };
    const anchor = thread.turns?.at(-1)?.id;
    let anchored = !anchor;
    const records = [];
    for await (const { record } of reader.backwards()) {
      if (record.type !== "event_msg") continue;
      const payload = record.payload;
      if (!payload?.turn_id) continue;
      if (payload.thread_id && payload.thread_id !== thread.id) continue;
      if (
        ["item_completed", "task_started", "task_complete", "turn_aborted"].includes(
          payload.type,
        )
      )
        records.push(payload);
      if (anchor && payload.type === "task_started" && payload.turn_id === anchor) {
        anchored = true;
        break;
      }
    }
    await reader.validate();
    if (!anchored) return { ...thread, tailUnavailable: true };
    const turns = new Map(
      (thread.turns || []).map((turn) => [
        turn.id,
        { ...turn, items: [...(turn.items || [])] },
      ]),
    );
    for (const event of records.toReversed()) {
      let turn = turns.get(event.turn_id);
      if (!turn) {
        turn = { id: event.turn_id, items: [], status: "inProgress" };
        turns.set(turn.id, turn);
      }
      if (event.type === "task_complete") turn.status = "completed";
      if (event.type === "turn_aborted") turn.status = "interrupted";
      if (event.type === "task_started") turn.status = "inProgress";
      if (event.type !== "item_completed") continue;
      const item = nativeItem(event.item);
      if (!item) continue;
      const index = turn.items.findIndex((existing) => existing.id === item.id);
      if (index < 0) turn.items.push(item);
      else turn.items[index] = { ...turn.items[index], ...item };
    }
    return { ...thread, turns: [...turns.values()] };
  } finally {
    await reader.close();
  }
}

function nativeItem(item) {
  if (!item?.id || typeof item.type !== "string") return null;
  const type = item.type[0].toLowerCase() + item.type.slice(1);
  const result = { ...item, type };
  for (const [key, value] of Object.entries(item))
    if (key !== "type")
      result[key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
  if (type === "agentMessage")
    result.text = (item.content || []).map((part) => part.text || "").join("\n");
  if (type === "commandExecution" && Array.isArray(item.command))
    result.command = item.command.join(" ");
  if (typeof result.status === "string")
    result.status = result.status[0].toLowerCase() + result.status.slice(1);
  return result;
}
