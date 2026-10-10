import AssistantTeams from "./AssistantTeams.jsx";
import AssistantHeader from "./AssistantHeader.jsx";
import AssistantActionApprovals from "./AssistantActionApprovals.jsx";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import AssistantMessage from "./AssistantMessage.jsx";
import CodingRunNote from "./CodingRunNote.jsx";
import { plainText } from "./plain-text.js";
import useTouchInput from "../chat/useTouchInput.js";
import { enterKeyHint, sendHint, shouldSubmitOnEnter } from "../chat/enter-submit.js";
import ChatScrollToBottom from "../chat/ChatScrollToBottom.jsx";
import useSessionViewport from "../sessions/useSessionViewport.js";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { assistantApi } from "./assistant-api.js";
import useAssistants, { useAssistantEvent } from "./useAssistants.js";
// Streamed deltas re-render the chat on every token; the team panel does not need to.
const Teams = memo(AssistantTeams);
export default function AssistantChat({
  assistant,
  conversationId,
  focusTeamId,
  navigate,
}) {
  const {
    drafts,
    connected,
    runtime,
    members = [],
    conversations = [],
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
  const canSend = Boolean(
    text.trim() &&
    !busy &&
    !active &&
    !memberBusy &&
    !assistant.archivedAt &&
    runtime.availability === "ready",
  );
  const lastReply = history.messages.findLast((m) => m.role === "assistant");
  const announcement =
    lastReply && baseline.current !== undefined && lastReply.id !== baseline.current
      ? plainText(lastReply.text)
      : "";
  // Follow the newest content only while the reader is at the bottom.
  useLayoutEffect(() => {
    const element = output.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
    scroll.current = element.scrollTop;
  }, [history.messages, history.requests, delta, busy]);
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
  async function send(event) {
    event.preventDefault();
    if (!canSend) return;
    stick.current = true;
    setBusy(true);
    setError("");
    try {
      const submitted = drafts.delivery(conversationId);
      await assistantApi.send(conversationId, submitted);
      if (drafts.acknowledge(conversationId, submitted.clientRequestId)) {
        setText("");
        setTeamAllowed(false);
      }
      await refresh();
    } catch (e) {
      setError(e.message);
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
  return (
    <section className="assistant-detail assistant-chat">
      <AssistantHeader
        assistant={assistant}
        view="conversation"
        navigate={navigate}
        state={active ? latest.attempt.state : runtime.availability}
        label={
          !active && memberBusy && runtime.availability === "ready"
            ? copy.team.states[member.phase]
            : undefined
        }
        onChat={() =>
          navigate({ view: "agents", assistantId: assistant.id, conversationId })
        }
      />
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
          <Teams assistant={assistant} focusTeamId={focusTeamId} navigate={navigate} />
          {!assistant.teamMemberId && (
            <AssistantActionApprovals assistantId={assistant.id} />
          )}
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
            {history.messages.map((m) =>
              m.event === "coding-run" ? (
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
                (m) => m.role === "user" && m.text === latest.text,
              ) && (
                <article className="assistant-message user">
                  <strong>{copy.you}</strong>
                  <p>{latest.text}</p>
                </article>
              )}
            {delta && (
              <AssistantMessage role="assistant" name={assistant.name} text={delta} />
            )}
            {latest?.attempt && (
              <p role="status" className="assistant-note">
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
        </div>
        <div
          className="assistant-announcer"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </div>
        <form className="assistant-composer" onSubmit={send}>
          <ChatScrollToBottom active output={output} stick={stick} scroll={scroll} />
          <label className="sr-only" htmlFor="assistant-message">
            {copy.message}
          </label>
          <textarea
            id="assistant-message"
            value={text}
            maxLength={65536}
            rows={2}
            enterKeyHint={enterKeyHint(touchInput)}
            placeholder={copy.messagePlaceholder}
            onKeyDown={(event) => {
              if (!shouldSubmitOnEnter(event, touchInput)) return;
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form.requestSubmit();
            }}
            onChange={(e) => {
              setText(e.target.value);
              drafts.set(conversationId, e.target.value);
            }}
          />
          <div className="assistant-actions">
            <span className="chat-send-hint">{sendHint(touchInput)}</span>
            {!assistant.teamMemberId && (
              <label className="assistant-team-permission">
                <input
                  type="checkbox"
                  checked={teamAllowed}
                  onChange={(e) => {
                    setTeamAllowed(e.target.checked);
                    drafts.allowTeam(conversationId, e.target.checked);
                  }}
                />
                {copy.team.allowOnce}
              </label>
            )}
            {active && (
              <button
                type="button"
                className="button secondary"
                onClick={async () => {
                  try {
                    await assistantApi.cancel(latest.attempt.id);
                    await refresh();
                  } catch (e) {
                    setError(e.message);
                  }
                }}
              >
                {copy.stop}
              </button>
            )}
            <button className="button primary" disabled={!canSend}>
              {busy ? copy.loading : copy.send}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
