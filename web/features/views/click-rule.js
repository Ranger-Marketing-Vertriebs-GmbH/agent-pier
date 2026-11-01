// Items of a split view and the single-view routes they correspond to.

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
