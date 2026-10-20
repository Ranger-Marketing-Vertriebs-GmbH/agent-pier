// The reply a session's CLI is generating right now, from the chat stream's `stream`
// and `stream-end` frames (server/features/chat/reply-streams.js). It lives only in
// the browser and gives way to the transcript: a run is shown until the synced
// history holds its message.

// An ended run stays this long at most, until the transcript sync shows its text.
export const endedReplyGraceMs = 5000;
const labels = ["thread", "turn", "order"];

/**
 * The runs after one frame, or null when the frame does not fit what is held (the
 * stream then reconnects and the server sends every run whole again).
 */
export function nextReplies(runs, frame) {
  if (typeof frame?.runId !== "string" || !frame.runId) return null;
  const next = new Map(runs);
  if (frame.type === "stream-end") {
    const run = next.get(frame.runId);
    if (run) next.set(frame.runId, { ...run, ended: true });
    return next;
  }
  if (
    frame.type !== "stream" ||
    typeof frame.text !== "string" ||
    !Number.isInteger(frame.from) ||
    frame.from < 0
  )
    return null;
  const current = runs.get(frame.runId);
  let text;
  if (frame.from === 0) text = frame.text;
  else if (current && current.text.length === frame.from)
    text = current.text + frame.text;
  else return null;
  const run = { runId: frame.runId, text };
  for (const key of labels) if (frame[key] !== undefined) run[key] = frame[key];
  // A run that streams again is current: it moves behind the others.
  next.delete(frame.runId);
  next.set(frame.runId, run);
  return next;
}

/** The runs without the ended ones (their grace is over). */
export function withoutEnded(runs) {
  return new Map([...runs].filter(([, run]) => !run.ended));
}

const normalized = (text) => String(text).replace(/\r\n?/g, "\n").trim();
// Claude Code records an interrupt as a user row of its own and reports no hook for
// it, so the interrupted turn's draft lives on: the marker does not start a turn.
const claudeInterrupt = /^\[Request interrupted by user(?: for tool use)?\]$/;
const prompt = (row) =>
  row.role === "user" && !claudeInterrupt.test(normalized(row.text || ""));

/**
 * The runs still to show below the transcript, in reply order. A run gives way to
 * the history when a row has its id (Codex items and OpenCode parts keep it), when
 * the current turn (the rows after the last prompt) already holds as many
 * assistant messages as precede it (`order`, Claude: its message ids are not the
 * transcript's), or when a reply of that turn starts with its text. Runs of
 * another conversation (a Codex sub-agent thread) never show.
 */
export function visibleReplies(runs, snapshot) {
  if (!runs?.size || !snapshot) return [];
  const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
  const ids = new Set(messages.map((row) => row.id));
  const lastUser = messages.findLastIndex(prompt);
  const replies = messages
    .slice(lastUser + 1)
    .filter((row) => row.role === "assistant" && normalized(row.text || ""));
  return [...runs.values()]
    .filter((run) => {
      const text = normalized(run.text);
      if (!text || ids.has(run.runId)) return false;
      if (
        run.thread &&
        snapshot.providerSessionId &&
        run.thread !== snapshot.providerSessionId
      )
        return false;
      if (Number.isInteger(run.order) && replies.length > run.order) return false;
      return !replies.some((row) => normalized(row.text).startsWith(text));
    })
    .sort((a, b) =>
      Number.isInteger(a.order) && Number.isInteger(b.order) && a.turn === b.turn
        ? a.order - b.order
        : 0,
    );
}
