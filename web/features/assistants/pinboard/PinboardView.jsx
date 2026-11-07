import React, { useCallback, useLayoutEffect, useRef } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Skeleton, { SkeletonLabel } from "../../../components/Skeleton.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import PinboardLists from "./PinboardLists.jsx";
import PinboardReader from "./PinboardReader.jsx";

// The element the lists scroll in: the chat's pinboard tab or the docked panel's body.
function scroller(element) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

/**
 * An agent's pinboard as the chat's tab (phones) or the docked panel's body: the
 * lists, or while `view` loads a placeholder. Tapping a file opens the reader with
 * previous / next in the lists' place (`reading`, `onRead({ listId, entryId } |
 * null)`); Back returns to the lists where they were, the file read last focused.
 */
export default function PinboardView({
  assistant,
  view,
  error,
  navigate,
  focusListId,
  markSeen,
  reading,
  onRead,
}) {
  const root = useRef(null);
  // Where the lists were scrolled and which file was opened, for Back.
  const left = useRef(null);
  const openEntry = useCallback(
    (listId, entryId) => {
      left.current = { top: scroller(root.current)?.scrollTop ?? 0, listId, entryId };
      onRead({ listId, entryId });
    },
    [onRead],
  );
  const openChat = useCallback(
    (conversationId) =>
      navigate({ view: "agents", assistantId: assistant.id, conversationId }),
    [assistant.id, navigate],
  );
  const readingList = reading && view?.lists.find((list) => list.id === reading.listId);
  useLayoutEffect(() => {
    if (readingList || !left.current) return;
    const { top, listId, entryId } = left.current;
    left.current = null;
    const area = scroller(root.current);
    if (area) area.scrollTop = top;
    const list = root.current?.querySelector(`[data-list-id="${CSS.escape(listId)}"]`);
    const index = view?.lists
      .find((item) => item.id === listId)
      ?.entries.findIndex((entry) => entry.id === entryId);
    const row = list?.querySelectorAll(".pinboard-entry")[index];
    (row?.matches("button") ? row : row?.querySelector("button"))?.focus({
      preventScroll: true,
    });
  }, [readingList, view]);
  if (!view)
    return (
      <div className="pinboard-view" aria-busy={!error || undefined}>
        <ErrorMessage error={error ? copy.loadFailed : ""} />
        {!error && (
          <>
            <SkeletonLabel />
            <Skeleton width="40%" />
            <Skeleton shape="block" width="100%" height={120} />
          </>
        )}
      </div>
    );
  if (readingList)
    return (
      <div className="pinboard-view reading" ref={root}>
        <PinboardReader
          assistant={assistant}
          list={readingList}
          entryId={reading.entryId}
          markSeen={markSeen}
          onNavigate={(entryId) => onRead({ ...reading, entryId })}
          onBack={() => {
            // The file read last gets the focus back in its list.
            if (left.current) Object.assign(left.current, reading);
            onRead(null);
          }}
        />
      </div>
    );
  return (
    <div className="pinboard-view" ref={root}>
      <PinboardLists
        view={view}
        focusListId={focusListId}
        onOpenEntry={openEntry}
        onOpenChat={openChat}
      />
    </div>
  );
}
