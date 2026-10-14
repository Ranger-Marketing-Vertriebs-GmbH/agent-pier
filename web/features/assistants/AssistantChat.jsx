import TeamApprovals from "./TeamApprovals.jsx";
import TeamNote from "./TeamNote.jsx";
import { foldResultEvents, teamNotes, withTeamNotes } from "./team-notes.js";
import { scrollToChild } from "./transcript-scroll.js";
import AssistantHeader from "./AssistantHeader.jsx";
import AssistantActionApprovals from "./AssistantActionApprovals.jsx";
import AssistantApprovalStrip from "./AssistantApprovalStrip.jsx";
import AssistantMemberContext from "./AssistantMemberContext.jsx";
import useAssistantActions from "./useAssistantActions.js";
import { activityFor } from "./assistant-status.js";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import AssistantComposer from "./AssistantComposer.jsx";
import AssistantMessage from "./AssistantMessage.jsx";
import CodingRunNote from "./CodingRunNote.jsx";
import { plainText } from "./plain-text.js";
import useTouchInput from "../chat/useTouchInput.js";
import useSessionViewport from "../sessions/useSessionViewport.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantApi } from "./assistant-api.js";
import useAssistants, { useAssistantEvent } from "./useAssistants.js";
import { leadMembers } from "./useMemberMention.js";
// OpenClaw stores a sent turn without trailing whitespace (assistant-channel-contract.js).
const turnText = (text) => String(text).replace(/\r\n?/g, "\n").trimEnd();
const sameTurnText = (a, b) => turnText(a) === turnText(b);
// Streamed deltas re-render the chat on every token; the team approvals do not need to.
const PendingTeams = memo(TeamApprovals);
export default function AssistantChat({
  assistant,
  conversationId,
  focusTeamId,
  navigate,
  openNavigation,
  navigationOpen,
}) {
  const {
    drafts,
    connected,
    runtime,
    assistants = [],
    members = [],
    teams = [],
    conversations = [],
    activity = {},
  } = useAssistants();
  const conversationFault =
    copy.conversationDiagnostics[
      conversations.find((c) => c.id === conversationId)?.diagnostic
    ];
  const lastEvent = useAssistantEvent();
  const [teamAllowed, setTeamAllowed] = useState(() =>
    drafts.teamAllowed(conversationId),
  );
  const [text, setText] = useState(() => drafts.get(conversationId));
  const [history, setHistory] = useState({ messages: [], requests: [], stale: false });
  const [delta, setDelta] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState(0);
  const touchInput = useTouchInput();
  // The newest reply that was already there on load is history, not news.
  const baseline = useRef(undefined);
  const output = useRef(null);
  const stick = useRef(true);
  const scroll = useRef(0);
  // Keeps the composer above the on-screen keyboard, as the session chat does.
  useSessionViewport(true);
  const refresh = useCallback(async () => {
    try {
      const next = await assistantApi.history(conversationId);
      if (baseline.current === undefined)
        baseline.current =
          next.messages.findLast((m) => m.role === "assistant")?.id ?? null;
      setHistory(next);
      if (
        next.requests?.every((r) =>
          ["completed", "failed", "cancelled"].includes(r.state),
        )
      )
        setDelta("");
    } catch (e) {
      setError(e.message);
    }
  }, [conversationId]);
  useEffect(() => {
    baseline.current = undefined;
    refresh();
  }, [refresh]);
  useEffect(() => {
    if (lastEvent?.type === "delta" && lastEvent.conversationId === conversationId)
      setDelta(lastEvent.text);
    if (["change", "connected"].includes(lastEvent?.type)) refresh();
  }, [lastEvent, conversationId, refresh]);
  const member = members.find((m) => m.assistantId === assistant.id);
  const memberBusy =
    member && !["completed", "failed", "cancelled"].includes(member.phase);
  const latest = history.requests?.at(-1);
  const active =
    latest?.attempt &&
    !latest.attempt.reviewedAt &&
    !["completed", "failed", "cancelled"].includes(latest.attempt.state);
  const uncertain = ["uncertain", "interrupted"].includes(latest?.attempt?.state);
  const ownActions = useAssistantActions(assistant.id, !assistant.teamMemberId);
  const entry = activityFor(activity, assistant.id);
  const canSend = Boolean(
    (text.trim() || files) &&
    !busy &&
    !active &&
    !memberBusy &&
    !assistant.archivedAt &&
    runtime.availability === "ready",
  );
  // A lead's members, for @mentions in its composer and as chips in its messages.
  const mentionMembers = useMemo(
    () => leadMembers(assistant, { assistants, members, conversations }),
    [assistant, assistants, members, conversations],
  );
  const mentions = useMemo(
    () => (mentionMembers.length ? { members: mentionMembers, navigate } : null),
    [mentionMembers, navigate],
  );
  const notes = useMemo(
    () => (member ? [] : teamNotes(teams, { assistantId: assistant.id, conversationId })),
    [member, teams, assistant.id, conversationId],
  );
  const transcript = foldResultEvents(
    withTeamNotes(history.messages, notes, { complete: !history.nextBefore }),
  );
  // A team link marks the team's latest shown note.
  const focusedNote =
    focusTeamId && transcript.findLast((i) => i.note?.team.id === focusTeamId)?.note.id;
  const lastReply = history.messages.findLast((m) => m.role === "assistant");
  const announcement =
    lastReply && baseline.current !== undefined && lastReply.id !== baseline.current
      ? plainText(lastReply.text)
      : "";
  // Follow the newest content only while the reader is at the bottom. Team notes count:
  // they arrive with the team list, apart from the history.
  useLayoutEffect(() => {
    const element = output.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
    scroll.current = element.scrollTop;
  }, [history.messages, history.requests, delta, busy, notes]);
  useLayoutEffect(() => {
    stick.current = true;
  }, [conversationId]);
  // A shrinking viewport (on-screen keyboard) must keep the latest message in view.
  useLayoutEffect(() => {
    const element = output.current;
    if (!element) return;
    const resize = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  // A team link (/agents/:id/teams/:teamId) shows what the team needs from the owner,
  // or else its latest note, once the history is there and either is rendered.
  const focused = useRef("");
  useEffect(() => {
    if (!focusTeamId || focused.current === focusTeamId || baseline.current === undefined)
      return;
    const element = output.current;
    const target =
      element?.querySelector(`#assistant-team-${CSS.escape(focusTeamId)}`) ||
      element?.querySelector(`#assistant-team-requests-${CSS.escape(focusTeamId)}`) ||
      element?.querySelector(`#assistant-team-review-${CSS.escape(focusTeamId)}`) ||
      [...(element?.querySelectorAll(".assistant-team-note") || [])].findLast(
        (note) => note.dataset.team === focusTeamId,
      );
    if (!target) return;
    focused.current = focusTeamId;
    stick.current = false;
    scrollToChild(element, target);
  });
  async function send(event, attachments = []) {
    event.preventDefault();
    if (!canSend) return false;
    stick.current = true;
    setBusy(true);
    setError("");
    try {
      const submitted = drafts.delivery(conversationId);
      await assistantApi.send(
        conversationId,
        attachments.length ? { ...submitted, attachments } : submitted,
      );
      if (drafts.acknowledge(conversationId, submitted.clientRequestId)) {
        setText("");
        setTeamAllowed(false);
      }
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function earlier() {
    try {
      const page = await assistantApi.history(conversationId, history.nextBefore);
      setHistory((current) => ({
        ...current,
        nextBefore: page.nextBefore,
        // An older page may repeat a newer event note; the newer place wins.
        messages: [
          ...page.messages.filter((m) => !current.messages.some((c) => c.id === m.id)),
          ...current.messages,
        ],
      }));
    } catch (e) {
      setError(e.message);
    }
  }
  async function stop() {
    try {
      await assistantApi.cancel(latest.attempt.id);
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <section className="assistant-detail assistant-chat">
      <AssistantHeader
        assistant={assistant}
        variant="conversation"
        navigate={navigate}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        attempt={active ? latest.attempt : null}
        member={member}
      />
      {!assistant.teamMemberId && (
        <AssistantApprovalStrip count={entry.pendingApprovals} output={output} />
      )}
      {member && <AssistantMemberContext member={member} navigate={navigate} />}

      <div className="assistant-chat-panel">
        <ErrorMessage error={error} />
        {!connected && (
          <p role="status" className="assistant-notice">
            {copy.disconnected}
          </p>
        )}
        {conversationFault && (
          <p role="status" className="assistant-notice">
            {conversationFault}
          </p>
        )}
        {history.stale && (
          <p role="status" className="assistant-notice">
            {copy.stale}
          </p>
        )}
        <div
          className="assistant-transcript"
          ref={output}
          onScroll={(event) => {
            const element = event.currentTarget;
            scroll.current = element.scrollTop;
            stick.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          }}
        >
          <div role="log" aria-live="off" aria-label={copy.conversation}>
            {history.nextBefore && (
              <button className="button secondary" onClick={earlier}>
                {copy.earlier}
              </button>
            )}
            {!history.messages.length && !latest && (
              <div className="assistant-empty">
                <h2>{copy.emptyChat}</h2>
              </div>
            )}
            {transcript.map(({ message: m, note }) =>
              note ? (
                <TeamNote
                  key={note.id}
                  note={note}
                  navigate={navigate}
                  focused={note.id === focusedNote}
                />
              ) : m.event === "coding-run" ? (
                <CodingRunNote key={m.id} note={m} navigate={navigate} />
              ) : m.role === "event" ? (
                <p key={m.id} className="assistant-note assistant-event">
                  {copy.team.internalTurns[m.event]}
                </p>
              ) : (
                <AssistantMessage
                  key={m.id}
                  role={m.role}
                  name={m.role === "user" ? copy.you : assistant.name}
                  text={m.text}
                  source={m.source}
                  sender={m.sender}
                  timestamp={m.timestamp}
                  attachments={m.attachments}
                  forwarded={m.forwarded === true}
                  mentions={mentions}
                />
              ),
            )}
            {active &&
              latest.internal &&
              history.messages.at(-1)?.event !== latest.internal && (
                <p className="assistant-note assistant-event">
                  {copy.team.internalTurns[latest.internal]}
                </p>
              )}
            {active &&
              !latest.internal &&
              !history.messages.some(
                (m) => m.role === "user" && sameTurnText(m.text, latest.text),
              ) && (
                <AssistantMessage
                  role="user"
                  name={copy.you}
                  text={latest.text}
                  attachments={latest.attachments}
                  source={latest.source}
                  sender={latest.sender}
                  timestamp={Date.parse(latest.createdAt) || 0}
                  forwarded={latest.forwarded === true}
                  mentions={mentions}
                />
              )}
            {delta && (
              <AssistantMessage
                role="assistant"
                name={assistant.name}
                text={delta}
                streaming={Boolean(active)}
              />
            )}
            {latest?.attempt && (
              <p
                role="status"
                className={`assistant-note assistant-run-state${active && !uncertain ? " working" : ""}`}
              >
                {active && !uncertain && (
                  <span className="assistant-run-dot" aria-hidden="true" />
                )}
                {copy.status[latest.attempt.state]}
              </p>
            )}
            {uncertain && (
              <p className="assistant-notice">
                {latest.attempt.reviewedAt ? copy.reviewed : copy.uncertain}
              </p>
            )}
            {uncertain && !latest.attempt.reviewedAt && (
              <div className="assistant-notice">
                <p>{copy.recoverNotice}</p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await assistantApi.recover(latest.attempt.id);
                      await refresh();
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {copy.recover}
                </button>
              </div>
            )}
          </div>
          {!member && <PendingTeams assistant={assistant} navigate={navigate} />}
          {!assistant.teamMemberId && <AssistantActionApprovals {...ownActions} />}
        </div>
        <div
          className="assistant-announcer"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </div>
        <AssistantComposer
          assistant={assistant}
          conversationId={conversationId}
          drafts={drafts}
          text={text}
          setText={setText}
          teamAllowed={teamAllowed}
          setTeamAllowed={setTeamAllowed}
          canSend={canSend}
          busy={busy}
          active={Boolean(active)}
          touchInput={touchInput}
          onSubmit={send}
          onFiles={setFiles}
          onStop={stop}
          output={output}
          stick={stick}
          scroll={scroll}
          mentionMembers={mentionMembers}
        />
      </div>
    </section>
  );
}
