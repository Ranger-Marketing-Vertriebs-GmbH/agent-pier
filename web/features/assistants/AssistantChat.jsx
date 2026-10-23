import TeamApprovals from "./TeamApprovals.jsx";
import { foldResultEvents, teamNotes, withTeamNotes } from "./team-notes.js";
import { anchorToChild } from "./transcript-scroll.js";
import {
  emptyHistoryView,
  shownHistory,
  withLive,
  withOlder,
} from "./agent-history-view.js";
import useAgentConversationStream from "./useAgentConversationStream.js";
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
import GoAheadButton from "./GoAheadButton.jsx";
import useAgentAttachments from "./useAgentAttachments.js";
import useFileDrop from "../../components/useFileDrop.js";
import { assistantAttachmentsCopy } from "../../lib/i18n/messages/assistant-attachments.js";
import AssistantMessage from "./AssistantMessage.jsx";
import TranscriptItem from "./TranscriptItem.jsx";
import { plainText } from "./plain-text.js";
import useTouchInput from "../chat/useTouchInput.js";
import useSessionViewport from "../sessions/useSessionViewport.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantApi } from "./assistant-api.js";
import useAssistants from "./useAssistants.js";
import { leadMembers } from "./useMemberMention.js";
import { streamInHistory } from "./stream-reply.js";
import { takeBack } from "./queued-message.js";
import useAwaitingConfirmation from "./unconfirmed-turn.js";
import AgentRunState from "./AgentRunState.jsx";
import useLongChat from "./useLongChat.js";
import { memoryStepTurn, stepsOf, useRetry } from "./run-steps.js";
import OwnerChatBar from "./chats/OwnerChatBar.jsx";
import { ArchivedChatBanner, ReadOnlyComposer } from "./chats/ChatStates.jsx";
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
    offline: serviceOffline,
    histories,
    runtime,
    assistants = [],
    members = [],
    teams = [],
    conversations = [],
    activity = {},
    refresh: reloadList,
  } = useAssistants();
  const record = conversations.find((c) => c.id === conversationId);
  const conversationFault = copy.conversationDiagnostics[record?.diagnostic];
  // An archived chat is read-only until restored (AGENTPIER-181).
  const archived = Boolean(record?.archivedAt);
  // A user's chat, and every chat of her own agent, is hers: the owner reads it under
  // her opt-in and never writes into it (owner-content-guard.js).
  const userChat =
    typeof record?.userId === "string" || assistant.userAccess?.mode === "own";
  const readOnly = archived || userChat;
  const [teamAllowed, setTeamAllowed] = useState(() =>
    drafts.teamAllowed(conversationId),
  );
  const [text, setText] = useState(() => drafts.get(conversationId));
  // The live window, the rows it pushed out and the older pages (agent-history-view.js).
  // A chat opened again starts from its last window, which stays while offline and
  // lets the feed resume with a diff.
  const [view, setView] = useState(() => {
    const cached = histories?.get(conversationId);
    return cached ? withLive(emptyHistoryView, cached) : emptyHistoryView;
  });
  const history = useMemo(() => shownHistory(view), [view]);
  // The history read failed for want of a connection.
  const [unreachable, setUnreachable] = useState(false);
  const offline = serviceOffline || unreachable;
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
  // works. An archived agent and a read-only chat take none: their composer, which
  // shows the upload and its error, is not there.
  const drop = useFileDrop({
    enabled: !assistant.archivedAt && !readOnly,
    onFiles: attachments.add,
  });
  // The newest reply that was already there on load is history, not news.
  const baseline = useRef(undefined);
  const output = useRef(null);
  const stick = useRef(true);
  const scroll = useRef(0);
  // The transcript height the last resize left; see onScroll.
  const outputHeight = useRef(0);
  // The transcript's distance from its end before an older page was prepended.
  const prepended = useRef(null);
  // Keeps the composer above the on-screen keyboard, as the session chat does.
  useSessionViewport(true);
  // The feed pushes every change of this chat; actions only await their request.
  const feed = useAgentConversationStream(conversationId, {
    initial: histories?.get(conversationId),
    onLive: (live) => {
      if (baseline.current === undefined)
        baseline.current =
          live.messages.findLast((m) => m.role === "assistant")?.id ?? null;
      setView((current) => withLive(current, live));
      histories?.set(conversationId, live);
    },
    onReachable: (reachable) => setUnreachable(!reachable),
  });
  // The streamed reply so far, with its run: { runId, text } or null.
  const delta = feed.stream;
  const refresh = feed.refresh;
  const removeShared = useCallback(
    async (file) => {
      await assistantApi.deleteSharedFile(conversationId, file.id);
      await refresh();
    },
    [conversationId, refresh],
  );
  const member = members.find((m) => m.assistantId === assistant.id);
  const memberBusy =
    member && !["completed", "failed", "cancelled"].includes(member.phase);
  const latest = history.requests?.at(-1);
  const active =
    latest?.attempt &&
    !latest.attempt.reviewedAt &&
    !["completed", "failed", "cancelled"].includes(latest.attempt.state);
  // A lost send acknowledgement waits calmly while the run may still show progress.
  const awaiting = useAwaitingConfirmation(
    latest?.attempt,
    `${history.messages.length}:${delta?.text?.length ?? 0}`,
  );
  const uncertain =
    !awaiting && ["uncertain", "interrupted"].includes(latest?.attempt?.state);
  const shownAttempt = awaiting
    ? { ...latest.attempt, state: "unconfirmed" }
    : latest?.attempt;
  // The run summarises its long history before it answers (compactions.js), or the
  // owner had it summarised (useLongChat.js; "memory" while its memory step runs first).
  const ownStep = memoryStepTurn(latest);
  const compacting = ((!uncertain || ownStep) && history.compacting) || false;
  // Every agent's own requests wait in its chat: a permanent member may have a shell.
  // The feed carries them while its socket is connected; else the hook reads them.
  const liveActions = view.live?.actions;
  const pushedActions =
    feed.connection === "connected" && Array.isArray(liveActions) ? liveActions : null;
  const ownActions = useAssistantActions(assistant.id, pushedActions);
  const entry = activityFor(activity, assistant.id);
  const canSend = Boolean(
    (text.trim() || files) &&
    !busy &&
    !active &&
    !history.queued &&
    !memberBusy &&
    !assistant.archivedAt &&
    !readOnly &&
    !offline &&
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
  // An older page lands above what the reader sees, which keeps its place.
  useLayoutEffect(() => {
    const element = output.current;
    const distance = prepended.current;
    prepended.current = null;
    if (!element || distance === null) return;
    element.scrollTop = element.scrollHeight - distance;
    scroll.current = element.scrollTop;
    stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
  }, [history.messages]);
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
    outputHeight.current = element.clientHeight;
    const resize = new ResizeObserver(() => {
      if (stick.current) element.scrollTop = element.scrollHeight;
      outputHeight.current = element.clientHeight;
    });
    resize.observe(element);
    return () => resize.disconnect();
  }, []);
  // A team link (/agents/:id/teams/:teamId) shows what the team needs from the owner,
  // or else its latest note, once the history is rendered (not just received) and either
  // is there; it stays there while late content shifts, until the reader moves.
  const focused = useRef("");
  const unanchor = useRef(null);
  useEffect(() => () => unanchor.current?.(), []);
  useEffect(() => {
    if (!focusTeamId || focused.current === focusTeamId || !view.live) return;
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
    unanchor.current = anchorToChild(element, target, () => !stick.current);
  });
  // One delivery of a message; `accepted` runs once the server has taken it.
  async function deliver(submitted, ids, accepted) {
    stick.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await assistantApi.send(
        conversationId,
        ids.length ? { ...submitted, attachments: ids } : submitted,
      );
      accepted?.();
      // `/new` started a chat (chat-commands.js): it opens once the list knows it.
      const created = result?.created;
      await (created ? reloadList?.() : refresh());
      const view = "agents";
      if (created)
        navigate?.({ view, assistantId: assistant.id, conversationId: created });
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
    !memberBusy &&
    !assistant.archivedAt &&
    !readOnly &&
    !offline &&
    runtime.availability === "ready";
  // While the agent works, or a queued message still waits, Enter and "Send when
  // done" queue the message, after the waiting one: only Stop stops a turn.
  async function queue(ids) {
    if (assistant.archivedAt || offline || (!text.trim() && !ids.length)) return false;
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
    if (active || queued || compacting) return queue(ids);
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
      const element = output.current;
      if (element) prepended.current = element.scrollHeight - element.scrollTop;
      setView((current) => withOlder(current, page));
    } catch (e) {
      setError(e.message);
    }
  }
  async function stop() {
    try {
      await assistantApi.cancel(latest.attempt.id);
      await refresh();
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }
  async function recover() {
    setBusy(true);
    try {
      await assistantApi.recover(latest.attempt.id);
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const retry = useRetry({ active, stop, deliver, setBusy });
  const longChat = useLongChat(assistantApi, conversationId, {
    refresh,
    onError: setError,
  });
  return (
    <section className="assistant-detail assistant-chat">
      <AssistantHeader
        assistant={assistant}
        variant="conversation"
        navigate={navigate}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        attempt={active ? shownAttempt : null}
        member={member}
        compacting={compacting}
      />
      <OwnerChatBar
        assistant={assistant}
        conversationId={conversationId}
        navigate={navigate}
      />
      <AssistantApprovalStrip count={entry.pendingApprovals} output={output} />
      {member && <AssistantMemberContext member={member} navigate={navigate} />}

      <div
        className="assistant-chat-panel"
        {...drop}
        data-drop-hint={assistantAttachmentsCopy.drop}
      >
        <ErrorMessage error={error || feed.error} />
        {(!connected || offline) && (
          <p role="status" className="assistant-notice">
            {copy.disconnected}
          </p>
        )}
        {archived && !userChat && (
          <ArchivedChatBanner
            onRestore={async () => {
              await assistantApi.restoreChat(conversationId);
              await reloadList();
            }}
          />
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
            // Resizing can emit scroll before ResizeObserver runs. It must not
            // turn off bottom-following as though the user scrolled backwards.
            if (element.clientHeight !== outputHeight.current) return;
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
            {transcript.map((item) => (
              <TranscriptItem
                key={item.note?.id ?? item.message.id}
                item={item}
                assistant={assistant}
                navigate={navigate}
                focusedNote={focusedNote}
                mentions={mentions}
                removeShared={offline ? null : removeShared}
              />
            ))}
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
            <AgentRunState
              attempt={latest?.attempt}
              shownAttempt={shownAttempt}
              active={Boolean(active)}
              uncertain={uncertain}
              compacting={compacting}
              compactOutcome={history.compactOutcome}
              memoryNotSaved={history.memoryNotSaved}
              steps={stepsOf(feed.steps, latest?.attempt)}
              longChat={history.longChat}
              longChatActions={available ? longChat : null}
              busy={busy}
              onStop={readOnly ? null : stop}
              onRetry={available && !queued && !ownStep ? retry : null}
              awaiting={awaiting}
              explainUncertain
              onRecover={recover}
            />
          </div>
          <GoAheadButton
            latest={latest}
            available={available && !history.queued}
            busy={busy}
            onSend={(message) =>
              deliver({ clientRequestId: crypto.randomUUID(), text: message }, [])
            }
          />
          {!member && (
            <PendingTeams
              assistant={assistant}
              navigate={navigate}
              pushed={pushedActions}
            />
          )}
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
        {readOnly ? (
          <ReadOnlyComposer userChat={userChat} />
        ) : (
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
            // A user's agent never leads a team (user-agent-lock.js), also for the owner.
            team={!assistant.userAccess}
          />
        )}
      </div>
    </section>
  );
}
