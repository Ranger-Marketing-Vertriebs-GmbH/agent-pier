import { publicMessages } from "./conversations.js";
import { historyTextLimit } from "./history-text.js";

// OpenClaw (2026.9.9, pickSummaryFromOutput) caps the `summary` a cron run's
// completion webhook carries at 2000 UTF-16 code units plus "…" (one less when the
// cut would split a surrogate pair). The full reply stays in the job's session:
// the run reports `agent:<agent>:cron:<job>:run:<id>`, whose transcript the job's
// own key (`agent:<agent>:cron:<job>`) serves with `sessionId` <id> until the next
// run starts (see tests/integration/assistant-routine-contract.test.js).
export const summaryCap = 2000;
const capped = (summary) =>
  summary.endsWith("…") &&
  summary.length >= summaryCap &&
  summary.length <= summaryCap + 1;
const runSession = /^(agent:([^:]+):cron:([^:]+)):run:([^:]+)$/i;
/** The job's session key and the run's session id, if the run is this job's. */
function runOf(sessionKey, agentId, jobId) {
  const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
  if (
    !match ||
    !agentId ||
    match[2].toLowerCase() !== agentId.toLowerCase() ||
    match[3].toLowerCase() !== String(jobId).toLowerCase()
  )
    return null;
  return { jobSession: match[1], sessionId: match[4] };
}

/**
 * The text a completed run delivers: its summary, or, when OpenClaw capped the
 * summary, the run's last reply that the summary begins. `known` is a text already
 * delivered for this run (a replayed webhook); `limit` bounds the text. Any doubt
 * keeps the summary.
 */
export async function cronResultText({
  client,
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
  if (!client?.ready || !run) return summary;
  try {
    const history = await client.call("chat.history", {
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
