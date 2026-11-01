import { itemFromRoute } from "./click-rule.js";

/**
 * Where a navigation from inside a pane showing `item` goes:
 * `local` — the same session (another tab, a folder): the pane keeps it;
 * `item` — another chat of the same agent: the pane shows that chat instead;
 * `rule` — another session or chat: the click rule decides (focus, other view, single);
 * `app` — anything else: the app navigates there.
 */
export function paneTarget(item, next) {
  const target = itemFromRoute(next);
  if (!target) return { kind: "app", route: next };
  if (item.kind === "session" && target.kind === "session" && target.id === item.id)
    return { kind: "local", route: next };
  if (
    item.kind === "chat" &&
    target.kind === "chat" &&
    target.assistantId === item.assistantId
  )
    return target.conversationId === item.conversationId
      ? { kind: "local", route: next }
      : { kind: "item", item: target };
  return { kind: "rule", route: next };
}
