// The one message an agent chat holds back while its agent works: Enter or "Send when
// done" queues it, and it goes out once the current turn has ended (completed, failed
// or stopped). Another message joins it on a new line; every change gets a new
// delivery key, so a retried delivery of the same content is sent only once.
const joined = (...parts) =>
  parts
    .map((part) => String(part || "").trimEnd())
    .filter((part) => part.trim())
    .join("\n");

export function queueMessage(
  current,
  { text, teamAllowed = false, files = [] },
  id = () => crypto.randomUUID(),
) {
  return {
    text: joined(current?.text, text),
    teamAllowed: Boolean(current?.teamAllowed || teamAllowed),
    files: [...(current?.files || []), ...files],
    clientRequestId: id(),
  };
}

// The message as the send endpoint takes it; files are added by the caller.
export const queuedDelivery = ({ text, clientRequestId, teamAllowed }) => ({
  text,
  clientRequestId,
  ...(teamAllowed ? { teamAllowed: true } : {}),
});

// Back in the composer, the queued text comes before what was typed since.
export const takeBack = (queued, draft) => joined(queued?.text, draft);

export const sendsQueued = (queued, { active, busy, available }) =>
  Boolean(queued && !active && !busy && available);
