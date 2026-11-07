import React, { useCallback, useState } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Skeleton, { SkeletonLabel } from "../../../components/Skeleton.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import PinboardLists from "./PinboardLists.jsx";
import PinboardReader from "./PinboardReader.jsx";

/**
 * An agent's pinboard as the chat's tab (phones) or the docked panel's body: the
 * lists, or while `view` loads a placeholder. Tapping a file opens the reader with
 * previous / next in the lists' place; Back returns to the lists at that list.
 */
export default function PinboardView({
  assistant,
  view,
  error,
  navigate,
  focusListId,
  markSeen,
}) {
  const [reading, setReading] = useState(null);
  // The list the reader came from, scrolled to again on Back.
  const [returned, setReturned] = useState(null);
  const openEntry = useCallback((listId, entryId) => {
    setReturned(null);
    setReading({ listId, entryId });
  }, []);
  const openChat = useCallback(
    (conversationId) =>
      navigate({ view: "agents", assistantId: assistant.id, conversationId }),
    [assistant.id, navigate],
  );
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
  const readingList = reading && view.lists.find((list) => list.id === reading.listId);
  if (readingList)
    return (
      <div className="pinboard-view reading">
        <PinboardReader
          assistant={assistant}
          list={readingList}
          entryId={reading.entryId}
          markSeen={markSeen}
          onNavigate={(entryId) => setReading({ ...reading, entryId })}
          onBack={() => {
            setReturned(reading.listId);
            setReading(null);
          }}
        />
      </div>
    );
  return (
    <div className="pinboard-view">
      <PinboardLists
        view={view}
        focusListId={returned || focusListId}
        onOpenEntry={openEntry}
        onOpenChat={openChat}
      />
    </div>
  );
}
