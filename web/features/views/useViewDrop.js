import { useCallback, useRef, useState } from "react";
import useDropZone from "../../components/useDropZone.js";
import { SPLIT_GAP, fits } from "../../components/split-geometry.js";
import { requestNavigation } from "../../lib/navigation-guard.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { ownerChatsOf, resolveAgentChat } from "../assistants/agent-chat-target.js";
import useAssistants from "../assistants/useAssistants.js";
import { draggedPayload, hasPayload, writePayload } from "./drag-payload.js";
import {
  MAX_PANES,
  MIN_PANE,
  dropItem,
  findPane,
  itemKey,
  movePane,
  paneCount,
} from "./split-tree.js";
import { useViews } from "./views-context.js";

// Stands for a dropped agent without a chat yet while hovering: a new pane.
const NEW_PANE = Object.freeze({ kind: "session", id: "\u0000new" });
const always = () => "center";

/** The item an agent's drop lands as when it has a chat already, else null. */
export function knownAgentItem(assistantId, assistants, conversations) {
  const assistant = assistants.find((candidate) => candidate.id === assistantId);
  const chat = assistant && ownerChatsOf(assistant, conversations)[0];
  return chat ? { kind: "chat", assistantId, conversationId: chat.id } : null;
}

/**
 * The layout after dropping `payload` on the pane `key` at `side` (`item` resolves an
 * item or agent payload), or `layout` itself when the drop changes nothing or is
 * refused: an edge drop that would exceed MAX_PANES or not fit `stageSize`.
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

/**
 * Drag and drop in a split view: a zone per pane (edges split, the centre replaces;
 * an item already in the view moves, a pane header dragged onto another pane's centre
 * swaps the two), one on the empty view, and the header drag that moves a pane. A
 * dropped agent resolves to its chat (opened as a click on its row does); a failure
 * shows in `error` and leaves the layout. A centre drop that replaces a pane asks
 * that pane's unsaved-edits guard first.
 */
export default function useViewDrop({ view, stageSize }) {
  const { setLayout } = useViews();
  const { assistants, conversations, refresh } = useAssistants();
  const [error, setError] = useState("");
  const viewId = view?.id ?? "";
  const layout = view?.layout ?? null;
  // Values the handlers read when they run, after an await or from an old closure.
  const latest = useRef({});
  latest.current = { layout, stageSize, assistants, conversations, refresh };

  const hoverItem = (payload) =>
    payload.item ??
    (payload.agent
      ? (knownAgentItem(
          payload.agent.assistantId,
          latest.current.assistants,
          latest.current.conversations,
        ) ?? NEW_PANE)
      : null);

  const resolveItem = useCallback(async (payload) => {
    if (payload.item) return payload.item;
    const { assistants: list, conversations: chats, refresh: reload } = latest.current;
    const assistantId = payload.agent.assistantId;
    const assistant = list.find((candidate) => candidate.id === assistantId) ?? {
      id: assistantId,
    };
    const conversationId = await resolveAgentChat(assistant, {
      conversations: chats,
      open: assistantApi.open,
      refresh: reload,
    });
    return { kind: "chat", assistantId, conversationId };
  }, []);

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
          item = await resolveItem(payload);
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
    [apply, resolveItem, viewId],
  );

  const allowedOn = (key) => (side, data) => {
    const payload = draggedPayload(data);
    // A drag whose data is hidden (another window): decided on the drop.
    if (!payload) return true;
    if (payload.pane && payload.pane.viewId !== viewId) return false;
    const current = latest.current.layout;
    const item = hoverItem(payload);
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

  // A hook: call it in the body of the component that renders the pane `key`.
  const paneZone = (key) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useDropZone({
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
    paneZone,
    emptyZone,
    onHeaderDragStart,
    full: paneCount(layout) >= MAX_PANES,
    error,
  };
}
