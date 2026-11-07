import React, { useEffect, useState } from "react";
import Icon from "../../components/Icon.jsx";
import Sheet from "../../components/Sheet.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { agentChatsCopy } from "../../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy } from "../../lib/i18n/messages/agent-pinboard.js";
import { activityGroupCopy } from "../../lib/i18n/messages/activity-group.js";
import { hookCopy } from "../../lib/i18n/messages/assistant-hooks.js";
import AgentEventList from "./AgentEventList.jsx";
import { eventAreaView } from "./event-area.js";
import useEventSeen from "./useEventSeen.js";

const copy = hookCopy.events;

/**
 * The main chat's routine, check-in and hook events as a header icon: the inbox, the
 * count and a dot for the events that arrived since this viewer last opened them (red
 * while one of them failed), and a working dot while one still runs. A tap opens them
 * in a sheet and marks them seen. Nothing without events; when they go, so does the
 * sheet.
 */
export default function AgentEventsButton({
  assistantId,
  conversationId,
  events,
  navigate,
}) {
  const [open, setOpen] = useState(false);
  const { seenAt, markSeen } = useEventSeen(conversationId);
  const shown = Boolean(events?.length);
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  if (!shown) return null;
  const view = eventAreaView(events, seenAt);
  const news = [
    copy.unread(view.unread),
    view.failed > 0 && activityGroupCopy.failed(view.failed),
  ].filter(Boolean);
  return (
    <>
      <button
        type="button"
        className="assistant-header-icon agent-chat-events"
        aria-label={agentPinboardCopy.header.events(view.count)}
        title={view.summary}
        aria-haspopup="dialog"
        data-unread={view.unread || undefined}
        data-failed={view.failed || undefined}
        onClick={() => {
          setOpen(true);
          markSeen(events);
        }}
      >
        <Icon name="inbox" size={18} />
        {view.running && (
          <StatusDot
            tone="working"
            pulse
            className="agent-chat-events-running"
            label={activityGroupCopy.running}
          />
        )}
        <span className="agent-chat-events-count">{view.count}</span>
        {view.unread > 0 && (
          <StatusDot
            tone={view.failed > 0 ? "error" : "waiting"}
            className="agent-chat-events-unread"
            label={news.join(" · ")}
          />
        )}
      </button>
      <Sheet
        open={open}
        title={copy.title}
        onCancel={() => setOpen(false)}
        className="agent-events-sheet"
      >
        <div className="agent-events-list">
          <AgentEventList assistantId={assistantId} events={events} navigate={navigate} />
        </div>
        <div className="sheet-actions">
          <button type="button" className="button text" onClick={() => setOpen(false)}>
            {agentChatsCopy.close}
          </button>
        </div>
      </Sheet>
    </>
  );
}
