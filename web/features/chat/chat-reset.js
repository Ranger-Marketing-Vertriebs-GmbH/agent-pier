/** A handoff requests a reset; only a fresh native identity confirms it. */
export function resetPresentation(reset, data, restartGeneration = 0) {
  if (!reset || reset.restartGeneration !== restartGeneration) return null;
  if (reset.status === "confirmed") return "confirmed";
  return data?.availability === "ready" &&
    !data.observability?.stale &&
    data.clientObservedAt > reset.requestedAt &&
    data.providerSessionId &&
    data.providerSessionId !== reset.providerSessionId
    ? "confirmed"
    : "requested";
}

export function clearContext(text, context, messages) {
  if (
    context.tool !== "codex" ||
    !/^\/clear *$/.test(text) ||
    typeof context.providerSessionId !== "string" ||
    !context.providerSessionId
  )
    return null;
  return {
    baseline: messages.map((message) => [message.id, resetMessageVersion(message)]),
    requestedAt: Date.now(),
    providerSessionId: context.providerSessionId,
    restartGeneration: context.restartGeneration || 0,
  };
}

export function validResetContext(value) {
  return (
    value &&
    typeof value.providerSessionId === "string" &&
    value.providerSessionId.length > 0 &&
    Number.isFinite(value.requestedAt) &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    Array.isArray(value.baseline) &&
    value.baseline.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 2 &&
        row.every((part) => typeof part === "string"),
    ) &&
    Number.isSafeInteger(value.restartGeneration) &&
    value.restartGeneration >= 0
  );
}

// Presentation-only checksums avoid saving a second copy of the transcript.
export function resetMessageVersion(message) {
  const value = JSON.stringify(message);
  let first = 2166136261;
  let second = 0x9747b28c;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 0x5bd1e995);
  }
  return `${value.length}:${first >>> 0}:${second >>> 0}`;
}

export function resetHistory(reset, messages, status) {
  if (status !== "requested") return { previous: messages, current: [] };
  const baseline = new Map(reset.baseline);
  const previous = [],
    current = [];
  const boundary = messages.findIndex((message) => baseline.has(message.id));
  for (const [index, message] of messages.entries()) {
    (index < boundary || baseline.get(message.id) === resetMessageVersion(message)
      ? previous
      : current
    ).push(message);
  }
  return { previous, current };
}
