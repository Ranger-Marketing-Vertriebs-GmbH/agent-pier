import { useCallback, useRef, useState } from "react";
import useDropZone from "../../components/useDropZone.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
import { assistantApi } from "../assistants/assistant-api.js";
import useAssistants from "../assistants/useAssistants.js";
import { draggedPayload, hasPayload, writePayload } from "./drag-payload.js";
import { dropResult, hoverItemOf, itemForPayload } from "./drop-rules.js";
import { MAX_PANES, dropItem, findPane, itemKey, paneCount } from "./split-tree.js";
import { useViews } from "./views-context.js";

// Stands for a dropped agent without a chat yet while hovering: a new pane.
const NEW_PANE = Object.freeze({ kind: "session", id: "\u0000new" });
const always = () => "center";

/**
 * Drag and drop in a split view: zones per pane (`usePaneZone`; edges split, the
 * centre replaces; an item already in the view moves, a pane header dragged onto
 * another pane's centre swaps the two), one on the empty view, and the header drag
 * that moves a pane. A dropped agent resolves to its chat (opened as a click on its
 * row does); a failure shows in `error` and leaves the layout. A centre drop that
 * replaces a pane asks that pane's unsaved-edits guard first. `adding` tells whether
 * the drag under a pane would add one (for the "view is full" label).
 */
export default function useViewDrop({ view, stageSize }) {
  const { setLayout } = useViews();
  const { assistants, conversations, refresh } = useAssistants();
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const viewId = view?.id ?? "";
  const layout = view?.layout ?? null;
  // Values the handlers read when they run, after an await or from an old closure.
  const latest = useRef({});
  latest.current = { layout, stageSize, assistants, conversations, refresh };

  const apply = useCallback(
    (next) => {
      if (next === latest.current.layout) return;
      latest.current = { ...latest.current, layout: next };
      setLayout(viewId, next);
    },
    [setLayout, viewId],
  );

  const drop = useCallback(
    async (payload, key, side) => {
      if (!payload) return;
      let item = null;
      if (!payload.pane) {
        try {
          item = await itemForPayload(payload, {
            ...latest.current,
            open: assistantApi.open,
          });
          setError("");
        } catch (failure) {
          setError(failure.message);
          return;
        }
      }
      const result = (current) =>
        current === null
          ? item && dropItem(null, item)
          : dropResult({
              layout: current,
              viewId,
              payload,
              item,
              key,
              side,
              stageSize: latest.current.stageSize,
            });
      const current = latest.current.layout;
      const next = result(current);
      if (!next || next === current) return;
      // A new item on a pane's centre takes that pane's place: its edits ask first.
      const replaces =
        current !== null &&
        side === "center" &&
        item &&
        !findPane(current, itemKey(item));
      if (!replaces) return apply(next);
      await requestNavigation({
        reason: "pane-close",
        paneScope: key,
        commit: () => apply(result(latest.current.layout) || latest.current.layout),
      });
    },
    [apply, viewId],
  );

  const allowedOn = (key) => (side, data) => {
    const payload = draggedPayload(data);
    // A drag whose data is hidden (another window): decided on the drop.
    if (!payload) return true;
    if (payload.pane && payload.pane.viewId !== viewId) return false;
    const current = latest.current.layout;
    const item = payload.pane ? null : (hoverItemOf(payload, latest.current) ?? NEW_PANE);
    setAdding(Boolean(item && !findPane(current, itemKey(item))));
    return (
      dropResult({
        layout: current,
        viewId,
        payload,
        item,
        key,
        side,
        stageSize: latest.current.stageSize,
      }) !== current
    );
  };

  // The options of the zone on pane `key` (see `usePaneZone`).
  const zoneFor = (key) => ({
    accepts: hasPayload,
    allowed: allowedOn(key),
    onDrop: (side, data) => drop(draggedPayload(data), key, side),
  });

  const emptyZone = useDropZone({
    accepts: hasPayload,
    sideFor: always,
    allowed: (side, data) => !draggedPayload(data)?.pane,
    onDrop: (side, data) => drop(draggedPayload(data), null, side),
  });

  const onHeaderDragStart = useCallback(
    (key) => (event) => writePayload(event.dataTransfer, { pane: { viewId, key } }),
    [viewId],
  );

  return {
    zoneFor,
    emptyZone,
    onHeaderDragStart,
    full: paneCount(layout) >= MAX_PANES,
    adding,
    error,
  };
}

/** The drop zone of the pane `key` in a view's drag and drop (`useViewDrop`). */
export function usePaneZone(drop, key) {
  return useDropZone(drop.zoneFor(key));
}
