// Items of a split view and the single-view routes they correspond to, and the click
// rule: a click on an item never replaces a pane.
import { findPane, itemKey } from "./split-tree.js";

/** The item a single-view route shows, or null (a team task is not a pane item). */
export function itemFromRoute(route) {
  if (route?.view === "workspace" && route.sessionId)
    return { kind: "session", id: route.sessionId };
  if (
    route?.view === "agents" &&
    route.assistantId &&
    route.conversationId &&
    !route.teamId
  )
    return {
      kind: "chat",
      assistantId: route.assistantId,
      conversationId: route.conversationId,
    };
  return null;
}

/** The address of an item's single view, as presence names it. */
export const itemRoute = (item) =>
  item.kind === "session"
    ? `/sessions/${encodeURIComponent(item.id)}`
    : `/agents/${encodeURIComponent(item.assistantId)}/chats/${encodeURIComponent(item.conversationId)}`;

/** The single-view route of an item; a session opens on its pane's tab. */
export function singleRoute(item, tab) {
  if (item.kind === "chat")
    return {
      view: "agents",
      assistantId: item.assistantId,
      conversationId: item.conversationId,
    };
  return {
    view: "workspace",
    sessionId: item.id,
    ...(tab ? { mode: tab === "chat" ? "reader" : tab } : {}),
  };
}

/** The pane tab of a session view mode (`reader` is the chat tab), or undefined. */
export function tabOfMode(mode) {
  if (mode === "reader") return "chat";
  return mode === "terminal" || mode === "files" ? mode : undefined;
}

const usedTime = (view) => {
  const time = Date.parse(view.usedAt);
  return Number.isNaN(time) ? -Infinity : time;
};

/**
 * Where a click on `item` lands: its pane in the current view (`focus`), else its pane
 * in the most recently used view that holds it (`switch`; ties keep list order), else
 * its single view.
 */
export function placeItem({ item, views, currentViewId }) {
  const key = itemKey(item);
  const holds = (view) => findPane(view.layout ?? null, key) !== null;
  const current = views.find((view) => view.id === currentViewId);
  if (current && holds(current)) return { kind: "focus", viewId: current.id, key };
  let best = null;
  for (const view of views)
    if (
      view.id !== currentViewId &&
      holds(view) &&
      (!best || usedTime(view) > usedTime(best))
    )
      best = view;
  return best ? { kind: "switch", viewId: best.id, key } : { kind: "single" };
}
