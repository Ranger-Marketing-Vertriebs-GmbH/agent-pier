import React, { memo, useId, useMemo } from "react";
import ChatMarkdown from "../../components/ChatMarkdown.jsx";
import AgentMessageAttachments from "./AgentMessageAttachments.jsx";
import SharedFileDelete from "./SharedFileDelete.jsx";
import { assistantAttachmentsCopy } from "../../lib/i18n/messages/assistant-attachments.js";
import "./assistant-message-source.css";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";
import { leadRequestCopy } from "../../lib/i18n/messages/lead-requests.js";
import { routineCopy } from "../../lib/i18n/messages/assistant-routines.js";
import { formatChatTime } from "../../lib/i18n/index.js";
import ChatTime from "./ChatTime.jsx";
import { remarkMemberMentions } from "./mention-markdown.js";
import RouteLink from "./RouteLink.jsx";
import "./member-mentions.css";

// Memoized so a streamed delta re-parses only the streaming message, not the history.
// The owner's own name stays for screen readers only; the bubble already says who.
// A message with a timestamp shows its time beside the speaker's name, or at the top of
// the owner's bubble. Where the meta line below already names the time, it stays there.
// An owner message that reached the agent through Telegram, and a question or task
// the member's lead agent sent, get a quiet meta line under the bubble, which also
// describes the message for screen readers. In a lead's chat the owner's @mentions
// of its members (`mentions`: `{ members, navigate }`) become chips to their chats.
// A routine's result (`scheduled`: `{ name, kind?, notes? }`) carries a badge beside the
// agent's name, and a note when AgentPier refused SSH during the run.
// A message the history could not load whole (`cut`), or has not loaded whole yet
// (`partial`), ends with a short note. A file the agent shared (`shared`) shows its
// caption as the text; one no longer stored (`unavailable`) says so, and
// `removeShared(file)` lets the owner delete it.
export default memo(function AssistantMessage({
  role,
  name,
  text,
  cut = false,
  partial = false,
  streaming = false,
  source = null,
  sender = null,
  timestamp = 0,
  attachments = null,
  mentions = null,
  forwarded = false,
  scheduled = null,
  shared = false,
  unavailable = false,
  removeShared = null,
}) {
  const metaId = useId();
  const lead = role === "user" && source === "lead" && typeof sender?.name === "string";
  // Only the owner's own messages (here or through Telegram) can mention a member.
  const owner =
    role === "user" &&
    !forwarded &&
    (!source || (source === "telegram" && sender?.kind === "owner"));
  const chips = owner && mentions?.members.length ? mentions : null;
  const markdown = useMemo(
    () =>
      chips
        ? {
            plugins: [remarkMemberMentions(chips.members)],
            components: { "member-mention": mentionChip(chips) },
          }
        : {},
    [chips],
  );
  const marked = role === "user" && (source === "telegram" || lead);
  const message = (
    <article
      className={`assistant-message ${role}${streaming ? " streaming" : ""}`}
      aria-describedby={marked ? metaId : undefined}
    >
      {/* A lead's message is the lead's words, not the owner's. */}
      {role === "assistant" && scheduled ? (
        <div className="assistant-message-head">
          <strong>{name}</strong>
          <ChatTime timestamp={timestamp} />
          <span className="assistant-scheduled-badge">
            {scheduled.kind === "heartbeat"
              ? routineCopy.checkInBadge
              : routineCopy.chatBadge(scheduled.name)}
          </span>
          {scheduled.notes?.includes("ssh_refused") && (
            <span className="assistant-note">{routineCopy.sshRefused}</span>
          )}
        </div>
      ) : (
        <Speaker
          hidden={role === "user"}
          name={lead ? sender.name : name}
          timestamp={marked ? 0 : timestamp}
        />
      )}
      <AgentMessageAttachments files={attachments} shared={shared} />
      {unavailable && (
        <p className="assistant-note">{assistantAttachmentsCopy.sharedUnavailable}</p>
      )}
      {(text || (!attachments?.length && !unavailable)) && (
        <div className="message-content">
          <ChatMarkdown {...markdown}>{text}</ChatMarkdown>
        </div>
      )}
      {shared &&
        removeShared &&
        attachments?.map((file) => (
          <SharedFileDelete key={file.id} file={file} remove={removeShared} />
        ))}
      {(cut || partial) && (
        <p className="assistant-message-cut">
          {cut ? copy.messageCut : copy.messagePartial}
        </p>
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

const mentionChip = ({ members, navigate }) =>
  function MemberMention({ node, children }) {
    const member = members.find((m) => m.id === node?.properties?.member);
    if (!member) return children;
    return (
      <RouteLink
        className="member-mention-chip"
        route={member.route}
        navigate={navigate}
        title={leadRequestCopy.mentions.open(member.name)}
      >
        {children}
      </RouteLink>
    );
  };

const leadWords = (name) => ({
  via: leadRequestCopy.from(name),
  at: leadRequestCopy.at,
  spokenAt: leadRequestCopy.spokenAt,
});

function Speaker({ hidden, name, timestamp }) {
  const label = <strong className={hidden ? "sr-only" : undefined}>{name}</strong>;
  if (!(timestamp > 0)) return label;
  return (
    <div className="assistant-message-head">
      {label}
      <ChatTime timestamp={timestamp} />
    </div>
  );
}

function SourceMeta({ words, timestamp }) {
  if (!(timestamp > 0)) return words.via;
  const time = formatChatTime(timestamp);
  return (
    <>
      <span aria-hidden="true">{words.at(words.via, time)}</span>
      <span className="sr-only">{words.spokenAt(words.via, time)}</span>
    </>
  );
}
