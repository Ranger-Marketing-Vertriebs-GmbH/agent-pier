import React, { useCallback } from "react";
import ErrorMessage from "../../../components/ErrorMessage.jsx";
import Skeleton, { SkeletonLabel } from "../../../components/Skeleton.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import { appleStandalone, saveUrl } from "../../../lib/standalone.js";
import PinboardLists from "./PinboardLists.jsx";
import { pinboardFileUrl } from "./pinboard-api.js";

// Saves the file by its name; a home-screen app hands it to the share sheet instead
// of navigating away (FileLink does the same for a link).
function download(url) {
  if (appleStandalone()) return void saveUrl(url).catch(() => {});
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.click();
}

/**
 * An agent's pinboard as the chat's tab (phones) or the docked panel's body: the
 * lists, or while `view` loads a placeholder. Tapping a file downloads it; the
 * reader with previous / next takes over here (Task 10's PinboardReader).
 */
export default function PinboardView({ assistant, view, error, navigate, focusListId }) {
  const openEntry = useCallback(
    (_listId, entryId) =>
      download(pinboardFileUrl(assistant.id, entryId, { download: true })),
    [assistant.id],
  );
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
  return (
    <div className="pinboard-view">
      <PinboardLists
        view={view}
        focusListId={focusListId}
        onOpenEntry={openEntry}
        onOpenChat={openChat}
      />
    </div>
  );
}
