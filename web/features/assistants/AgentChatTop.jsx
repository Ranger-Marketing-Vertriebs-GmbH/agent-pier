import React from "react";
import Icon from "../../components/Icon.jsx";
import useMobileLayout from "../../lib/useMobileLayout.js";
import { agentChatsCopy } from "../../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy } from "../../lib/i18n/messages/agent-pinboard.js";
import TalkButton from "../talk/TalkButton.jsx";
import AgentEventsButton from "./AgentEventsButton.jsx";
import AssistantHeader from "./AssistantHeader.jsx";
import ChatStrips from "./ChatStrips.jsx";
import ChatSwitchRow from "./ChatSwitchRow.jsx";
import SummariseConfirm from "./SummariseConfirm.jsx";
import WorkGoalButton from "./WorkGoalButton.jsx";
import OwnerChatSelector from "./chats/OwnerChatSelector.jsx";
import SummariseNowButton from "./chats/SummariseNowButton.jsx";
import useOwnerChats from "./chats/useOwnerChats.js";
import "./agent-chat-top.css";

/**
 * Everything above an owner's agent chat transcript: one header row (the chat's title
 * under the agent's name, the work goal and the events as icons) and, on phones and
 * in split-view panes, one row with the Chat | Pinboard switch, the Chats sheet, New
 * chat and Summarize now (a team member's chat has no row: a header pin icon toggles
 * its pinboard). Wider, the header carries Pinboard, New chat and Summarize
 * now itself; the pinboard docks beside the chat. Then the chat's strips.
 * `pinboard` is useChatPinboard's result; `talk` is `{ shown, talk, status }`;
 * `summarise` is summariseAction's result; `strips` ChatStrips' `entry`, `output`
 * and `stick`.
 */
export default function AgentChatTop({
  assistant,
  conversationId,
  navigate,
  openNavigation,
  navigationOpen,
  pane,
  attempt,
  member,
  compacting,
  history,
  onStopped,
  talk,
  available,
  summarise,
  longChat,
  strips,
  pinboard,
}) {
  const phone = useMobileLayout();
  const compact = phone || Boolean(pane);
  const owner = useOwnerChats(assistant, conversationId, navigate);
  // A team member has one chat; a user's own agent's chats are hers to start.
  const chatList = !assistant.teamMemberId;
  const newChat = chatList && assistant.userAccess?.mode !== "own";
  const shownSummarise = chatList ? summarise : null;
  const pinLabel = agentPinboardCopy.tabWithCount(pinboard.fresh);
  const actions = (
    <>
      <WorkGoalButton
        goal={history.goal}
        conversationId={conversationId}
        onStopped={onStopped}
      />
      <AgentEventsButton
        assistantId={assistant.id}
        conversationId={conversationId}
        events={history.events}
        navigate={navigate}
      />
      {/* A member's chat has no row under the header: its pinboard is an icon. */}
      {compact && !chatList && pinboard.enabled && (
        <button
          type="button"
          className="assistant-header-icon agent-chat-pin"
          aria-label={pinLabel}
          title={pinLabel}
          aria-pressed={pinboard.open}
          onClick={() => pinboard.setOpen(!pinboard.open)}
        >
          <Icon name="pin" size={18} />
          {pinboard.fresh > 0 && (
            <span className="agent-chat-events-count">{pinboard.fresh}</span>
          )}
        </button>
      )}
      {!compact && pinboard.enabled && (
        <button
          type="button"
          className="button secondary compact agent-chat-top-action"
          aria-expanded={pinboard.open}
          onClick={() => pinboard.setOpen(!pinboard.open)}
        >
          <Icon name="pin" size={14} />
          {pinLabel}
        </button>
      )}
      {!compact && newChat && (
        <button
          type="button"
          className="button secondary compact agent-chat-top-action"
          disabled={!!assistant.archivedAt}
          onClick={owner.create}
        >
          <Icon name="plus" size={14} />
          {agentChatsCopy.newChat}
        </button>
      )}
      {!compact && shownSummarise && <SummariseNowButton {...shownSummarise} />}
      {talk.shown && (
        <TalkButton
          talk={talk.talk}
          reason={talk.status.reason || (!available && "unknown")}
          loading={!talk.status.status}
        />
      )}
    </>
  );
  // A team member's chat gets no row: it never had the chat selector row.
  const row = compact && chatList && (pinboard.enabled || newChat || shownSummarise);
  return (
    <>
      <AssistantHeader
        assistant={assistant}
        variant="conversation"
        navigate={navigate}
        openNavigation={openNavigation}
        navigationOpen={navigationOpen}
        attempt={attempt}
        member={member}
        compacting={compacting}
        pane={pane}
        actions={actions}
        statusExtra={
          chatList && (
            <OwnerChatSelector
              assistant={assistant}
              conversationId={conversationId}
              owner={owner}
            />
          )
        }
      />
      {row && (
        <ChatSwitchRow
          assistant={assistant}
          tab={pinboard.open ? "pinboard" : "chat"}
          onTab={pinboard.enabled ? (tab) => pinboard.setOpen(tab === "pinboard") : null}
          fresh={pinboard.fresh}
          summarise={shownSummarise}
          onChats={chatList ? () => owner.setOpen(true) : null}
          onNewChat={newChat ? owner.create : null}
        />
      )}
      <SummariseConfirm longChat={longChat} />
      <ChatStrips
        entry={strips.entry}
        output={strips.output}
        stick={strips.stick}
        conversationId={conversationId}
        member={member}
        navigate={navigate}
      />
    </>
  );
}
