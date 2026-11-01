// What a drop into a split view or onto a single view stands for and what it does to
// a layout. Pure apart from `itemForPayload`, which may open an agent's chat.
import { SPLIT_GAP, fits } from "../../components/split-geometry.js";
import { ownerChatsOf, resolveAgentChat } from "../assistants/agent-chat-target.js";
import { MAX_PANES, MIN_PANE, dropItem, movePane, paneCount } from "./split-tree.js";

/**
 * The item a payload stands for while hovering, without side effects: a session or
 * chat item as dragged, an agent's first own chat; null for an agent without a chat
 * yet (its drop opens one) and for a pane payload.
 */
export function hoverItemOf(payload, { assistants, conversations }) {
  if (payload.item) return payload.item;
  if (!payload.agent) return null;
  const { assistantId } = payload.agent;
  const assistant = assistants.find((candidate) => candidate.id === assistantId);
  const chat = assistant && ownerChatsOf(assistant, conversations)[0];
  return chat ? { kind: "chat", assistantId, conversationId: chat.id } : null;
}

/**
 * The item a dropped session or agent payload lands as; an agent without a chat gets
 * one from `open(assistantId)` and the agents list is read again (`refresh`), as a
 * click on its row does.
 */
export async function itemForPayload(
  payload,
  { assistants, conversations, refresh, open },
) {
  if (payload.item) return payload.item;
  const { assistantId } = payload.agent;
  const assistant = assistants.find((candidate) => candidate.id === assistantId) ?? {
    id: assistantId,
  };
  const conversationId = await resolveAgentChat(assistant, {
    conversations,
    open,
    refresh,
  });
  return { kind: "chat", assistantId, conversationId };
}

/**
 * The layout after dropping `payload` on the pane `key` at `side` (`item`: what an item
 * or agent payload lands as), or `layout` itself when the drop changes nothing or is
 * refused: a pane of another view, or an edge drop that would exceed MAX_PANES or not
 * fit `stageSize`.
 */
export function dropResult({ layout, viewId, payload, item, key, side, stageSize }) {
  let next;
  if (payload.pane) {
    if (payload.pane.viewId !== viewId) return layout;
    next = movePane(layout, payload.pane.key, key, side);
  } else next = dropItem(layout, item, key, side);
  if (next === layout || side === "center") return next;
  if (paneCount(next) > MAX_PANES) return layout;
  if (stageSize && !fits(next, stageSize, MIN_PANE, SPLIT_GAP)) return layout;
  return next;
}
