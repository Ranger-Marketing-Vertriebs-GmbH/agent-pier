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
  const line = successorLine(store, conversationId);
  const last = line.at(-1);
  return live(last) ? last : line[0];
}

// The chat and its successors up to the first live one, bounded and cycle-checked.
function successorLine(store, conversationId) {
  const line = [store.storedConversation(conversationId)];
  const seen = new Set([line[0].id]);
  for (let hop = 0; hop < longestLine; hop++) {
    const chat = line.at(-1);
    if (live(chat) || !chat.successorId || seen.has(chat.successorId)) break;
    seen.add(chat.successorId);
    try {
      line.push(store.storedConversation(chat.successorId));
    } catch {
      break;
    }
  }
  return line;
}

/**
 * The first chat along `conversationId`'s line whose ledger already accepted
 * `clientRequestId`, or null: a delivery accepted in a chat that was switched again
 * before its bookkeeping was written is adopted there, never sent a second time (the
 * ledger dedupes per chat only).
 */
export function acceptingChat(store, ledger, conversationId, clientRequestId) {
  let line;
  try {
    line = successorLine(store, conversationId);
  } catch {
    return null;
  }
  const found = line.find((chat) =>
    ledger.requests(chat.id).some((r) => r.clientRequestId === clientRequestId),
  );
  return found?.id ?? null;
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
 * (recordedTurn) in the first chat of the line that holds it (acceptingChat), which
 * then stays the target.
 */
export function followUpChat(teams, store, asked, clientRequestId) {
  if (!asked) return { conversationId: asked, lost: null };
  const holder = acceptingChat(store, teams.ledger, asked, clientRequestId);
  const conversationId = holder ?? currentChatId(store, asked);
  return {
    conversationId,
    ...(conversationId !== asked && { redirectedFrom: asked }),
    lost: holder ? recordedTurn(teams, holder, clientRequestId) : null,
  };
}
