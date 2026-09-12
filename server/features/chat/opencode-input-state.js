/** A persisted user row can still be queued. A native assistant parent link is stronger evidence. */
export function markOpenCodeInput(messages, envelopes) {
  const parents = new Set(
    envelopes
      .filter((m) => m?.info?.role === "assistant")
      .map((m) => m.info.parentID)
      .filter((id) => typeof id === "string" && id),
  );
  const consumed = new Set(
    envelopes
      .filter((m) => m?.info?.role === "user" && parents.has(m.info.id))
      .flatMap((m) => (Array.isArray(m.parts) ? m.parts : []).map((part) => part?.id))
      .filter(Boolean),
  );
  return messages.map((message) =>
    message.role === "user" && consumed.has(message.id)
      ? { ...message, inputConsumed: true }
      : message,
  );
}
