// Short transcript notes where a lead's team started and where it ended. They are
// derived from the team records (startedAt, finishedAt), never stored in the chat.
// Coding-run notes are merged on the server instead (withRunNotes in
// server/features/assistants/conversations.js); both hold a note older than the
// first loaded message back until that older page is loaded. Keep the rules aligned.
const ended = new Set(["completed", "failed", "cancelled", "declined"]);
const time = (value) => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : null;
};

/** The team's terminal outcome as a note kind, or null while it still runs. */
export function teamOutcome(team) {
  if (!ended.has(team.phase)) return null;
  if (team.phase === "declined") return "declined";
  return ["completed", "partial", "failed", "cancelled"].includes(team.status)
    ? team.status
    : team.phase;
}

/** Notes for one conversation of a lead, ordered by time. */
export function teamNotes(teams, { assistantId, conversationId }) {
  const notes = [];
  for (const team of teams) {
    if (team.parentAssistantId !== assistantId) continue;
    if (team.parentConversationId && team.parentConversationId !== conversationId)
      continue;
    // Teams started before startedAt was recorded start at their proposal.
    const start = time(team.startedAt) ?? time(team.createdAt);
    const outcome = teamOutcome(team);
    // A proposal that waits or was declined never started; its card or end note says so.
    if (start !== null && !["awaiting_approval", "declined"].includes(team.phase))
      notes.push({ id: `${team.id}:start`, team, kind: "started", time: start });
    if (outcome) {
      // A team that ended before its end was recorded sits beside its start.
      const end = time(team.finishedAt) ?? start;
      if (end !== null)
        notes.push({ id: `${team.id}:end`, team, kind: outcome, time: end });
    }
  }
  return notes.sort((a, b) => a.time - b.time);
}

/**
 * Interleaves notes with transcript messages by time. A message without a time stays
 * where it is. While older history is not loaded, a note older than the first loaded
 * message belongs to that older page and is left out.
 */
export function withTeamNotes(messages, notes, { complete = true } = {}) {
  const firstTime = messages.find((m) => m.timestamp > 0)?.timestamp;
  const pending = notes.filter(
    (n) => complete || firstTime === undefined || n.time >= firstTime,
  );
  const items = [];
  let next = 0;
  for (const message of messages) {
    while (
      next < pending.length &&
      message.timestamp > 0 &&
      pending[next].time < message.timestamp
    )
      items.push({ note: pending[next++] });
    items.push({ message });
  }
  while (next < pending.length) items.push({ note: pending[next++] });
  return items;
}

// Ends of a completed team, after which the hidden synthesis turn's event note would
// only repeat it ("Team results received …").
const resultEnds = new Set(["completed", "partial", "failed", "cancelled"]);

/** Drops a team-result event note that directly follows a team's end note. */
export function foldResultEvents(items) {
  return items.filter(
    (item, n) =>
      item.message?.event !== "team-result" || !resultEnds.has(items[n - 1]?.note?.kind),
  );
}
