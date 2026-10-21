import React, { useLayoutEffect, useRef, useState } from "react";
import "../assistants/assistants.css";
import "../assistants/assistant-chat.css";
import Icon from "../../components/Icon.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import AssistantComposer from "../assistants/AssistantComposer.jsx";
import AssistantMessage from "../assistants/AssistantMessage.jsx";
import AssistantActionApprovals from "../assistants/AssistantActionApprovals.jsx";
import TranscriptItem from "../assistants/TranscriptItem.jsx";
import useAgentAttachments from "../assistants/useAgentAttachments.js";
import useTouchInput from "../chat/useTouchInput.js";
import useSessionViewport from "../sessions/useSessionViewport.js";
import { streamInHistory } from "../assistants/stream-reply.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { userAppCopy as copy } from "../../lib/i18n/messages/user-app.js";
import UserHeader from "./UserHeader.jsx";
import SharedAgentNotice from "./SharedAgentNotice.jsx";
import OwnerReadsNotice from "./OwnerReadsNotice.jsx";
import { AgentAvatar, agentActivity } from "./MyAgentsPage.jsx";
import useUserConversation from "./useUserConversation.js";
import useUserApprovals from "./useUserApprovals.js";
import { ReadOnlyComposer } from "../assistants/chats/ChatStates.jsx";

const sameTurn = (m, request) =>
  m.role === "user" &&
  (m.requestId
    ? m.requestId === request.id
    : String(m.text).trimEnd() === String(request.text).trimEnd());
const none = () => {};

/**
 * A user's chat with one of her agents, in her slim app: the agent chat's transcript
 * and composer over her /api/me routes. `chatSwitch` (the chat's title, which opens
 * her chat list), `banner` and `readOnly` (an archived chat) come from UserChatRoute.
 */
export default function UserChat({
  agent,
  conversationId,
  navigate,
  histories,
  subscribe,
  ownerMayRead,
  chatSwitch = null,
  banner = null,
  readOnly = false,
}) {
  const chat = useUserConversation(conversationId, { histories, readOnly });
  const { history, latest, active } = chat;
  const approvals = useUserApprovals(agent.id, subscribe);
  const attachments = useAgentAttachments(conversationId);
  const touchInput = useTouchInput();
  const [files, setFiles] = useState(0);
  const output = useRef(null);
  const stick = useRef(true);
  const scroll = useRef(0);
  const prepended = useRef(null);
  useSessionViewport(true);
  const delta = chat.feed.stream;
  useLayoutEffect(() => {
    const element = output.current;
    const distance = prepended.current;
    prepended.current = null;
    if (!element || distance === null) return;
    element.scrollTop = element.scrollHeight - distance;
  }, [history.messages]);
  useLayoutEffect(() => {
    const element = output.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
    scroll.current = element.scrollTop;
  }, [history.messages, history.requests, delta, chat.busy]);
  const canSend = Boolean(
    (chat.text.trim() || files) &&
    !chat.busy &&
    !active &&
    !chat.queued &&
    chat.available,
  );
  const send = (event, ids) => {
    stick.current = true;
    return chat.send(event, ids);
  };
  return (
    <section className="assistant-detail assistant-chat user-chat">
      <UserHeader
        onBack={() => navigate({ view: "agents" })}
        backLabel={copy.myAgents}
        navigate={navigate}
        actions={
          <>
            <button
              type="button"
              className="icon-button user-header-action"
              aria-label={copy.settingsOf(agent.name)}
              onClick={() => navigate({ view: "settings", agentId: agent.id })}
            >
              <Icon name="settings" />
            </button>
          </>
        }
      >
        <div className="user-chat-agent">
          <AgentAvatar agent={agent} />
          <div className="user-chat-agent-text">
            <div className="user-chat-agent-name">
              <h1>{agent.name}</h1>
              <StatusDot
                tone={active ? "working" : "ok"}
                pulse={active}
                label={active ? assistantCopy.status.running : agentActivity(agent)}
              />
            </div>
            {chatSwitch}
          </div>
        </div>
      </UserHeader>
      <div className="assistant-chat-panel">
        <ErrorMessage error={chat.error} />
        {chat.unreachable && (
          <p role="status" className="assistant-notice">
            {assistantCopy.disconnected}
          </p>
        )}
        {banner}
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
          <div role="log" aria-live="off" aria-label={assistantCopy.conversation}>
            {history.nextBefore && (
              <button
                className="button secondary"
                onClick={() =>
                  chat.earlier(() => {
                    const element = output.current;
                    if (element)
                      prepended.current = element.scrollHeight - element.scrollTop;
                  })
                }
              >
                {assistantCopy.earlier}
              </button>
            )}
            {!history.messages.length && !latest && (
              <div className="assistant-empty">
                <h2>{assistantCopy.emptyChat}</h2>
              </div>
            )}
            {history.messages.map((message) => (
              <TranscriptItem
                key={message.id}
                item={{ message }}
                assistant={agent}
                navigate={none}
                mentions={null}
                removeShared={null}
              />
            ))}
            {active &&
              !latest.internal &&
              !history.messages.some((m) => sameTurn(m, latest)) && (
                <AssistantMessage
                  role="user"
                  name={assistantCopy.you}
                  text={latest.text}
                  attachments={latest.attachments}
                  timestamp={Date.parse(latest.createdAt) || 0}
                />
              )}
            {delta?.text && !streamInHistory(delta, history) && (
              <AssistantMessage
                role="assistant"
                name={agent.name}
                text={delta.text}
                streaming={active}
              />
            )}
            {latest?.attempt && (
              <p
                role="status"
                className={`assistant-note assistant-run-state${active && !chat.uncertain ? " working" : ""}`}
              >
                {active && !chat.uncertain && (
                  <StatusDot tone="working" pulse className="assistant-run-dot" />
                )}
                {assistantCopy.status[chat.shownAttempt.state]}
              </p>
            )}
            {chat.awaiting && (
              <p className="assistant-notice">{assistantCopy.unconfirmed}</p>
            )}
            {chat.uncertain && !latest.attempt.reviewedAt && (
              <div className="assistant-notice">
                <p>{assistantCopy.recoverNotice}</p>
                <button
                  type="button"
                  className="button secondary"
                  disabled={chat.busy}
                  onClick={chat.recover}
                >
                  {assistantCopy.recover}
                </button>
              </div>
            )}
          </div>
          <AssistantActionApprovals {...approvals} assistantId={agent.id} />
        </div>
        <div className="user-chat-notices">
          {agent.shared && <SharedAgentNotice />}
          <OwnerReadsNotice ownerMayRead={ownerMayRead} shared={agent.shared} />
        </div>
        {readOnly ? (
          <ReadOnlyComposer />
        ) : (
          <AssistantComposer
            assistant={agent}
            conversationId={conversationId}
            drafts={chat.drafts}
            attachments={attachments}
            text={chat.text}
            setText={chat.setText}
            teamAllowed={false}
            setTeamAllowed={none}
            canSend={canSend}
            busy={chat.busy}
            active={active}
            touchInput={touchInput}
            onSubmit={send}
            queued={chat.queued}
            available={chat.available}
            onTakeBack={() => chat.takeBackQueued(attachments)}
            onFiles={setFiles}
            onStop={chat.stop}
            output={output}
            stick={stick}
            scroll={scroll}
            team={false}
          />
        )}
      </div>
    </section>
  );
}
