import { randomUUID } from "node:crypto";
import { requestKind } from "./lead-request-store.js";
import { mainConversation } from "./routine-targets.js";
import { saveText, shortForm } from "./team-texts.js";

/**
 * A finished hook event of a permanent team member becomes a settled lead request of
 * type `report` (like routineReport in lead-routine-reports.js), which the lead
 * receives as a read-only `member-result` follow-up (resultTurn returns null for the
 * `member-hook` origin). The request text names the hook and its sender, never the
 * payload. A failed run is reported once until the hook succeeds again (the
 * `leadReportFailing` flag, written without a new revision); silent results never
 * get here. Idempotent per event. Returns whether it recorded a new report.
 */
export function hookReport({ teams, assistants, hooks }, hook, event, text) {
  const store = assistants.store;
  const member = store.getAssistant(hook.assistantId);
  const record = member.teamMemberId ? teams?.find(member.teamMemberId) : null;
  if (
    !record ||
    record.kind !== "member" ||
    record.lifetime !== "permanent" ||
    member.lifetime !== "permanent" ||
    member.archivedAt ||
    record.archivedAt
  )
    return false;
  const lead = store.getAssistant(record.parentAssistantId);
  const conversation = mainConversation(store, lead.id);
  if (lead.archivedAt || lead.teamMemberId || !conversation) return false;
  const ok = event.status === "done";
  if (!ok && hook.leadReportFailing) return false;
  const key = `lead-hook-report:${event.id}`;
  if (
    teams.db
      .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
      .get(key)
  )
    return false;
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
      parentAssistantId: lead.id,
      parentConversationId: conversation.id,
      parentRequestId: null,
      parentAttemptId: null,
      leadName: lead.name,
      memberId: record.id,
      memberAssistantId: member.id,
      memberName: member.name,
      text: `Hook ${hook.name} from ${hook.sender}`,
      origin: { kind: "member-hook", hookId: hook.id, name: hook.name },
      ownerProof: null,
      writeAllowed: false,
      phase: ok ? "completed" : "failed",
      ...(ok
        ? { answer: short.text, ...(short.truncated ? { answerTruncated: true } : {}) }
        : { diagnostic: "HOOK_FAILED" }),
      delivery: null,
      createdAt: now,
      startedAt: new Date(event.receivedAt || Date.now()).toISOString(),
      finishedAt: now,
    },
    key,
  );
  // The flag follows the outcome once the report exists (a failed insert reports the
  // next failure); the owner's open settings draft keeps its revision.
  if (ok !== !hook.leadReportFailing)
    hooks.store.flag(hook.id, { leadReportFailing: !ok });
  return true;
}
