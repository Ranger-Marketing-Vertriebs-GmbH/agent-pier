import { createHash } from "node:crypto";
import { publicMessages } from "./conversations.js";
import { turnKind } from "./goal-turns.js";
import { dreamBudget, dreamMessageLimit } from "./hermes-dream-prompt.js";

/*
 * The chats a Hermes agent's nightly dream reads (hermes-dreams.js): every chat of the
 * agent, a shared agent's users' chats included, that is not deleted and was active
 * since the cursor, read through the runtime's sessions.history. Only the people's and
 * the agent's own turns go in: never a turn the runtime made itself, nor one AgentPier
 * submitted (a result, a check-in, a lead's task; its request's trusted context names
 * no person). Each chat names its person: the owner, or a user by an opaque label.
 */

/**
 * What the chats of one night may take, in code points: a message goes in while less
 * went in before it, so the whole stays within dreamBudget and the dream's input
 * (hermes-dream-prompt.js chatsInput) never cuts a message chosen here.
 */
export const dreamChatBudget = dreamBudget - dreamMessageLimit;

const pageSize = 200;
const size = (text) => [...text].length;
// A chat's activity mark is written by AgentPier, its messages' times by the runtime:
// a chat marked a little before the cursor is read anyway.
const activitySlackMs = 5 * 60000;

const clip = (text) => [...text].slice(0, dreamMessageLimit).join("");

// The trusted contexts of the turns people write (conversation-open.js,
// message-source.js).
const personKinds = new Set(["owner", "user", "telegram"]);

/** The chat's person for the dream: "owner", or a stable opaque label of its user. */
export function dreamPerson(conversation) {
  if (typeof conversation.userId !== "string") return "owner";
  const hash = createHash("sha256")
    .update(`${conversation.assistantId}:${conversation.userId}`)
    .digest("hex");
  return `user-${hash.slice(0, 8)}`;
}

/**
 * Whether a user turn of the chat is a person's words, matched to its request as the
 * chat matches it (conversations.js hideInternal): by its delivery key, else by text.
 * A turn of a request whose context names no person is AgentPier's. Without a ledger
 * every turn counts.
 */
function personTurns(conversation, { ledger, contextOf }) {
  if (!ledger) return () => true;
  const requests = ledger.requests(conversation.id);
  const attempts = ledger.attemptRequests(conversation.id);
  const byId = new Map(requests.map((r) => [r.id, r]));
  // A request with no recorded context is read as the chat reads it: a person's.
  const person = (request) => {
    const context = contextOf(request.id);
    return !context || personKinds.has(turnKind(context));
  };
  const foreign = requests.filter(
    (r) => typeof r.text === "string" && r.text && !person(r),
  );
  return (m) => {
    if (m.turnKey && attempts.has(m.turnKey)) {
      const request = byId.get(attempts.get(m.turnKey));
      return !request || person(request);
    }
    return !foreign.some((r) => m.text === r.text || m.text.endsWith(r.text));
  };
}

const activeSince = (conversation, since) => {
  const at = Date.parse(conversation.lastActivityAt ?? "");
  return Number.isFinite(at) && at >= since - activitySlackMs;
};

// The chat's messages after `since`, oldest first, read page by page from the newest.
async function messagesSince(sessions, conversation, since, isPerson) {
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
    found.unshift(
      ...messages.filter(
        (m) => m.timestamp > since && (m.role !== "user" || isPerson(m)),
      ),
    );
    if (!page?.hasMore || !rows.length || messages.some((m) => m.timestamp <= since))
      return found;
    offset += rows.length;
  }
}

/**
 * The agent's chats since `since` (ms) as the dream's `Chat`s (hermes-dream-prompt.js):
 * `{ chats: [{ channel, person, messages: [{ role, text, at }] }], until }`, `person`
 * as dreamPerson names it. `ledger` and `contextOf(requestId)` (the trusted context of
 * a request, team-store.js) leave out the turns AgentPier submitted. Messages go in
 * oldest first across all chats, each clipped to dreamMessageLimit, while fewer than
 * `budget` code points went in before them, and are then grouped by chat in the
 * order of their first message. The cut falls between two times, never inside a
 * group of messages with the same `at` (a first group larger than the budget goes in
 * whole). `until` is the `at` of the newest message that went in (null with none),
 * so what did not fit is read the next night (`at > until`).
 */
export async function dreamChats({
  store,
  sessions,
  ledger,
  contextOf = () => null,
  assistantId,
  since,
  budget,
}) {
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
      messages = await messagesSince(
        sessions,
        conversation,
        since,
        personTurns(conversation, { ledger, contextOf }),
      );
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
  let end = 0;
  for (let used = 0; end < read.length && used < budget; end++)
    used += size(read[end].message.text);
  const at = (i) => read[i].message.at;
  if (end < read.length) {
    // Back to the start of a group of equal times the budget cut through.
    let start = end;
    while (start > 0 && at(start - 1) === at(end)) start--;
    if (start > 0) end = start;
    else while (end < read.length && at(end) === at(0)) end++;
  }
  const groups = new Map();
  for (const { chat, message } of read.slice(0, end)) {
    if (!groups.has(chat.id))
      groups.set(chat.id, {
        channel: chat.channel,
        person: dreamPerson(chat),
        messages: [],
      });
    groups.get(chat.id).messages.push(message);
  }
  return { chats: [...groups.values()], until: end ? at(end - 1) : null };
}
