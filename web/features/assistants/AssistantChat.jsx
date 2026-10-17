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
import useAgentAttachments from "./useAgentAttachments.js";
import useFileDrop from "../../components/useFileDrop.js";
import { assistantAttachmentsCopy } from "../../lib/i18n/messages/assistant-attachments.js";
import AssistantMessage from "./AssistantMessage.jsx";
import CodingRunNote from "./CodingRunNote.jsx";
import SshRunNote from "./SshRunNote.jsx";
import MemberGrantNote from "./MemberGrantNote.jsx";
import { plainText } from "./plain-text.js";
import useTouchInput from "../chat/useTouchInput.js";
import useSessionViewport from "../sessions/useSessionViewport.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { routineCopy } from "../../lib/i18n/messages/assistant-routines.js";
import { memoryNoteCopy } from "../../lib/i18n/messages/assistant-memory-notes.js";
import { assistantApi } from "./assistant-api.js";
import useAssistants, { useAssistantEvents } from "./useAssistants.js";
import { leadMembers } from "./useMemberMention.js";
import { streamInHistory } from "./stream-reply.js";
import { compactionNoteText } from "./compaction-note.js";
import { takeBack } from "./queued-message.js";
// OpenClaw stores a sent turn without trailing whitespace (assistant-channel-contract.js).
const turnText = (text) => String(text).replace(/\r\n?/g, "\n").trimEnd();
const sameTurnText = (a, b) => turnText(a) === turnText(b);
// A stored turn names its request; older or unkeyed turns still match by text.
const sameTurn = (m, request) =>
  m.role === "user" &&
  (m.requestId ? m.requestId === request.id : sameTurnText(m.text, request.text));
