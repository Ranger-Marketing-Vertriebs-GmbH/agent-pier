import { historyText } from "./history-text.js";
// What the agent's chat shows of its routines, reminders and check-ins (`kind`;
// none for a routine): a delivered result (badged with the routine's name, or as a
// check-in) or a failed run (a quiet line). OpenClaw commits a routine's or
// check-in's result into the conversation itself; this record only names it. A
// result that was not committed (every reminder) is kept here with its text.
const kept = 200;
// A result's badge: the routine's name and what AgentPier noted on the run.
const scheduled = (r) => ({
  name: r.name,
  ...(r.kind ? { kind: r.kind } : {}),
  ...(r.notes ? { notes: r.notes } : {}),
});
const turnText = (text) => String(text).replace(/\r\n?/g, "\n").trim();

export class RoutineResults {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_routine_results (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL)",
    );
  }
  /** Idempotent per run: a replayed completion keeps the first record. */
  record(entry) {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO assistant_routine_results VALUES(?,?,?)")
      .run(entry.id, entry.conversationId, JSON.stringify(entry));
    if (inserted.changes)
      this.db
        .prepare(
          "DELETE FROM assistant_routine_results WHERE conversation_id=? AND rowid NOT IN (SELECT rowid FROM assistant_routine_results WHERE conversation_id=? ORDER BY rowid DESC LIMIT ?)",
        )
        .run(entry.conversationId, entry.conversationId, kept);
    return inserted.changes === 1;
  }
  /** A deleted user's chat: its results and their texts go with it (user-release.js). */
  forget(conversationId) {
    this.db
      .prepare("DELETE FROM assistant_routine_results WHERE conversation_id=?")
      .run(conversationId);
  }
  /** The latest recorded run of one routine, or null (the agent's routine list). */
  latest(bindingId) {
    const row = this.db
      .prepare(
        "SELECT body FROM assistant_routine_results WHERE json_extract(body, '$.bindingId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(bindingId);
    return row ? JSON.parse(row.body) : null;
  }
  /** The recorded runs of one routine or reminder, newest first (its run history). */
  forBinding(bindingId, limit = 50) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_routine_results WHERE json_extract(body, '$.bindingId')=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(bindingId, limit)
      .map((row) => JSON.parse(row.body));
  }
  forConversation(conversationId) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_routine_results WHERE conversation_id=? ORDER BY rowid",
      )
      .all(conversationId)
      .map((row) => JSON.parse(row.body));
  }
}

/**
 * Marks the committed results among `messages` with their routine and adds the
 * results and failures that live only here. Like coding run notes, an entry joins
 * the page it falls into: from the page's first message (or the very start) on.
 */
export function withRoutineResults(messages, results, { from = -Infinity } = {}) {
  if (!results.length) return messages;
  // A failed check-in OpenClaw committed is badged like a successful one.
  const committed = results.filter((r) => r.committed);
  const marked = messages.map((m) => {
    if (m.role !== "assistant") return m;
    // The history page cuts a long reply; its kept beginning still identifies it.
    const shown =
      m.cut === true || m.partial === true
        ? { text: m.text, cut: true }
        : historyText(m.text);
    const same = (r) =>
      shown.cut
        ? !!turnText(shown.text) && turnText(r.text).startsWith(turnText(shown.text))
        : turnText(r.text) === turnText(m.text);
    const result = committed.findLast((r) => same(r) && !(m.timestamp < r.runAtMs));
    return result ? { ...m, scheduled: scheduled(result) } : m;
  });
  const own = results
    .filter((r) => r.at >= from && !r.committed)
    .map((r) =>
      r.status === "ok"
        ? {
            id: `routine:${r.id}`,
            role: "assistant",
            text: r.text,
            timestamp: r.at,
            runId: null,
            scheduled: scheduled(r),
          }
        : {
            id: `routine:${r.id}`,
            role: "event",
            event: "routine-failed",
            name: r.name,
            ...(r.kind ? { kind: r.kind } : {}),
            timestamp: r.at,
            runId: null,
            ...(r.notes ? { notes: r.notes } : {}),
            // Why it failed (routine-failures.js); older records have none.
            ...(r.failure ? { failure: r.failure } : {}),
          },
    );
  if (!own.length) return marked;
  return [...marked, ...own]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}

// The notes AgentPier left on a run (NativeRoutines.noteRefusal), as the agent reads
// them in its routine list (English, like every tool result).
const warnings = {
  writes_refused:
    "Project folder changes were refused because 'May write' is off for this routine. If it should change files, ask the owner to switch on 'May write' for it (agent settings, Automation, Routines).",
  ssh_refused:
    "SSH was refused because the host is not trusted. The owner can mark it 'Trusted'.",
  mail_refused: "Email was refused: no access or a limit was reached.",
};

/** The readable warnings of a routine's last recorded run; none without notes. */
export function runWarnings(result) {
  return (result?.notes || []).map((note) => warnings[note]).filter(Boolean);
}

// A run history entry shows this much of its result; the chat has the whole text.
const resultPreview = 280;
// A recorded result belongs to the run it falls into: from shortly before the run's
// start (the clocks of the runtime's log and its completion differ) to a little after
// its end, as the runtimes stamp the completion with either time.
const before = 5000;
const after = 120000;

/**
 * The run history `entries` (routine-failures.js runEntry, any order) with what each
 * successful run delivered: `result`, the start of its text as `recorded` (newest
 * first, RoutineResults#forBinding) holds it, `resultCut` when it goes on. Each
 * recorded result goes to the nearest run it falls into, once.
 */
export function withRunResults(entries, recorded) {
  const free = recorded.filter(
    (r) => r.status === "ok" && typeof r.text === "string" && r.text.trim(),
  );
  return entries.map((entry) => {
    if (entry.status !== "ok" || !Number.isSafeInteger(entry.runAtMs)) return entry;
    const end =
      entry.runAtMs + (Number.isFinite(entry.durationMs) ? entry.durationMs : 0);
    let best = -1;
    free.forEach((r, index) => {
      if (r.runAtMs < entry.runAtMs - before || r.runAtMs > end + after) return;
      const gap = Math.abs(r.runAtMs - entry.runAtMs);
      if (best < 0 || gap < Math.abs(free[best].runAtMs - entry.runAtMs)) best = index;
    });
    if (best < 0) return entry;
    const [match] = free.splice(best, 1);
    const text = turnText(match.text);
    return text.length > resultPreview
      ? { ...entry, result: `${text.slice(0, resultPreview - 1)}…`, resultCut: true }
      : { ...entry, result: text };
  });
}
