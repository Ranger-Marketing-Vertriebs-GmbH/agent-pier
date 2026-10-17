import { assistantProblem, textValue } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { reachableMember } from "./member-reach.js";
import { extraEnd, extraSection, extraStart } from "./team-presentation.js";

// The fields a lead may change, in the order notes and the audit name them.
export const editFields = [
  "name",
  "role",
  "assignment",
  "extraInstructions",
  "instructions",
];
const limits = {
  name: 100,
  role: 200,
  assignment: 8192,
  extraInstructions: 8192,
  instructions: 65536,
};
const kept = 50;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const section = new RegExp(
  `\\n*${escape(extraStart)}\\n[\\s\\S]*?\\n${escape(extraEnd)}`,
);

/** `text` with the line `label: old` (or any `label:` line) replaced, else appended. */
function setLine(text, label, old, value) {
  const line = `${label}: ${value}`;
  if (old !== undefined && text.includes(`${label}: ${old}`))
    return text.replace(`${label}: ${old}`, () => line);
  const any = new RegExp(`^${label}: .*$`, "m");
  if (any.test(text)) return text.replace(any, () => line);
  // A missing Assignment line follows the Role line, as the lead first wrote them.
  const role = /^Role: .*$/m;
  if (label === "Assignment" && role.test(text))
    return text.replace(role, (match) => `${match}\n${line}`);
  return `${text.trimEnd()}\n\n${line}`;
}

/**
 * The member's current instructions with the lead's change applied: the Role and
 * Assignment lines replaced (or appended) and the lead's own delimited section
 * replaced (or appended, or removed when empty). Everything else, the lead's
 * snapshot and any text the owner wrote, stays as it is.
 */
export function editedInstructions(current, member, changes) {
  let text = current;
  const extra = "extraInstructions" in changes;
  if (extra) text = text.replace(section, "");
  if ("role" in changes) text = setLine(text, "Role", member.role, changes.role);
  if ("assignment" in changes)
    text = setLine(text, "Assignment", member.assignment, changes.assignment);
  if (extra && changes.extraInstructions) text += extraSection(changes.extraInstructions);
  return text;
}

/**
 * A lead's edits of its own task members (agentpier_team_member_update): name, role,
 * assignment and an extra instructions section change the member's current
 * instructions in place; `instructions` replaces them whole, whatever the owner
 * wrote before (owner's decision: the lead may rewrite them completely). Owner edits
 * never block the lead. The result is recorded as the lead's (`leadInstructions`),
 * so only later owner edits count as overrides, and the log keeps the replaced text
 * for the owner to read. Every
 * change is visible: the member's log (team card), a note in both chats and an audit
 * that names the fields only. The member's next turn applies the new revision.
 */
export class MemberEdits {
  constructor({ teams, assistants, audit = null, onChanged = () => {} }) {
    Object.assign(this, { teams, assistants, audit, onChanged });
  }
  update(inv, input) {
    return Promise.resolve().then(() => this.updateNow(inv, input));
  }
  updateNow(inv, input) {
    exact(input, ["memberId", ...editFields]);
    if (typeof input.memberId !== "string") throw assistantProblem("invalid");
    const changes = {};
    for (const key of editFields)
      if (key in input)
        changes[key] =
          key === "extraInstructions"
            ? textValue(input[key], limits[key], true).trim()
            : key === "instructions"
              ? textValue(input[key], limits[key])
              : textValue(input[key], limits[key]).trim();
    if (!Object.keys(changes).length) throw assistantProblem("invalid");
    // A whole rewrite says everything itself; an extra section on top is ambiguous.
    if ("instructions" in changes && "extraInstructions" in changes)
      throw assistantProblem("invalid");
    inv.assertCurrent();
    const a = this.assistants,
      attempt = a.ledger.getAttempt(inv.attemptId),
      request = a.ledger.getRequest(attempt.requestId),
      conversation = a.store.getConversation(request.conversationId),
      lead = a.store.getAssistant(conversation.assistantId);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    let member;
    try {
      member = this.teams.member(input.memberId);
    } catch {
      throw assistantProblem("teamGrantMemberEnded", 409);
    }
    if (!reachableMember(member, lead.id))
      throw assistantProblem("teamGrantMemberEnded", 409);
    const agent = a.store.getAssistant(member.assistantId);
    const current = { ...member, name: agent.name, instructions: agent.instructions };
    const changed = editFields.filter(
      (key) => key in changes && changes[key] !== (current[key] ?? ""),
    );
    if (!changed.length) return { status: "unchanged", memberId: member.id, changed };
    const instructions =
      "instructions" in changes
        ? changes.instructions
        : editedInstructions(agent.instructions, member, changes);
    const saved = a.store.updateAssistant(
      agent.id,
      {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(instructions !== agent.instructions ? { instructions } : {}),
      },
      agent.revision,
    );
    const entry = {
      at: new Date().toISOString(),
      by: "lead",
      edited: changed,
      // What the change replaced, for the owner to read in the member's history.
      ...(instructions !== agent.instructions
        ? { previousInstructions: agent.instructions }
        : {}),
    };
    const stored = changed.filter((key) => key !== "instructions");
    const next = this.teams.write(member, {
      ...Object.fromEntries(stored.map((key) => [key, changes[key] || undefined])),
      leadInstructions: saved.instructions,
      grantLog: [...(member.grantLog || []), entry].slice(-kept),
    });
    this.record(lead, next, changed);
    this.note(lead, next, conversation, inv, { changed, previousName: member.name });
    this.onChanged(next);
    a.changed?.();
    return {
      status: "updated",
      memberId: member.id,
      changed,
      effective: "next_turn",
    };
  }
  record(lead, member, changed) {
    try {
      this.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: member.assistantId,
        source: "system",
        outcome: "success",
        details: {
          kind: "member-edit",
          edited: changed,
          teamId: member.teamId,
          leadAssistantId: lead.id,
        },
      });
    } catch (error) {
      console.error("Member edit audit failed:", error?.message);
    }
  }
  // One settled row per chat, the member's and the lead's (actionNotes).
  note(lead, member, conversation, inv, { changed, previousName }) {
    const store = this.assistants.workflows?.store;
    if (!store) return;
    const at = Date.now();
    const payload = {
      action: "member_update",
      memberId: member.id,
      memberName: member.name,
      ...(previousName !== member.name ? { previousName } : {}),
      teamId: member.teamId,
      edited: changed,
    };
    for (const [assistantId, conversationId] of [
      [member.assistantId, member.conversationId],
      [lead.id, conversation.id],
    ]) {
      if (!conversationId) continue;
      store.reserve({
        assistantId,
        conversationId,
        attemptId: inv.attemptId,
        origin: { kind: "member-grant" },
        key: `member-update:${inv.attemptId}:${inv.toolCallId}:${assistantId}`,
        state: "completed",
        payload,
        chatNotes: { result: { at, state: "completed" } },
        settled: true,
      });
    }
  }
}
