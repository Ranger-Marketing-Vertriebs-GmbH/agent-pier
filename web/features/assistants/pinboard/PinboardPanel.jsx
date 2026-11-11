import React from "react";
import DockedPanel from "../../../components/DockedPanel.jsx";
import { agentPinboardCopy as copy } from "../../../lib/i18n/messages/agent-pinboard.js";
import PinboardView from "./PinboardView.jsx";

/** The pinboard docked beside the agent chat on desktop; the chat stays usable. */
export default function PinboardPanel({
  assistant,
  view,
  error,
  markSeen,
  navigate,
  focusListId,
  reading,
  onRead,
  onClose,
}) {
  return (
    <DockedPanel
      title={copy.title}
      subtitle={assistant.name}
      onClose={onClose}
      closeLabel={copy.close}
      resizeKey="pinboard"
    >
      <PinboardView
        assistant={assistant}
        view={view}
        error={error}
        markSeen={markSeen}
        navigate={navigate}
        focusListId={focusListId}
        reading={reading}
        onRead={onRead}
      />
    </DockedPanel>
  );
}
