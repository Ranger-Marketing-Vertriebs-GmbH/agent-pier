import { readOpenCodePage } from "./opencode-history-page.js";
import { reconcileCodexTail } from "./codex-live-tail.js";
import { readClaudePage } from "./claude-history-page.js";
import { normalizeCodex } from "./history-parsers.js";
import { observeCodex } from "./chat-observability.js";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const PAGE_MESSAGES = 50;
export async function readHistoryPage(history, session, id, state = null) {
  if (session.tool === "claude" && !state?.legacy)
    return readClaudePage(history, session, id, state);
  if (session.tool === "opencode" && !state?.legacy) {
    const page = await readOpenCodePage(history, session, id, state);
    if (page) return page;
  }
  if (state?.remaining?.length) return splitPage(state.remaining, state.continuation);
  if (session.tool !== "codex" || state?.legacy)
    return legacyPage(await history.read(session, id), state);
  const { thread } = await history.codexRequest(session, (client) =>
    client.request("thread/read", { threadId: id, includeTurns: false }),
  );
  if (thread?.cwd !== session.cwd)
    throw problem(serverMessages.chat.historyProjectMismatch, 409);
  let page;
  try {
    page = await history.codexRequest(session, (client) =>
      client.request("thread/turns/list", {
        threadId: id,
        limit: 10,
        itemsView: "full",
        sortDirection: "desc",
        ...(state?.cursor ? { cursor: state.cursor } : {}),
      }),
    );
  } catch (error) {
    if (error.status !== 409 || state?.cursor) throw error;
    return legacyPage(await history.read(session, id), state);
  }
  let full = { ...thread, turns: [...(page.data || [])].reverse() };
  if (!state) full = await reconcileCodexTail(history, session, full);
  const content = normalizeCodex(full);
  return {
    ...content,
    observability: {
      ...observeCodex(full),
      ...(full.tailUnavailable ? { stale: true } : {}),
    },
    ...splitPage(content.messages, page.nextCursor ? { cursor: page.nextCursor } : null),
  };
}
function splitPage(messages, continuation) {
  const start = Math.max(0, messages.length - PAGE_MESSAGES);
  return {
    messages: messages.slice(start),
    next: start ? { remaining: messages.slice(0, start), continuation } : continuation,
  };
}

function legacyPage(content, state) {
  const end = state?.before
    ? content.messages.findIndex((message) => message.id === state.before)
    : content.messages.length;
  if (end < 0) throw problem(serverMessages.chat.sessionHistoryMismatch, 409);
  const start = Math.max(0, end - PAGE_MESSAGES);
  return {
    ...content,
    messages: content.messages.slice(start, end),
    next: start ? { before: content.messages[start].id, legacy: true } : null,
  };
}
