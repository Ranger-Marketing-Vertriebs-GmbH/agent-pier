import fs from "node:fs/promises";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { inside, providerId, readJsonLines } from "./history-files.js";
import { normalizeClaude } from "./history-parsers.js";

const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const unavailable = () => problem(serverMessages.chat.taskTranscriptUnavailable, 409);

/**
 * One subagent's own transcript, `<project>/<session>/subagents/agent-<id>.jsonl`,
 * read through the main parser. The path derives from the session's transcript
 * file; a link anywhere on it, or a file outside that folder, is refused.
 */
export async function readClaudeSubagent(history, session, nativeId, agentId) {
  providerId(nativeId);
  providerId(agentId);
  const main = await history.claudeFile(session, nativeId);
  const root = path.dirname(main);
  const file = path.join(root, nativeId, "subagents", `agent-${agentId}.jsonl`);
  let records;
  try {
    await inside(file, root);
    if (!(await fs.lstat(file)).isFile()) throw unavailable();
    records = await readJsonLines(file, undefined, READ_FLAGS);
  } catch {
    throw unavailable();
  }
  // The file mixes its own records with request diagnostics the chat never shows.
  return normalizeClaude(
    records
      .filter(
        (record) =>
          record?.isSidechain === true &&
          record.agentId === agentId &&
          !String(record.type).startsWith("api-request"),
      )
      .map((record) => ({ ...record, isSidechain: false })),
  );
}
