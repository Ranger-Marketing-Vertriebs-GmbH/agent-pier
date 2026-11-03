// Account transfer of one Codex thread (see docs/coding-clis.md, `transfer`).
// `fail(key)` throws the session transfer problem named `key`.
import path from "node:path";

export async function locate({ history, session, id, fail }) {
  const client = history.codex(session);
  const { thread } = await client.request("thread/read", {
    threadId: id,
    includeTurns: false,
  });
  if (thread?.id !== id || thread?.cwd !== session.cwd || !thread.path)
    throw fail("notTransferable");
  const historyMode = thread.historyMode || "legacy";
  if (!["legacy", "paginated"].includes(historyMode))
    throw fail("codexStorageUnsupported");
  return { file: thread.path, historyMode };
}

export const safePath = (relative, file, id) =>
  /^(sessions|archived_sessions)\//.test(relative) &&
  path.basename(file).endsWith(`-${id}.jsonl`);

export const destination = (entry) => entry.replace(/^archived_sessions\//, "sessions/");

export const companions = () => [];

export function validator({ session, id, historyMode, fail }) {
  let meta,
    ordinal = 0;
  return {
    record(record) {
      if (!meta && record.type === "session_meta") meta = record.payload;
      if (historyMode === "paginated" && record.ordinal !== ordinal)
        throw fail("notPortable");
      ordinal++;
    },
    finish() {
      if ((meta?.id || meta?.sessionId) !== id || meta.cwd !== session.cwd)
        throw fail("identityMismatch");
      if ((meta.history_mode || "legacy") !== historyMode) throw fail("notPortable");
    },
  };
}
