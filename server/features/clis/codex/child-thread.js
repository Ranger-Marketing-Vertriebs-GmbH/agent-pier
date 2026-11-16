import { serverMessages } from "../../../lib/i18n/de.js";
import { problem } from "../../../lib/storage.js";
import { providerId } from "../../chat/history-files.js";
import { normalizeCodex } from "../../chat/history-parsers.js";

const MAX_DEPTH = 4;
const unknownTask = () => problem(serverMessages.chat.taskUnknown, 404);

/** The thread with all its turns: `includeTurns`, or paged `thread/turns/list` when the store is paginated (409). */
export async function readThreadTurns(history, session, id, thread) {
  try {
    return (
      await history.codexRequest(session, (client) =>
        client.request("thread/read", { threadId: id, includeTurns: true }),
      )
    ).thread;
  } catch (error) {
    if (error.status !== 409) throw error;
  }
  // Paginated stores cannot include turns in thread/read.
  const turns = [];
  let cursor;
  do {
    const page = await history.codexRequest(session, (client) =>
      client.request("thread/turns/list", {
        threadId: id,
        limit: 100,
        itemsView: "full",
        sortDirection: "desc",
        ...(cursor ? { cursor } : {}),
      }),
    );
    turns.push(...(page.data || []));
    cursor = page.nextCursor;
  } while (cursor);
  return { ...thread, turns: turns.reverse() };
}

/**
 * A child thread of the session's own thread. The parent chain is walked on the
 * app-server's `parentThreadId` (at most four levels) and must reach `parentId`.
 */
export async function readCodexChild(history, session, parentId, childId) {
  providerId(parentId);
  providerId(childId);
  let child = null;
  let id = childId;
  let reached = false;
  for (let level = 0; level < MAX_DEPTH && !reached; level += 1) {
    const { thread } = await history.codexRequest(session, (client) =>
      client.request("thread/read", { threadId: id, includeTurns: false }),
    );
    if (!thread || thread.id !== id) throw unknownTask();
    child ??= thread;
    if (typeof thread.parentThreadId !== "string") break;
    reached = thread.parentThreadId === parentId;
    id = thread.parentThreadId;
  }
  if (!reached) throw unknownTask();
  if (child.cwd !== session.cwd)
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  // A running child answers with the steps finished so far.
  return {
    ...normalizeCodex(await readThreadTurns(history, session, childId, child)),
    partialWhileRunning: true,
  };
}
