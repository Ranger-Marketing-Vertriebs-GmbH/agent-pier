// Account transfer of one Claude Code conversation (see docs/coding-clis.md,
// `transfer`). `fail(key)` throws the session transfer problem named `key`.
import path from "node:path";

export async function locate({ history, session, id }) {
  return { file: await history.claudeFile(session, id), historyMode: undefined };
}

export const safePath = (relative, file, id) =>
  relative.startsWith(`projects${path.sep}`) && path.basename(file) === `${id}.jsonl`;

export const destination = (entry) => entry;

export const companions = (relative, id) => [
  relative.slice(0, -6),
  path.join("file-history", id),
];

export function validator({ session, id, fail }) {
  let meta;
  return {
    record(record) {
      if (!meta && record.sessionId && record.cwd && !record.isSidechain) meta = record;
    },
    finish() {
      if ((meta?.id || meta?.sessionId) !== id || meta.cwd !== session.cwd)
        throw fail("identityMismatch");
    },
  };
}
