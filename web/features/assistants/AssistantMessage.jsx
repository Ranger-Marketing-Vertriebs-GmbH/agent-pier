import React, { memo, useId } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import AgentMessageAttachments from "./AgentMessageAttachments.jsx";
import "./assistant-message-source.css";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { formatMessageTime } from "../../lib/i18n/index.js";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
// The owner's own name stays for screen readers only; the bubble already says who.
// An owner message that reached the agent through Telegram gets a quiet meta line
// under the bubble, which also describes the message for screen readers.
export default memo(function AssistantMessage({
  role,
  name,
  text,
  streaming = false,
  source = null,
  timestamp = 0,
  attachments = null,
}) {
  const metaId = useId();
  const telegram = role === "user" && source === "telegram";
  const message = (
    <article
      className={`assistant-message ${role}${streaming ? " streaming" : ""}`}
      aria-describedby={telegram ? metaId : undefined}
    >
      <strong className={role === "user" ? "sr-only" : undefined}>{name}</strong>
      <AgentMessageAttachments files={attachments} />
      {(text || !attachments?.length) && (
        <div className="message-content">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      )}
    </article>
  );
  if (!telegram) return message;
  return (
    <div className="assistant-turn">
      {message}
      <p className="assistant-message-meta" id={metaId}>
        <TelegramMeta timestamp={timestamp} />
      </p>
    </div>
  );
});

function TelegramMeta({ timestamp }) {
  const words = copy.telegramSource;
  if (!(timestamp > 0)) return words.via;
  const time = formatMessageTime(new Date(timestamp));
  return (
    <>
      <span aria-hidden="true">{words.at(words.via, time)}</span>
      <span className="sr-only">{words.spokenAt(words.via, time)}</span>
    </>
  );
}
