import { publicMessages } from "./conversations.js";
import { dreamMessageLimit } from "./hermes-dream-prompt.js";

/*
 * The chats a Hermes agent's nightly dream reads (hermes-dreams.js): every chat of the
 * agent, a shared agent's users' chats included, that is not deleted and was active
 * since the cursor, read through the runtime's sessions.history. Only the people's and
 * the agent's own turns go in, never a turn the runtime made itself.
 */

const pageSize = 200;
// A chat's activity mark is written by AgentPier, its messages' times by the runtime:
// a chat marked a little before the cursor is read anyway.
const activitySlackMs = 5 * 60000;

const clip = (text) => [...text].slice(0, dreamMessageLimit).join("");

const activeSince = (conversation, since) => {
  const at = Date.parse(conversation.lastActivityAt ?? "");
  return Number.isFinite(at) && at >= since - activitySlackMs;
};

// The chat's messages after `since`, oldest first, read page by page from the newest.
async function messagesSince(sessions, conversation, since) {
  const found = [];
  for (let offset = 0; ;) {
    const page = await sessions.history({
      sessionKey: conversation.runtimeSessionKey,
      limit: pageSize,
      offset,
      // Units, not code points: twice the clip holds at least the clipped text.
      maxChars: dreamMessageLimit * 2,
    });
    const rows = page?.messages ?? [];
    const messages = publicMessages(rows);
    found.unshift(...messages.filter((m) => m.timestamp > since));
    if (!page?.hasMore || !rows.length || messages.some((m) => m.timestamp <= since))
      return found;
    offset += rows.length;
  }
}

/**
 * The agent's chats since `since` (ms) as the dream's `Chat`s (hermes-dream-prompt.js):
 * `{ chats: [{ channel, messages: [{ role, text, at }] }], until }`. Messages go in
 * oldest first across all chats, each clipped to dreamMessageLimit, while fewer than
 * `budget` code points went in before them, and are then grouped by chat in the
 * order of their first message. `until` is the `at` of the newest message that went
 * in (null with none), so what did not fit is read the next night.
 */
export async function dreamChats({ store, sessions, assistantId, since, budget }) {
  const read = [];
  for (const conversation of store.listConversations()) {
    if (
      conversation.assistantId !== assistantId ||
      conversation.deletedAt ||
      // A deleted user's chat is never read back (user-release.js).
      conversation.userReleased ||
      !activeSince(conversation, since)
    )
      continue;
    let messages;
    try {
      messages = await messagesSince(sessions, conversation, since);
    } catch (error) {
      // A session the runtime no longer knows has nothing to read; anything else
      // fails the night, so no chat is skipped behind the cursor.
      if (error?.answered) continue;
      throw error;
    }
    for (const m of messages)
      read.push({
        chat: conversation,
        message: {
          role: m.role === "assistant" ? "agent" : "person",
          text: clip(m.text),
          at: m.timestamp,
        },
      });
  }
  // Stable: equal times keep their chat's and their own order.
  read.sort((a, b) => a.message.at - b.message.at);
  const groups = new Map();
  let used = 0;
  let until = null;
  for (const { chat, message } of read) {
    if (used >= budget) break;
    used += [...message.text].length;
    until = message.at;
    if (!groups.has(chat.id))
      groups.set(chat.id, { channel: chat.channel, messages: [] });
    groups.get(chat.id).messages.push(message);
  }
  return { chats: [...groups.values()], until };
}
