// Which agent rows can be dragged into a split view and the chat a dropped agent
// stands for: its first own chat, else a new one opened as a click on its row does.
import { connectionMissing } from "./connection-state.js";

/**
 * The owner's own open chats with an agent, the main chat first, then the most
 * recently active; a user's chat (readable under the user's opt-in) is not the
 * owner's to open here.
 */
export function ownerChatsOf(assistant, conversations) {
  return conversations
    .filter(
      (c) =>
        c.assistantId === assistant.id &&
        !c.archivedAt &&
        (!c.channel || c.channel === "agentpier") &&
        (assistant.userAccess?.mode === "own" || typeof c.userId !== "string"),
    )
    .sort(
      (a, b) =>
        (b.main === true) - (a.main === true) ||
        String(b.lastActivityAt || b.createdAt).localeCompare(
          String(a.lastActivityAt || a.createdAt),
        ),
    );
}

/** Whether an agent row offers its chat to a view (a click on it opens a chat). */
export function paneDraggable(assistant, models) {
  return Boolean(
    assistant &&
    !assistant.teamMemberId &&
    assistant.userAccess?.mode !== "own" &&
    !assistant.archivedAt &&
    !connectionMissing(assistant, models),
  );
}

/** The conversation id a dropped agent stands for. */
export async function resolveAgentChat(assistant, { conversations, open, refresh }) {
  const chat = ownerChatsOf(assistant, conversations)[0];
  if (chat) return chat.id;
  const conversation = await open(assistant.id);
  await refresh();
  return conversation.id;
}
