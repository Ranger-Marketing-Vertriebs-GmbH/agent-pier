import React from "react";
import { PinboardContext } from "./pinboard-context.js";
import PinboardPanel from "./PinboardPanel.jsx";
import PinboardView from "./PinboardView.jsx";

/**
 * The agent chat's body with its pinboard (`pinboard` is useChatPinboard's result):
 * the chat panel (`children`) and, docked beside it on desktop, the pinboard. Its
 * content can open the pinboard through PinboardContext.
 */
export default function ChatPinboardBody({ assistant, pinboard, navigate, children }) {
  return (
    <PinboardContext.Provider value={pinboard.context}>
      <div className="assistant-chat-body">
        {children}
        {pinboard.docked && (
          <PinboardPanel
            assistant={assistant}
            view={pinboard.view}
            error={pinboard.error}
            markSeen={pinboard.markSeen}
            markSeen={pinboard.markSeen}
            navigate={navigate}
            focusListId={pinboard.focusListId}
            onClose={() => pinboard.setOpen(false)}
          />
        )}
      </div>
    </PinboardContext.Provider>
  );
}

/** The pinboard in the transcript's place: the chat's tab on phones and in panes. */
export function PinboardTab({ assistant, pinboard, navigate }) {
  if (!pinboard.tab) return null;
  return (
    <div className="assistant-pinboard-tab">
      <PinboardView
        assistant={assistant}
        view={pinboard.view}
        error={pinboard.error}
        markSeen={pinboard.markSeen}
        navigate={navigate}
        focusListId={pinboard.focusListId}
      />
    </div>
  );
}
