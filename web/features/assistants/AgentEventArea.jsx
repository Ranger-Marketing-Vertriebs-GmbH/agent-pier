import React, { useEffect, useId, useState } from "react";
import ActivityGroup from "../../components/ActivityGroup.jsx";
import ActivityRow from "../../components/ActivityRow.jsx";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import CodeBlock from "../../components/CodeBlock.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import { readRoute } from "../../app/routes.js";
import { formatBytes } from "../../lib/format-bytes.js";
import { formatTimestamp, locale } from "../../lib/i18n/index.js";
import { hookCopy } from "../../lib/i18n/messages/assistant-hooks.js";
import { agentRunStepsCopy as stepsCopy } from "../../lib/i18n/messages/agent-run-steps.js";
import { assistantWorkflowCopy as workflowCopy } from "../../lib/i18n/messages/assistant-workflows.js";
import { toolName } from "./AgentRunState.jsx";
import RouteLink from "./RouteLink.jsx";
import { hookApi } from "./settings/hook-api.js";
import {
  eventAreaView,
  eventRowView,
  noteTexts,
  readSeenAt,
  storeSeenAt,
} from "./event-area.js";
import "./agent-event-area.css";

const copy = hookCopy.events;
const stepTones = { running: "working", done: "ok", failed: "error" };

// The app route of a coding run's link (an absolute or app-relative URL).
function runRoute(url) {
  try {
    return readRoute(new URL(url, window.location.origin));
  } catch {
    return null;
  }
}

