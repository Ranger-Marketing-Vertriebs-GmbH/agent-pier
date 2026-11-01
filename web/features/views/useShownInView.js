import { useMemo } from "react";
import { panes } from "./split-tree.js";
import { useViews } from "./views-context.js";

/**
 * What the open split view shows, for the sidebar's "shown in this view" marker:
 * `session(id)` and `agent(assistantId)` (any chat of the agent). Nothing outside a view.
 */
export default function useShownInView(route) {
  const store = useViews();
  const view = route?.view === "split" ? (store?.byId(route.viewId) ?? null) : null;
  const layout = view?.layout ?? null;
  return useMemo(() => {
    const items = panes(layout).map((pane) => pane.item);
    return {
      session: (id) => items.some((item) => item.kind === "session" && item.id === id),
      agent: (id) =>
        items.some((item) => item.kind === "chat" && item.assistantId === id),
    };
  }, [layout]);
}
