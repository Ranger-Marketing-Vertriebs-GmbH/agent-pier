import { randomUUID } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact, fingerprint, requestKind } from "./lead-request-store.js";
import { peerCaller, peerTurn } from "./peer-request-rules.js";
import { mainConversation } from "./routine-targets.js";

// A member's own report to its lead: a finished result or a problem. Stored as a
// settled-pending lead request of type `report` under the lead, which the lead's
// scheduler delivers as a `member-result` follow-up (lead-request-delivery.js), one
// report per member at a time. Never counts against the lead's or the peer caps.
export const reportCaps = { perHour: 6 };
export const reportLimits = { text: 8192, files: 10, file: 500 };
const hourMs = 3600000;
const isMemberReport = (r) => r?.type === "report" && r.origin?.kind === "member-report";

export class MemberReports {
  constructor({ teams, service }) {
    Object.assign(this, { teams, service });
  }
  /**
   * Stores a report once per tool call: the same call returns its record again, the
   * same call with another input conflicts. Allowed in the member's own work and
   * while it handles a sibling's request; refused in every other turn.
   */
  report(inv, input, now = Date.now()) {
    exact(input, ["kind", "text", "files"], ["kind", "text"]);
    if (!["result", "problem"].includes(input.kind)) throw assistantProblem("invalid");
    const text = textValue(input.text, reportLimits.text);
    const files = input.files ?? [];
    if (!Array.isArray(files) || files.length > reportLimits.files)
      throw assistantProblem("invalid");
    files.forEach((file) => textValue(file, reportLimits.file));
    inv?.assertCurrent?.();
    textValue(inv?.toolCallId, 256);
    const teams = this.teams,
      store = this.service.requests.store;
    const r = teams.transaction(() => {
      const caller = peerCaller(this.service, inv);
      const key = `${caller.attempt?.id || `routine:${caller.routine.sessionKey}`}:${inv.toolCallId}`;
      const hash = fingerprint({ type: "report", kind: input.kind, text, files });
      const old = teams.db
        .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
        .get(key);
      if (old) {
        const existing = teams.get(old.id);
        if (existing.fingerprint !== hash) throw assistantProblem("conflict", 409);
        return existing;
      }
      if (!peerTurn(this.service, caller)) throw assistantProblem("peerRequestTurn", 403);
      const { lead, member, assistant } = caller;
      const recent = store
        .list(lead.id)
        .filter(
          (x) =>
            isMemberReport(x) &&
            x.memberId === member.id &&
            now - Date.parse(x.createdAt) < hourMs,
        );
      if (recent.length >= reportCaps.perHour)
        throw assistantProblem("memberReportLimit", 429);
      const at = new Date(now).toISOString();
      const routine = caller.routine?.binding.definition?.name;
      return teams.insert(
        {
          id: randomUUID(),
          kind: requestKind,
          revision: 1,
          type: "report",
          parentAssistantId: lead.id,
          parentConversationId:
            mainConversation(this.service.assistants.store, lead.id)?.id ?? null,
          parentRequestId: null,
          parentAttemptId: null,
          leadName: lead.name,
          memberId: member.id,
          memberAssistantId: assistant.id,
          memberName: assistant.name,
          text,
          files,
          // The member's own words, never the owner's: attributed data for the lead.
          origin: {
            kind: "member-report",
            reportKind: input.kind,
            ...(caller.routine ? { routine: routine || "" } : {}),
          },
          ownerProof: null,
          writeAllowed: false,
          phase: "completed",
          fingerprint: hash,
          delivery: null,
          createdAt: at,
          finishedAt: at,
        },
        key,
      );
    });
    this.service.assistants.changed?.();
    return {
      reportId: r.id,
      status: "queued",
      note: "Your report goes to your lead as a separate message. Do not send it again.",
    };
  }
  /**
   * Whether a member's report waits for an older one of the same member that has
   * not been settled yet: one delivery at a time per member, in creation order.
   */
  held(r) {
    if (!isMemberReport(r)) return false;
    const first = this.service.requests.store
      .pending()
      .find((x) => isMemberReport(x) && x.memberId === r.memberId);
    return !!first && first.id !== r.id;
  }
  /** The lead's main chat as it is now: one opened after the report still counts. */
  conversationId(r) {
    return (
      mainConversation(this.service.assistants.store, r.parentAssistantId)?.id ?? null
    );
  }
}
