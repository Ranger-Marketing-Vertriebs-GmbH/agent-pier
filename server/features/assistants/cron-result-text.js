import { publicMessages } from "./conversations.js";
import { historyTextLimit } from "./history-text.js";
import { hostReady, routineRunOf, runtimeFor } from "./runtimes/runtime-for.js";

// OpenClaw (2026.10.3, pickSummaryFromOutput) caps the `summary` a cron run's
// completion webhook carries at 2000 UTF-16 code units plus "…" (one less when the
// cut would split a surrogate pair). The full reply stays in the routine's session:
// the run reports its run session, whose transcript the routine's own session
// (routines.runOf `routineSession`) serves with `sessionId` <run id> until the next
// run starts (see tests/integration/assistant-routine-contract.test.js).
export const summaryCap = 2000;
const capped = (summary) =>
  summary.endsWith("…") &&
  summary.length >= summaryCap &&
  summary.length <= summaryCap + 1;
/** The job's session key and the run's session id, if the run is this job's. */
function runOf(sessionKey, agentId, jobId) {
  const run = routineRunOf(null, sessionKey);
  if (
    !run?.runId ||
    !agentId ||
    run.agentId.toLowerCase() !== agentId.toLowerCase() ||
    run.routineId.toLowerCase() !== String(jobId).toLowerCase()
  )
    return null;
  return { jobSession: run.routineSession, sessionId: run.runId };
}

/**
 * The text a completed run delivers: its summary, or, when OpenClaw capped the
 * summary, the run's last reply that the summary begins. `known` is a text already
 * delivered for this run (a replayed webhook); `limit` bounds the text; `supervisor`
 * runs the agent (runtime-supervisor.js, read through the runtime port). Any doubt
 * keeps the summary.
 */
export async function cronResultText({
  supervisor,
  agentId,
  event,
  known,
  limit = historyTextLimit,
}) {
  const summary = event.summary;
  if (typeof summary !== "string" || !capped(summary)) return summary;
  const prefix = summary.slice(0, -1);
  const proven = (text) =>
    typeof text === "string" &&
    text.length > prefix.length &&
    text.length <= limit &&
    text.startsWith(prefix);
  if (proven(known)) return known;
  const run = runOf(event.sessionKey, agentId, event.jobId);
  if (!hostReady(supervisor) || !run) return summary;
  try {
    const history = await runtimeFor(null, supervisor).sessions.history({
      sessionKey: run.jobSession,
      limit: 50,
      maxChars: historyTextLimit,
    });
    // A later run of the same job has replaced the transcript.
    if (history?.sessionId !== run.sessionId) return summary;
    const reply = publicMessages(history.messages)
      .filter((m) => m.role === "assistant")
      .at(-1)
      ?.text.trim();
    return proven(reply) ? reply : summary;
  } catch {
    return summary;
  }
}
