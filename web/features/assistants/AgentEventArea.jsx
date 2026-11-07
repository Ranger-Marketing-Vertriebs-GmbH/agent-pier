import React from "react";
import ActivityGroup from "../../components/ActivityGroup.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { hookCopy } from "../../lib/i18n/messages/assistant-hooks.js";
import AgentEventList from "./AgentEventList.jsx";
import { eventAreaView } from "./event-area.js";
import useEventSeen from "./useEventSeen.js";
import "./agent-event-area.css";

const copy = hookCopy.events;

// The phone's slim head: the bare count, and the unread events as a dot whose label
// says how many are new (the desktop head writes "10 events · 10 new").
function PhoneSummary({ view }) {
  return (
    <>
      {view.count}
      {view.unread > 0 && (
        <StatusDot
          tone="waiting"
          className="agent-event-unread"
          label={copy.unread(view.unread)}
        />
      )}
    </>
  );
}

/**
 * The main chat's event area under its header: routine, check-in and hook events in
 * one ActivityGroup ("Events"), shut by default, with the count of events that
 * arrived since this viewer last opened it. Each event is an ActivityRow. On phones
 * the head is one slim row without its own frame.
 */
export default function AgentEventArea({
  assistantId,
  conversationId,
  events,
  navigate,
}) {
  const phone = useMobileLayout();
  // Read once per chat: a switch to another chat reads that chat's mark.
  const { seenAt, markSeen } = useEventSeen(conversationId);
  if (!events?.length) return null;
  const view = eventAreaView(events, seenAt);
  return (
    <div className="agent-event-area">
      <ActivityGroup
        className="agent-event-group"
        label={copy.title}
        icon="inbox"
        detail={phone ? <PhoneSummary view={view} /> : view.summary}
        running={view.running}
        failed={view.failed}
        data-unread={view.unread || undefined}
        onToggle={(open) => open && markSeen(events)}
      >
        <AgentEventList assistantId={assistantId} events={events} navigate={navigate} />
      </ActivityGroup>
    </div>
  );
}
