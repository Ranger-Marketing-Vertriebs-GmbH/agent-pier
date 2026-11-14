// Quiet notes in an agent's chat for what its agent_session tools did: a message it
// wrote to a session, a late answer pasted (or dropped), a budget limit. Asks and tells
// from sessions are no notes; they show as the session's turn (message-source.js).
// The browser gets names, the outcome and a short text, never ids of the session.
const noteChars = 500;
const outcomes = new Set(["accepted", "pending", "rejected"]);

function outcomeOf(row) {
  if (row.op === "late") return row.phase === "late-dropped" ? "dropped" : null;
  if (row.op === "send") return outcomes.has(row.status) ? row.status : "pending";
  return null;
}

/** The notes of the talk rows of one chat (`TalkStore.forConversation`). */
export function talkNotes(rows, conversationId) {
  return (rows || []).flatMap((row) => {
    if (row.conversationId !== conversationId) return [];
    if (!["send", "late", "limit"].includes(row.op)) return [];
    if (row.op !== "limit" && row.direction !== "to-session") return [];
    const text =
      row.op !== "limit" && typeof row.text === "string"
        ? { text: row.text.slice(0, noteChars) }
        : {};
    return [
      {
        id: `session-talk:${row.id}`,
        role: "event",
        event: "session-talk",
        op: row.op,
        sessionName: row.sessionName ?? "",
        projectName: row.projectName ?? "",
        ...text,
        outcome: outcomeOf(row),
        timestamp: row.createdAt,
        runId: null,
      },
    ];
  });
}
