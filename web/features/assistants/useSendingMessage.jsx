import React, { useState } from "react";
import AssistantMessage from "./AssistantMessage.jsx";
import { assistantCopy as copy } from "../../lib/i18n/messages/assistants.js";

/**
 * A sent message leaves the composer at once and shows in the transcript while the
 * server still takes it (`sending`): the acknowledgement waits for the agent service
 * and may take seconds. A refused one comes back into the field, before what was
 * typed since (AssistantDrafts.restore), with the error `deliver` shows.
 */
export default function useSendingMessage({
  conversationId,
  drafts,
  setText,
  setTeamAllowed,
}) {
  const [sending, setSending] = useState(null);
  async function sendAhead(deliver, ids) {
    const submitted = drafts.delivery(conversationId);
    drafts.clear(conversationId);
    setText("");
    setTeamAllowed?.(false);
    setSending({ ...submitted, at: Date.now() });
    const sent = await deliver(submitted, ids);
    setSending(null);
    if (!sent) {
      setText(drafts.restore(conversationId, submitted));
      if (submitted.teamAllowed) setTeamAllowed?.(true);
    }
    return sent;
  }
  return { sending, sendAhead };
}

/** The message on its way, until the history carries its request. */
export function SendingMessage({ sending, history, mentions }) {
  const known = history.requests?.some(
    (r) => r.clientRequestId === sending?.clientRequestId,
  );
  if (!sending?.text.trim() || known) return null;
  return (
    <AssistantMessage
      role="user"
      name={copy.you}
      text={sending.text}
      timestamp={sending.at}
      mentions={mentions}
    />
  );
}
