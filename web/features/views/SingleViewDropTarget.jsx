import React, { useRef, useState } from "react";
import DropZoneOverlay from "../../components/DropZoneOverlay.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import useDropZone from "../../components/useDropZone.js";
import { viewsCopy } from "../../lib/i18n/messages/views.js";
import { assistantApi } from "../assistants/assistant-api.js";
import { resolveAgentChat } from "../assistants/agent-chat-target.js";
import useAssistants from "../assistants/useAssistants.js";
import { draggedPayload, hasPayload } from "./drag-payload.js";
import { itemKey, twoPaneLayout } from "./split-tree.js";
import { knownAgentItem } from "./useViewDrop.js";
import { useViews } from "./views-context.js";
import useViewsOffered from "./useViewsOffered.js";
import { nextDefaultName } from "./ViewsSidebarGroup.jsx";
import "./views.css";

// A centre drop on the single view counts as right.
const edgeOnly = (side) => (side === "center" ? "right" : side);
// The wrapper adds no box of its own (pages keep their layout): the sides divide the
// main area, which also frames the overlay.
const mainOf = (element) => element.parentElement ?? element;

/**
 * The single session view or agent chat as a drop target (wider than 1150 px): a
 * session or agent dragged onto one of its edges creates a view with both, the
 * dragged one on that side, and opens it. `item` is what the page shows (null: not a
 * pane item, no drop).
 */
export default function SingleViewDropTarget({ item, navigate, children }) {
  const offered = useViewsOffered();
  const store = useViews();
  const { assistants, conversations, refresh } = useAssistants();
  const [error, setError] = useState("");
  const latest = useRef({});
  latest.current = { assistants, conversations, refresh, store, item };
  const active = Boolean(offered && item && store?.loaded);

  // The item a payload stands for while hovering; undefined when it is not known yet.
  const known = (payload) =>
    payload.item ??
    (payload.agent
      ? knownAgentItem(payload.agent.assistantId, assistants, conversations)
      : null);
  const differs = (dropped) => dropped && itemKey(dropped) !== itemKey(item);

  const resolve = async (payload) => {
    if (payload.item) return payload.item;
    const current = latest.current;
    const assistantId = payload.agent.assistantId;
    const conversationId = await resolveAgentChat(
      current.assistants.find((candidate) => candidate.id === assistantId) ?? {
        id: assistantId,
      },
      {
        conversations: current.conversations,
        open: assistantApi.open,
        refresh: current.refresh,
      },
    );
    return { kind: "chat", assistantId, conversationId };
  };

  const zone = useDropZone({
    accepts: (types) => active && hasPayload(types),
    sideFor: edgeOnly,
    rectOf: mainOf,
    allowed: (side, data) => {
      const payload = draggedPayload(data);
      if (!payload) return true;
      if (payload.pane) return false;
      const dropped = known(payload);
      return dropped ? differs(dropped) : Boolean(payload.agent);
    },
    onDrop: async (side, data) => {
      const payload = draggedPayload(data);
      if (!payload || payload.pane) return;
      const { store: views, item: shown } = latest.current;
      try {
        setError("");
        const dropped = await resolve(payload);
        if (itemKey(dropped) === itemKey(shown)) return;
        const view = await views.create({
          name: nextDefaultName(views.views, viewsCopy.defaultName),
          layout: twoPaneLayout(shown, dropped, side),
        });
        if (view) navigate({ view: "split", viewId: view.id });
      } catch (failure) {
        setError(failure.message);
      }
    },
  });

  return (
    <div className="single-view-drop" {...(active ? zone.handlers : {})}>
      {error && (
        <div className="single-view-drop-error">
          <ErrorMessage error={error} />
        </div>
      )}
      {children}
      <DropZoneOverlay side={active ? zone.side : null} />
    </div>
  );
}
