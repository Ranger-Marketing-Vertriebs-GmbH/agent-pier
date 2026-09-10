import { normalizeClaude } from "./history-parsers.js";
import { observeClaude } from "./claude-observability.js";
import { JsonlHistoryReader } from "./jsonl-history-reader.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const LIMIT = 50;
const key = (record) => record.message?.id || record.uuid;

export async function readClaudePage(history, session, id, state) {
  let file;
  try {
    file = await history.claudeFile(session, id);
  } catch (error) {
    if (state) throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    throw error;
  }
  const reader = await JsonlHistoryReader.open(file, state?.identity);
  try {
    const metadata = await reader.metadata();
    if (metadata.cwd !== session.cwd || metadata.sessionId !== id)
      throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
    const indexed = await history.claudePages?.read(session, id, reader, state);
    if (indexed) return indexed;
    if (state?.remaining?.length) {
      await reader.validate();
      return split(state.remaining, state.end, reader.identity);
    }
    const records = [],
      pendingResults = new Set();
    let end = state?.end ?? reader.identity.size;
    let stopped = false;
    let oldestKey,
      content = { messages: [], tasks: [] };
    for await (const item of reader.backwards(end, Boolean(state))) {
      const { record } = item;
      if (!record.uuid && !record.message?.id) record.uuid = `claude-byte:${item.start}`;
      const visible =
        ["assistant", "user"].includes(record.type) &&
        !record.isMeta &&
        !record.isCompactSummary;
      if (visible && key(record) !== oldestKey)
        content = normalizeClaude(records.toReversed());
      // Do not cut through streamed fragments of one assistant message or leave
      // a tool result detached from its call in the preceding source range.
      if (
        visible &&
        content.messages.length >= LIMIT &&
        (!pendingResults.size || content.messages.length >= LIMIT * 2) &&
        key(record) !== oldestKey
      ) {
        stopped = true;
        break;
      }
      records.push(record);
      end = item.start;
      if (visible) {
        oldestKey = key(record);
        for (const block of Array.isArray(record.message?.content)
          ? record.message.content
          : []) {
          if (block?.type === "tool_result" && block.tool_use_id)
            pendingResults.add(block.tool_use_id);
          if (block?.type === "tool_use" && block.id) pendingResults.delete(block.id);
        }
      }
    }
    if (!stopped) end = 0;
    const ordered = records.toReversed();
    content = normalizeClaude(ordered);
    await reader.validate();
    if (!state) history.claudePages?.warm(session, id, reader.identity);
    return {
      ...content,
      indexing: history.claudePages?.warming(session, id, reader.identity) || false,
      observability: { ...observeClaude(ordered), stale: end > 0 },
      ...split(content.messages, end, reader.identity),
    };
  } finally {
    await reader.close();
  }
}
function split(messages, end, identity) {
  const start = Math.max(0, messages.length - LIMIT);
  return {
    messages: messages.slice(start),
    next:
      start || end > 0
        ? { identity, end, ...(start ? { remaining: messages.slice(0, start) } : {}) }
        : null,
  };
}
