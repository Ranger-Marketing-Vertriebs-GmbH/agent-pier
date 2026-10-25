import { randomUUID } from "node:crypto";
import { requestKind } from "./lead-request-store.js";
import { reportedFailure, runFailure } from "./routine-failures.js";
import { mainConversation } from "./routine-targets.js";
import { saveText, shortForm } from "./team-texts.js";

/**
 * A finished run of a routine a lead set up on its member (lead-routines.js) becomes
 * a settled lead request of type `report`, which LeadRequests.deliver hands to the
 * lead as an ordinary `member-result` follow-up in its main chat: attributed data,
 * never owner text. A failed run is reported once until the routine succeeds again,
 * so a broken routine does not repeat its failure every run; a run that found
 * nothing to report (OpenClaw's silent reply) never gets here. Idempotent per run.
 * Returns whether it recorded a new report.
 */
export function routineReport(lead, binding, event, text) {
  const teams = lead.teams,
    store = lead.assistants.store;
  const leadAgent = store.getAssistant(binding.leadId);
  const conversation = mainConversation(store, leadAgent.id);
  if (!teams || !conversation) return false;
  const ok = event.status === "ok";
  const bindings = lead.routines.bindings;
  if (!ok && binding.leadReportFailing) return false;
  if (ok !== !binding.leadReportFailing)
    bindings.patch(binding.id, { leadReportFailing: !ok });
  const key = `lead-routine-report:${binding.id}:${event.runAtMs}`;
  if (
    teams.db
      .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
      .get(key)
  )
    return false;
  const member = store.getAssistant(binding.assistantId);
  const id = randomUUID(),
    now = new Date().toISOString();
  const short = ok ? shortForm(String(text || "").trim()) : null;
  if (short?.truncated) saveText(teams.db, id, "answer", String(text).trim());
  teams.insert(
    {
      id,
      kind: requestKind,
      revision: 1,
      type: "report",
      parentAssistantId: leadAgent.id,
      parentConversationId: conversation.id,
      parentRequestId: null,
      parentAttemptId: null,
      leadName: leadAgent.name,
      memberId: binding.leadMemberId,
      memberAssistantId: member.id,
      memberName: member.name,
      // The routine's saved task stands where a request's text would.
      text: binding.definition?.prompt || "",
      origin: {
        kind: "member-routine",
        bindingId: binding.id,
        name: binding.definition?.name || "",
      },
      ownerProof: null,
      writeAllowed: false,
      phase: ok ? "completed" : "failed",
      ...(ok
        ? { answer: short.text, ...(short.truncated ? { answerTruncated: true } : {}) }
        : { diagnostic: "ROUTINE_FAILED", failure: reportedFailure(runFailure(event)) }),
      delivery: null,
      createdAt: now,
      startedAt: new Date(event.runAtMs).toISOString(),
      finishedAt: now,
    },
    key,
  );
  return true;
}
