import { actionTerminal } from "./assistant-action-store.js";
import { teamCodingRuns } from "./team-coding.js";
import { runReply } from "./history-text.js";
import { textValue, validateSendInput } from "./assistant-validation.js";
import { readText, saveText, shortForm } from "./team-texts.js";
import { synthesisPrompt } from "./team-synthesis.js";
export { synthesisMaxChars, synthesisPrompt } from "./team-synthesis.js";
export const memberTerminal = new Set(["completed", "failed", "cancelled"]);
const codingRun = (a) => ({
  actionId: a.id,
  state: a.state,
  project: a.projectName,
  pipeline: a.pipelineName,
  task: Array.from(a.payload.task).slice(0, 500).join(""),
  ...(a.run ? { runId: a.run.id, runStatus: a.run.status, url: a.run.url } : {}),
  ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
  // Approval, an uncertain start or a long run does not hold the team open; its
  // outcome follows separately.
  ...(actionTerminal.has(a.state) ? {} : { pending: true }),
});
/** A member's whole report: its own row, or the batch text of older records. */
export const reportText = (teams, team, entry) =>
  (entry.truncated && readText(teams.db, team.id, entry.memberId)) || entry.text || "";
export class TeamResults {
  constructor({ teams, assistants }) {
    Object.assign(this, { teams, assistants });
  }
  async collect(id) {
    const { teams, assistants: a } = this;
    const team = teams.get(id),
      members = teams.members(id);
    if (
      team.resultBatch ||
      !members.length ||
      !members.every((m) => memberTerminal.has(m.phase))
    )
      return;
    const batch = [];
    for (const m of members) {
      const attempt = m.attemptId ? a.ledger.getAttempt(m.attemptId) : null;
      let reply = { text: "", cut: false };
      if (m.phase === "completed") {
        const history = await a.history(m.conversationId);
        if (!history.stale)
          reply = await runReply(a, m.conversationId, history.messages, attempt);
      }
      // The record keeps an excerpt; a longer report gets its own row.
      const short = shortForm(reply.text);
      if (short.truncated) saveText(teams.db, id, m.id, reply.text);
      batch.push({
        memberId: m.id,
        name: m.name,
        role: m.role,
        phase: m.phase,
        reportAvailable: !!reply.text.trim(),
        ...short,
        // Incomplete beyond OpenClaw's limits; the whole report is in the member's chat.
        ...(reply.cut ? { cut: true } : {}),
      });
    }
    // Coding runs members requested are listed with their current state, read
    // after the last await: an action that settled while reports were read must
    // not be listed as pending, because its follow-up was decided without it.
    const coding = teamCodingRuns(a.workflows, team);
    for (const entry of batch) {
      const runs = coding.filter((x) => x.requestedBy === entry.memberId).map(codingRun);
      if (runs.length) entry.codingRuns = runs;
    }
    teams.write(teams.get(id), {
      resultBatch: batch,
      resultState: "queued",
      // When the team ended; the lead's chat places its closing note there.
      finishedAt: new Date().toISOString(),
      // An owner stop after some members completed is cancelled, not failed;
      // the completed reports are still synthesized below.
      phase: members.every((m) => m.phase === "completed")
        ? "completed"
        : members.some((m) => m.phase === "failed")
          ? "failed"
          : "cancelled",
    });
    a.changed();
  }
  async dispatch(id) {
    const { teams, assistants: a } = this;
    let team = teams.get(id);
    if (!team.resultBatch || ["skipped", "unsent"].includes(team.resultState)) return;
    if (team.resultAttemptId) {
      const attempt = a.ledger.getAttempt(team.resultAttemptId);
      const state = attempt.reviewedAt ? "reviewed" : attempt.state;
      if (team.resultState !== state) teams.write(team, { resultState: state });
      return;
    }
    // A team cancelled before any member completed or an archived parent has no
    // owner turn to spend on a summary; it is skipped once instead of being
    // retried on every tick. Partial results of a stopped team are summarized.
    const skip =
      team.phase === "cancelled" && !team.resultBatch.some((m) => m.phase === "completed")
        ? "TEAM_CANCELLED"
        : a.store.getAssistant(team.parentAssistantId).archivedAt
          ? "PARENT_ARCHIVED"
          : null;
    if (skip) {
      teams.write(team, { resultState: "skipped", resultDiagnostic: skip });
      a.changed();
      return;
    }
    if (
      a.ledger
        .pending()
        .some(
          (at) =>
            a.ledger.getRequest(at.requestId).conversationId ===
            team.parentConversationId,
        )
    )
      return;
    const input = {
      clientRequestId: `team-result:${id}`,
      text: synthesisPrompt(
        team,
        team.resultBatch.map((m) => reportText(teams, team, m)),
      ),
    };
    try {
      // The text send would refuse every time (a NUL in a report) ends visibly;
      // the reports stay readable in the team's card.
      validateSendInput(input);
      textValue(input.text);
    } catch (error) {
      console.warn(`Team ${id}: the result synthesis is not sendable (${error.key}).`);
      teams.write(team, { resultState: "unsent", resultDiagnostic: "RESULT_UNSENDABLE" });
      a.changed();
      return;
    }
    try {
      const sent = await a.send(team.parentConversationId, input, {
        kind: "team-result",
        teamId: id,
      });
      team = teams.get(id);
      teams.write(team, {
        resultAttemptId: sent.attempt.id,
        resultState: sent.attempt.state,
      });
    } catch {
      // Admission may be busy or credentials unavailable. Stable request identity
      // adopts a previously admitted synthesis; it never retries its execution.
    }
  }
}
