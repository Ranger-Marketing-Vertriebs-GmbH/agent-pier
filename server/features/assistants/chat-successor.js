import { recordedTurn } from "./goal-turns.js";

/**
 * A chat that a model switch replaced with a fresh one (main-chat-swap.js) names that
 * chat as its `successorId`. Work that reports into the archived chat later (member
 * results, lead-request answers, SSH, SFTP and mail follow-ups, coding hand-overs) is
 * delivered to the newest chat of that line instead (conversation-turns.js). A chat
 * archived by the owner, by Restart main chat or by its deletion has no successor:
 * its late follow-ups stay dropped.
 */

// Far more switches than a chat sees between two late deliveries; the bound and the
// cycle check keep a damaged record from looping.
const longestLine = 20;
const live = (chat) => !chat.archivedAt && !chat.deletedAt;

/**
 * The chat a delivery to `conversationId` goes to: the first unarchived chat along
 * its successors, or the chat itself when the line ends without one (a successor
 * archived without a successor of its own, deleted or missing). An unknown chat is
 * 404, as `storedConversation` answers.
 */
export function successorOf(store, conversationId) {
  const start = store.storedConversation(conversationId);
  const seen = new Set([start.id]);
  let chat = start;
  for (let hop = 0; hop < longestLine && !live(chat) && chat.successorId; hop++) {
    if (seen.has(chat.successorId)) break;
    seen.add(chat.successorId);
    try {
      chat = store.storedConversation(chat.successorId);
    } catch {
      break;
    }
  }
  return live(chat) ? chat : start;
}

/**
 * The live successor's id when `conversationId` is an archived chat with a
 * successor, otherwise null (also for an unknown chat).
 */
export function redirectedTo(store, conversationId) {
  let chat;
  try {
    chat = store.storedConversation(conversationId);
  } catch {
    return null;
  }
  if (!chat.archivedAt || chat.deletedAt || !chat.successorId) return null;
  const next = successorOf(store, conversationId);
  return next.id === chat.id ? null : next.id;
}

/** The chat a delivery to `conversationId` reaches now: its successor or itself. */
export const currentChatId = (store, conversationId) =>
  redirectedTo(store, conversationId) ?? conversationId;

/**
 * Where a follow-up for `asked` goes: `conversationId`, its current chat, and
 * `redirectedFrom` when that is a successor, to send to the old chat, which notes the
 * redirect (sendTurn). `lost` is the turn already accepted under `clientRequestId`
 * (recordedTurn); one the old chat accepted before the switch stays there.
 */
export function followUpChat(teams, store, asked, clientRequestId) {
  if (!asked) return { conversationId: asked, lost: null };
  const there = recordedTurn(teams, asked, clientRequestId);
  const conversationId = there ? asked : currentChatId(store, asked);
  if (conversationId === asked) return { conversationId, lost: there };
  return {
    conversationId,
    redirectedFrom: asked,
    lost: recordedTurn(teams, conversationId, clientRequestId),
  };
}