// Quiet notes join the history between turns; an internal turn's event line is the
// newest message that is not one of them.
const noteEvents = new Set(["compaction", "memory-note", "routine-failed", "coding-run"]);
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
  const [teamAllowed, setTeamAllowed] = useState(() =>
    drafts.teamAllowed(conversationId),
  );
  const [text, setText] = useState(() => drafts.get(conversationId));
  const [history, setHistory] = useState({ messages: [], requests: [], stale: false });
  // The streamed reply so far, with its run: { runId, text } or null.
  const [delta, setDelta] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState(0);
  const typed = useRef(text);
  typed.current = text;
  // The submission being queued: one at a time, and a retry of the same content
  // keeps its appendId, so the server adds the text only once.
  const appending = useRef({ busy: false, last: null });
  const touchInput = useTouchInput();
  const attachments = useAgentAttachments(conversationId);
  // The whole panel takes dropped files; the composer stays droppable while the agent
  // works, only an archived agent takes none.
  const drop = useFileDrop({
    enabled: !assistant.archivedAt,
    onFiles: attachments.add,
  });
  // The newest reply that was already there on load is history, not news.
  const baseline = useRef(undefined);
  const output = useRef(null);
  const stick = useRef(true);
  const scroll = useRef(0);
  // Only the latest history read applies: an older one answering late, or one of the
  // previous conversation, would bring back a state that is already over.
  const reads = useRef(0);
  // Keeps the composer above the on-screen keyboard, as the session chat does.
  useSessionViewport(true);
  const refresh = useCallback(async () => {
    const read = ++reads.current;
    try {
      const next = await assistantApi.history(conversationId);
      if (read !== reads.current) return;
      if (baseline.current === undefined)
        baseline.current =
          next.messages.findLast((m) => m.role === "assistant")?.id ?? null;
      setHistory(next);
      if (
        next.requests?.every((r) =>
          ["completed", "failed", "cancelled"].includes(r.state),
        )
      )
        setDelta(null);
      else setDelta((d) => (streamInHistory(d, next) ? null : d));
    } catch (e) {
      if (read === reads.current) setError(e.message);
    }
  }, [conversationId]);
  useEffect(() => {
    baseline.current = undefined;
    refresh();
  }, [refresh]);
  useAssistantEvents((event) => {
    if (event.type === "delta" && event.conversationId === conversationId)
      setDelta({ runId: event.runId, text: event.text });
    if (["change", "connected"].includes(event.type)) refresh();
  });
  const member = members.find((m) => m.assistantId === assistant.id);
  const memberBusy =
    member && !["completed", "failed", "cancelled"].includes(member.phase);
  const latest = history.requests?.at(-1);
  const active =
    latest?.attempt &&
    !latest.attempt.reviewedAt &&
    !["completed", "failed", "cancelled"].includes(latest.attempt.state);
  const uncertain = ["uncertain", "interrupted"].includes(latest?.attempt?.state);
  // The run summarises its long history before it answers (compactions.js).
  const compacting = Boolean(active && !uncertain && history.compacting);
  // Every agent's own requests wait in its chat: a permanent member may have a shell.
  const ownActions = useAssistantActions(assistant.id);
  const entry = activityFor(activity, assistant.id);
  const canSend = Boolean(
    (text.trim() || files) &&
    !busy &&
    !active &&
    !history.queued &&
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
  // One delivery of a message; `accepted` runs once the server has taken it.
  async function deliver(submitted, ids, accepted) {
    stick.current = true;
    setBusy(true);
    setError("");
    try {
      await assistantApi.send(
        conversationId,
        ids.length ? { ...submitted, attachments: ids } : submitted,
      );
      accepted?.();
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // The message queued while the agent works, kept by the server for every tab.
  const queued = history.queued || null;
  const available =
    !memberBusy && !assistant.archivedAt && runtime.availability === "ready";
  // While the agent works, or a queued message still waits, Enter and "Send when
  // done" queue the message, after the waiting one: only Stop stops a turn.
  async function queue(ids) {
    if (assistant.archivedAt || (!text.trim() && !ids.length)) return false;
    const append = appending.current;
    if (append.busy) return false;
    setError("");
    const submitted = text;
    const content = JSON.stringify([text, teamAllowed, ids]);
    if (append.last?.content !== content)
      append.last = { content, id: crypto.randomUUID() };
    append.busy = true;
    try {
      await assistantApi.queue(conversationId, {
        text,
        ...(teamAllowed ? { teamAllowed: true } : {}),
        ...(ids.length ? { attachments: ids } : {}),
        appendId: append.last.id,
      });
      append.last = null;
      if (drafts.get(conversationId) === submitted) {
        drafts.clear(conversationId);
        setText("");
        setTeamAllowed(false);
      }
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    } finally {
      append.busy = false;
    }
  }
  async function send(event, ids = []) {
    event.preventDefault();
    if (active || queued) return queue(ids);
    if (!canSend) return false;
    const submitted = drafts.delivery(conversationId);
    return deliver(submitted, ids, () => {
      if (drafts.acknowledge(conversationId, submitted.clientRequestId)) {
        setText("");
        setTeamAllowed(false);
      }
    });
  }
  // Edit: the server hands the message back, unless its delivery has begun.
  async function takeBackQueued() {
    setError("");
    try {
      const back = await assistantApi.takeBackQueued(conversationId);
      const value = takeBack(back.text, typed.current);
      setText(value);
      drafts.set(conversationId, value);
      if (back.teamAllowed) {
        setTeamAllowed(true);
        drafts.allowTeam(conversationId, true);
      }
      attachments.restore(back.attachments || []);
    } catch (e) {
      setError(e.message);
    }
    await refresh();
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
        compacting={compacting}
      />
      <AssistantApprovalStrip count={entry.pendingApprovals} output={output} />
      {member && <AssistantMemberContext member={member} navigate={navigate} />}

      <div
        className="assistant-chat-panel"
        {...drop}
        data-drop-hint={assistantAttachmentsCopy.drop}
      >
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
              ) : m.event === "ssh-run" ? (
                <SshRunNote key={m.id} note={m} />
              ) : ["member-grant", "member-reminder", "member-update"].includes(
                  m.event,
                ) ? (
                <MemberGrantNote key={m.id} note={m} />
              ) : m.event === "routine-failed" ? (
                <p
                  key={m.id}
                  className="assistant-note assistant-event"
                  data-routine-failed
                >
                  {routineCopy.chatFailed(m.name)}
                  {m.notes?.includes("ssh_refused") ? ` · ${routineCopy.sshRefused}` : ""}
                </p>
              ) : m.event === "memory-note" ? (
                <p
                  key={m.id}
                  className="assistant-note assistant-event"
                  data-memory-note={m.reason}
                >
                  {memoryNoteCopy.reasons[m.reason] || memoryNoteCopy.unknown}
                </p>
              ) : m.event === "compaction" ? (
                <p
                  key={m.id}
                  className="assistant-note assistant-event"
                  data-compaction-note
                >
                  {compactionNoteText(copy, m)}
                </p>
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
                  cut={m.cut === true}
                  partial={m.partial === true}
                  source={m.source}
                  sender={m.sender}
                  timestamp={m.timestamp}
                  attachments={m.attachments}
                  forwarded={m.forwarded === true}
                  mentions={mentions}
                  scheduled={m.scheduled || null}
                />
              ),
            )}
            {active &&
              latest.internal &&
              history.messages.findLast((m) => !noteEvents.has(m.event))?.event !==
                latest.internal && (
                <p className="assistant-note assistant-event">
                  {copy.team.internalTurns[latest.internal]}
                </p>
              )}
            {active &&
              !latest.internal &&
              !history.messages.some((m) => sameTurn(m, latest)) && (
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
            {delta?.text && !streamInHistory(delta, history) && (
              <AssistantMessage
                role="assistant"
                name={assistant.name}
                text={delta.text}
                streaming={Boolean(active)}
              />
            )}
            {latest?.attempt && (
              <p
                role="status"
                className={`assistant-note assistant-run-state${active && !uncertain ? " working" : ""}`}
                data-compacting={compacting || undefined}
              >
                {active && !uncertain && (
                  <span className="assistant-run-dot" aria-hidden="true" />
                )}
                {compacting ? copy.compaction.running : copy.status[latest.attempt.state]}
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
          <AssistantActionApprovals {...ownActions} assistantId={assistant.id} />
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
          attachments={attachments}
          text={text}
          setText={setText}
          teamAllowed={teamAllowed}
          setTeamAllowed={setTeamAllowed}
          canSend={canSend}
          busy={busy}
          active={Boolean(active)}
          touchInput={touchInput}
          onSubmit={send}
          queued={queued}
          available={available}
          onTakeBack={takeBackQueued}
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
