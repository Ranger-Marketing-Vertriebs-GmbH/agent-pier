import { randomUUID, createHash } from "node:crypto";
import { migrateTeams } from "./team-schema.js";
import {
  defaultTeamPolicy,
  normalizeTeamPolicy,
  normalizeTeamSettings,
} from "./team-policy.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { RequestLedger } from "./request-ledger.js";
const terminal = new Set(["completed", "failed", "cancelled", "declined"]);
// The quote must prove a team request, not merely an owner turn: at least three
// words containing "team" (also in compounds such as "Rechercheteam"), found
// case- and whitespace-insensitively in the stored user text of the same request
// (for Telegram voice the stored transcript).
const plain = (value) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
const quoted = (quote, text) =>
  typeof quote === "string" &&
  typeof text === "string" &&
  plain(quote).includes("team") &&
  plain(quote).split(" ").length >= 3 &&
  plain(text).includes(plain(quote));
const teamCommand = /^\/team\s+\S/;
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class TeamStore {
  constructor({ store }) {
    this.store = store;
    this.db = store.db;
    this.ledger = new RequestLedger(this.db);
    migrateTeams(this.db);
  }
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  rows(kind) {
    return this.db
      .prepare("SELECT body FROM assistant_team_records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(r.body));
  }
  find(id) {
    const row = this.db
      .prepare("SELECT body FROM assistant_team_records WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  get(id) {
    const result = this.find(id);
    if (!result) throw assistantProblem("notFound", 404);
    return result;
  }
  member(id) {
    const m = this.get(id);
    if (m.kind !== "member") throw assistantProblem("notFound", 404);
    return m;
  }
  insert(record, operation = null) {
    this.db
      .prepare("INSERT INTO assistant_team_records VALUES(?,?,?,?,?,?,?)")
      .run(
        record.id,
        record.kind,
        record.parentAssistantId || null,
        operation,
        record.phase || null,
        record.revision,
        JSON.stringify(record),
      );
    return record;
  }
  write(current, patch) {
    const next = {
      ...current,
      ...patch,
      id: current.id,
      kind: current.kind,
      revision: current.revision + 1,
    };
    if (
      !this.db
        .prepare(
          "UPDATE assistant_team_records SET phase=?,revision=?,body=? WHERE id=? AND revision=?",
        )
        .run(
          next.phase || null,
          next.revision,
          JSON.stringify(next),
          current.id,
          current.revision,
        ).changes
    )
      throw assistantProblem("conflict", 409);
    return next;
  }
  policy(id) {
    this.store.getAssistant(id);
    const p = this.find(`policy:${id}`);
    return p
      ? {
          revision: p.revision,
          autonomous: p.autonomous,
          maxMembers: p.maxMembers,
          runTimeoutMinutes: p.runTimeoutMinutes,
        }
      : { ...defaultTeamPolicy };
  }
  savePolicy(id, input, revision) {
    return this.transaction(() => {
      const a = this.store.getAssistant(id);
      if (a.teamMemberId) throw assistantProblem("active", 409);
      const current = this.policy(id);
      if (current.revision !== revision) throw assistantProblem("conflict", 409);
      const values = normalizeTeamPolicy(input, current);
      if (values.maxMembers > this.settings().hostMaxConcurrent)
        throw assistantProblem("conflict", 409);
      const old = this.find(`policy:${id}`);
      if (old) this.write(old, values);
      else
        this.insert({
          ...values,
          id: `policy:${id}`,
          kind: "policy",
          parentAssistantId: id,
          revision: 2,
        });
      return this.policy(id);
    });
  }
  settings() {
    const s = this.find("team-settings");
    return { revision: s?.revision || 1, hostMaxConcurrent: s?.hostMaxConcurrent || 8 };
  }
  saveSettings(input, revision) {
    return this.transaction(() => {
      const old = this.find("team-settings");
      if (this.settings().revision !== revision) throw assistantProblem("conflict", 409);
      const values = normalizeTeamSettings(input, this.rows("policy"));
      if (old) this.write(old, values);
      else this.insert({ ...values, id: "team-settings", kind: "settings", revision: 2 });
      return this.settings();
    });
  }
  recordContext(requestId, context) {
    const id = `context:${requestId}`;
    this.ledger.getRequest(requestId);
    const old = this.find(id);
    if (old) {
      if (fingerprint(old.context) !== fingerprint(context))
        throw assistantProblem("conflict", 409);
      return old.context;
    }
    this.insert({ id, kind: "context", revision: 1, context });
    return context;
  }
  context(requestId) {
    return this.find(`context:${requestId}`)?.context || { kind: "unknown" };
  }
  list(parentId) {
    return this.rows("team").filter((t) => !parentId || t.parentAssistantId === parentId);
  }
  members(teamId) {
    return this.rows("member").filter((m) => !teamId || m.teamId === teamId);
  }
  propose({
    operationId,
    parentAttemptId,
    objective,
    members,
    origin,
    ownerRequestedTeam = false,
    ownerRequestQuote,
  }) {
    textValue(operationId, 256);
    textValue(objective, 4096);
    if (typeof ownerRequestedTeam !== "boolean") throw assistantProblem("invalid");
    // A quote only proves an owner request; an unusable one is ignored, so a wrong
    // claim leads to an approval request instead of failing the proposal.
    if (
      !ownerRequestedTeam ||
      typeof ownerRequestQuote !== "string" ||
      !ownerRequestQuote.trim() ||
      ownerRequestQuote.length > 300
    )
      ownerRequestQuote = undefined;
    if (!Array.isArray(members) || !members.length || members.length > 8)
      throw assistantProblem("invalid");
    const drafts = members.map((m) => {
      if (!m || Object.keys(m).some((k) => !["name", "role", "assignment"].includes(k)))
        throw assistantProblem("invalid");
      return {
        name: textValue(m.name, 100),
        role: textValue(m.role, 200),
        assignment: textValue(m.assignment, 8192),
      };
    });
    return this.transaction(() => {
      const attempt = this.ledger.getAttempt(parentAttemptId),
        request = this.ledger.getRequest(attempt.requestId),
        conversation = this.store.getConversation(request.conversationId),
        parent = this.store.getAssistant(conversation.assistantId);
      const hash = fingerprint({ objective, members: drafts }),
        key = `${parentAttemptId}:${operationId}`;
      const old = this.db
        .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
        .get(key);
      if (old) {
        const existing = this.get(old.id);
        if (existing.fingerprint !== hash) throw assistantProblem("conflict", 409);
        return existing;
      }
      if (parent.teamMemberId || parent.archivedAt) throw assistantProblem("active", 409);
      const policy = this.policy(parent.id);
      if (members.length > policy.maxMembers) throw assistantProblem("invalid");
      if (this.list(parent.id).some((t) => !terminal.has(t.phase)))
        throw assistantProblem("active", 409);
      const context = this.context(request.id),
        ownerTurn =
          (["owner", "telegram"].includes(context.kind) && !context.forwarded) ||
          origin?.kind === "owner";
      const consumed = this.list().some(
        (t) => t.parentRequestId === request.id && t.authorization?.kind === "task",
      );
      // An explicit owner request in plain words authorizes this one team. The
      // turn context is recorded by AgentPier, never by the model, and the quote
      // must appear in the text AgentPier received for this very request.
      const ownerRequest =
        ["owner", "telegram"].includes(context.kind) &&
        !context.forwarded &&
        ownerRequestedTeam &&
        quoted(ownerRequestQuote, request.text);
      const authorization =
        ownerTurn && (context.teamAllowed || ownerRequest) && !consumed
          ? {
              kind: "task",
              requestId: request.id,
              ...(!context.teamAllowed
                ? { source: "ownerRequest", ownerRequestQuote }
                : { source: teamCommand.test(request.text) ? "command" : "checkbox" }),
            }
          : ownerTurn && policy.autonomous
            ? { kind: "standing", policyRevision: policy.revision }
            : null;
      return this.insert(
        {
          id: randomUUID(),
          kind: "team",
          revision: 1,
          parentAssistantId: parent.id,
          parentConversationId: conversation.id,
          parentRequestId: request.id,
          parentAttemptId,
          objective,
          members: drafts,
          memberIds: [],
          policy,
          snapshot: {
            parentRevision: parent.revision,
            instructions: parent.instructions,
            model: parent.model,
          },
          origin: context.kind === "unknown" ? origin || context : context,
          authorization,
          phase: authorization ? "approved" : "awaiting_approval",
          fingerprint: hash,
          lifetime: "task",
          archivedAt: null,
          createdAt: new Date().toISOString(),
        },
        key,
      );
    });
  }
  decide(id, { revision, decision, lifetime = "task" }, owner) {
    return this.transaction(() => {
      if (!["owner", "telegram"].includes(owner?.kind))
        throw assistantProblem("invalid", 403);
      const p = this.get(id);
      if (p.kind !== "team" || p.phase !== "awaiting_approval" || p.revision !== revision)
        throw assistantProblem("conflict", 409);
      if (
        !["approve", "decline"].includes(decision) ||
        !["task", "permanent"].includes(lifetime)
      )
        throw assistantProblem("invalid");
      if (
        owner.kind === "telegram" &&
        (p.origin.kind !== "telegram" ||
          ["channelId", "chatId", "userId"].some((k) => p.origin[k] !== owner[k]))
      )
        throw assistantProblem("invalid", 403);
      return this.write(p, {
        phase: decision === "approve" ? "approved" : "declined",
        lifetime,
        authorization:
          decision === "approve"
            ? { kind: "approval", proposalId: id, owner: owner.kind }
            : null,
      });
    });
  }
  reserve(id) {
    return this.transaction(() => {
      const p = this.get(id);
      if (p.memberIds?.length) return p;
      if (p.phase !== "approved" || !p.authorization)
        throw assistantProblem("conflict", 409);
      const memberIds = p.members.map((draft) => {
        const memberId = randomUUID();
        const a = this.store.reserveMember({
          id: memberId,
          parent: p.parentAssistantId,
          assignment: draft,
          snapshot: p.snapshot,
          teamId: p.id,
          lifetime: p.lifetime,
        });
        this.insert({
          id: memberId,
          kind: "member",
          revision: 1,
          teamId: p.id,
          parentAssistantId: p.parentAssistantId,
          assistantId: a.id,
          ...draft,
          snapshot: p.snapshot,
          lifetime: p.lifetime,
          phase: "queued",
          conversationId: null,
          attemptId: null,
          archivedAt: null,
        });
        return memberId;
      });
      return this.write(p, { phase: "queued", memberIds });
    });
  }
  setPhase(id, expected, patch) {
    const current = this.get(id);
    if (current.phase !== expected) throw assistantProblem("conflict", 409);
    return this.write(current, patch);
  }
  activeMember(m) {
    return (
      !terminal.has(m.phase) ||
      this.ledger
        .pending()
        .some(
          (a) =>
            this.store.getConversation(this.ledger.getRequest(a.requestId).conversationId)
              .assistantId === m.assistantId,
        )
    );
  }
  assertLifecycle(id, revision) {
    const value = this.get(id);
    if (value.revision !== revision) throw assistantProblem("conflict", 409);
    if (
      value.kind === "member"
        ? this.activeMember(value)
        : !terminal.has(value.phase) || this.members(id).some((m) => this.activeMember(m))
    )
      throw assistantProblem("active", 409);
    return value;
  }
  lifecycle(id, revision, patch) {
    return this.transaction(() => {
      const value = this.assertLifecycle(id, revision);
      const next = this.write(value, patch);
      const members = value.kind === "member" ? [next] : this.members(id);
      for (const member of members) {
        if (value.kind === "team") this.write(member, patch);
        const a = this.store.getAssistant(member.assistantId);
        const updated = {
          ...a,
          ...("lifetime" in patch ? { lifetime: patch.lifetime } : {}),
          // A promoted member keeps instructions the team lead wrote; the owner
          // reviews them before relying on the permanent agent.
          ...(patch.lifetime === "permanent" && a.lifetime !== "permanent"
            ? { instructionsSource: "model" }
            : {}),
          ...("archivedAt" in patch ? { archivedAt: patch.archivedAt } : {}),
          revision: a.revision + 1,
        };
        this.db
          .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
          .run(JSON.stringify(updated), updated.revision, a.id);
      }
      return next;
    });
  }
  promote(id, revision) {
    this.member(id);
    return this.lifecycle(id, revision, { lifetime: "permanent" });
  }
  archive(id, revision) {
    return this.lifecycle(id, revision, { archivedAt: new Date().toISOString() });
  }
  restore(id, revision) {
    return this.lifecycle(id, revision, { archivedAt: null });
  }
}
