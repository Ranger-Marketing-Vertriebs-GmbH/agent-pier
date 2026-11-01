import { useCallback, useMemo } from "react";
import { itemFromRoute, placeItem } from "./click-rule.js";
import { useViews } from "./views-context.js";
import useViewsOffered from "./useViewsOffered.js";

/**
 * The click rule for sidebar rows, search results and in-app notification taps: an
 * item already in a view is focused there (the current view first, else the most
 * recently used one) instead of opening it alone; a click never replaces a pane.
 * Without views (narrow windows, views not loaded yet) the handlers are `select` and
 * `navigate`. `views` defaults to the views context; App, which provides it, passes
 * its store.
 */
export default function useViewRouting({ navigate, select, route, views: given }) {
  const fromContext = useViews();
  const views = given ?? fromContext;
  const offered = useViewsOffered();
  const active = Boolean(offered && views?.loaded);
  const list = views?.views;
  const requestFocus = views?.requestFocus;
  const currentViewId = route?.view === "split" ? route.viewId : null;

  // Returns true when the click rule handled `item`, else false (open it alone).
  const place = useCallback(
    async (item) => {
      const placed = placeItem({ item, views: list, currentViewId });
      if (placed.kind === "single") return false;
      if (placed.kind === "switch") {
        const accepted = await navigate({ view: "split", viewId: placed.viewId });
        if (accepted === false) return true;
      }
      requestFocus(placed.viewId, placed.key);
      return true;
    },
    [list, currentViewId, navigate, requestFocus],
  );

  const openRoute = useCallback(
    async (next, ...rest) => {
      const item = active ? itemFromRoute(next) : null;
      if (item && (await place(item))) return true;
      return navigate(next, ...rest);
    },
    [active, place, navigate],
  );
  const openSession = useCallback(
    async (session) => {
      if (active && session && (await place({ kind: "session", id: session.id }))) return;
      select(session);
    },
    [active, place, select],
  );
  return useMemo(
    () =>
      active ? { openSession, openRoute } : { openSession: select, openRoute: navigate },
    [active, openSession, openRoute, select, navigate],
  );
}