function Fact({ term, children }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

// What a hook event's run did: its tool steps, coding and SSH/SFTP runs, notices.
function EventActivity({ detail, navigate }) {
  const headingId = useId();
  const notices = [
    detail.notified?.push && copy.pushSent,
    detail.notified?.telegram && copy.telegramSent,
  ].filter(Boolean);
  const empty =
    !detail.activity.length &&
    !detail.coding.length &&
    !detail.remote.length &&
    !notices.length;
  return (
    <section className="agent-event-did" aria-labelledby={headingId}>
      <h4 id={headingId}>{copy.did}</h4>
      {empty && <p className="activity-row-note">{copy.nothingDone}</p>}
      <ul>
        {detail.activity.map((step, index) => (
          <li key={`step-${index}`} data-state={step.state}>
            <StatusDot tone={stepTones[step.state] || "idle"} />
            {toolName(step)}
            {step.label ? ` · ${step.label}` : ""}
            {stepsCopy.state[step.state] ? ` · ${stepsCopy.state[step.state]}` : ""}
          </li>
        ))}
        {detail.coding.map((run) => {
          const route = run.runUrl && runRoute(run.runUrl);
          return (
            <li key={run.actionId}>
              {copy.codingRun} · {workflowCopy.states[run.state] || run.state}
              {route && navigate && (
                <>
                  {" "}
                  <RouteLink route={route} navigate={navigate}>
                    {copy.openRun}
                  </RouteLink>
                </>
              )}
            </li>
          );
        })}
        {detail.remote.map((run) => (
          <li key={run.actionId}>
            {copy.remote(run.kind, run.host)} ·{" "}
            {workflowCopy.states[run.state] || run.state}
          </li>
        ))}
        {notices.map((notice) => (
          <li key={notice}>{notice}</li>
        ))}
      </ul>
    </section>
  );
}

// A hook event's body, loaded when its row opens: the payload as plain text (never
// Markdown), its facts, what the agent did and its full reply.
function HookEventBody({ assistantId, event, navigate }) {
  const incomingId = useId();
  const [state, setState] = useState({ detail: null, error: "" });
  useEffect(() => {
    let live = true;
    hookApi.event(assistantId, event.hookId, event.eventId).then(
      (detail) => live && setState({ detail, error: "" }),
      (error) => live && setState({ detail: null, error: error.message }),
    );
    return () => {
      live = false;
    };
  }, [assistantId, event.hookId, event.eventId]);
  const { detail, error } = state;
  if (error) return <ErrorMessage error={error} />;
  if (!detail) return <p className="activity-row-note">{copy.loading}</p>;
  const reply = detail.reply ?? event.reply;
  return (
    <>
      <h4 id={incomingId}>{copy.incoming}</h4>
      {detail.payload === null ? (
        <p className="activity-row-note">{copy.noPayload}</p>
      ) : (
        <CodeBlock
          className="activity-row-code"
          aria-labelledby={incomingId}
          copyText={detail.payload}
          copyLabel={copy.copyPayload}
        >
          <code>{detail.payload}</code>
        </CodeBlock>
      )}
      {detail.payloadCut && <p className="activity-row-note">{copy.payloadCut}</p>}
      <dl className="activity-row-facts">
        <Fact term={copy.received}>{formatTimestamp(detail.receivedAt)}</Fact>
        <Fact term={copy.size}>{formatBytes(detail.size, locale)}</Fact>
        {event.sender && <Fact term={copy.sender}>{event.sender}</Fact>}
        {event.duplicates > 0 && (
          <Fact term={copy.duplicateCount}>{event.duplicates}</Fact>
        )}
      </dl>
      <EventActivity detail={detail} navigate={navigate} />
      {reply && <EventReply text={reply} />}
    </>
  );
}

function EventReply({ text }) {
  const headingId = useId();
  return (
    <section className="agent-event-reply" aria-labelledby={headingId}>
      <h4 id={headingId}>{copy.reply}</h4>
      <div className="message-content">
        <ChatMarkdown>{text}</ChatMarkdown>
      </div>
    </section>
  );
}

// A routine's or check-in's body: its time, readable notes, then its reply.
function ResultBody({ event }) {
  const notes = noteTexts(event.notes);
  return (
    <>
      <dl className="activity-row-facts">
        <Fact term={copy.at}>{formatTimestamp(event.at)}</Fact>
      </dl>
      {event.status === "failed" && <p className="activity-row-note">{copy.failedRun}</p>}
      {notes.map((note) => (
        <p key={note} className="activity-row-note">
          {note}
        </p>
      ))}
      {event.reply && <EventReply text={event.reply} />}
    </>
  );
}

/**
 * The main chat's event area under its header: routine, check-in and hook events in
 * one ActivityGroup ("Events"), shut by default, with the count of events that
 * arrived since this viewer last opened it. Each event is an ActivityRow.
 */
export default function AgentEventArea({
  assistantId,
  conversationId,
  events,
  navigate,
}) {
  // Read once per chat: a switch to another chat reads that chat's mark.
  const [seen, setSeen] = useState(() => ({
    conversationId,
    at: readSeenAt(conversationId),
  }));
  const seenAt =
    seen.conversationId === conversationId ? seen.at : readSeenAt(conversationId);
  if (!events?.length) return null;
  const view = eventAreaView(events, seenAt);
  const opened = (open) => {
    if (!open) return;
    const at = Math.max(Date.now(), ...events.map((event) => event.at));
    storeSeenAt(conversationId, at);
    setSeen({ conversationId, at });
  };
  return (
    <div className="agent-event-area">
      <ActivityGroup
        className="agent-event-group"
        label={copy.title}
        icon="inbox"
        detail={view.summary}
        running={view.running}
        failed={view.failed}
        data-unread={view.unread || undefined}
        onToggle={opened}
      >
        {events.map((event) => {
          const row = eventRowView(event);
          return (
            <ActivityRow
              key={event.id}
              className="agent-event-row"
              data-event-source={event.source}
              data-event-status={event.status}
              icon={row.icon}
              label={row.label}
              detail={row.detail}
              status={row.status}
              tone={row.tone}
            >
              {event.source === "hook" ? (
                <HookEventBody
                  assistantId={assistantId}
                  event={event}
                  navigate={navigate}
                />
              ) : (
                <ResultBody event={event} />
              )}
            </ActivityRow>
          );
        })}
      </ActivityGroup>
    </div>
  );
}
