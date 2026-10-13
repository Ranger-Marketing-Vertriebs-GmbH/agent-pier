import React, { memo, useId } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import AgentMessageAttachments from "./AgentMessageAttachments.jsx";
import "./assistant-message-source.css";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { leadRequestCopy } from "../../lib/i18n/messages/lead-requests.js";
import { formatMessageTime } from "../../lib/i18n/index.js";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
// The owner's own name stays for screen readers only; the bubble already says who.
// An owner message that reached the agent through Telegram, and a question or task
// the member's lead agent sent, get a quiet meta line under the bubble, which also
// describes the message for screen readers.
export default memo(function AssistantMessage({
  role,
  name,
  text,
  streaming = false,
  source = null,
  sender = null,
  timestamp = 0,
  attachments = null,
}) {
  const metaId = useId();
  const lead = role === "user" && source === "lead" && typeof sender?.name === "string";
  const marked = role === "user" && (source === "telegram" || lead);
  const message = (
    <article
      className={`assistant-message ${role}${streaming ? " streaming" : ""}`}
      aria-describedby={marked ? metaId : undefined}
    >
      {/* A lead's message is the lead's words, not the owner's. */}
      <strong className={role === "user" ? "sr-only" : undefined}>
        {lead ? sender.name : name}
      </strong>
      <AgentMessageAttachments files={attachments} />
      {(text || !attachments?.length) && (
        <div className="message-content">
          <ChatMarkdown>{text}</ChatMarkdown>
        </div>
      )}
    </article>
  );
  if (!marked) return message;
  return (
    <div className="assistant-turn">
      {message}
      <p className="assistant-message-meta" id={metaId}>
        <SourceMeta
          words={lead ? leadWords(sender.name) : copy.telegramSource}
          timestamp={timestamp}
        />
      </p>
    </div>
  );
});

const leadWords = (name) => ({
  via: leadRequestCopy.from(name),
  at: leadRequestCopy.at,
  spokenAt: leadRequestCopy.spokenAt,
});

function SourceMeta({ words, timestamp }) {
  if (!(timestamp > 0)) return words.via;
  const time = formatMessageTime(new Date(timestamp));
  return (
    <>
      <span aria-hidden="true">{words.at(words.via, time)}</span>
      <span className="sr-only">{words.spokenAt(words.via, time)}</span>
    </>
  );
}
