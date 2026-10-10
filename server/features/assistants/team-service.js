import { teamStatus, memberOverrides } from "./team-presentation.js";
import { TeamStore } from "./team-store.js";
import { TeamScheduler } from "./team-scheduler.js";
import { assistantProblem } from "./assistant-validation.js";
import { decideAudited } from "./approval-audit.js";
import { assertWired } from "./service-wiring.js";
function exact(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
}
export function publicTeam(record) {
  const keys =
    record.kind === "member"
      ? [
          "id",
          "kind",
          "revision",
          "teamId",
          "parentAssistantId",
          "assistantId",
          "name",
          "role",
          "assignment",
          "lifetime",
          "phase",
          "conversationId",
          "attemptId",
          "archivedAt",
          "diagnostic",
        ]
      : [
          "id",
          "kind",
          "revision",
          "parentAssistantId",
          "parentConversationId",
          "objective",
          "members",
          "memberIds",
          "phase",
          "lifetime",
          "archivedAt",
          "createdAt",
          "resultState",
          "resultDiagnostic",
          "resultBatch",
        ];
  return {
    ...Object.fromEntries(keys.filter((k) => k in record).map((k) => [k, record[k]])),
    inheritedRevision: record.snapshot?.parentRevision,
    // The owner's own words that started this team, shown beside it.
    ...(record.authorization?.source === "ownerRequest"
      ? { ownerRequestQuote: record.authorization.ownerRequestQuote }
      : {}),
  };
}
export class TeamService {
  constructor({
    assistants,
    store = new TeamStore({ store: assistants.store }),
    autoStart = true,
    now,
    audit = null,
  }) {
    Object.assign(this, { assistants, store, audit });
    this.scheduler = new TeamScheduler({ teams: store, assistants, now });
    if (autoStart) {
      this.poll = setInterval(() => this.reconcile().catch(() => {}), 1000);
      this.poll.unref();
    }
  }
  assertMemberTurn(id, context) {
    const assistant = this.assistants.store.getAssistant(id);
    if (assistant.archivedAt) throw assistantProblem("active", 409);
    if (!assistant.teamMemberId) return;
    const m = this.store.member(id);
    if (
      context.kind === "team-member" &&
      context.memberId === id &&
      m.phase === "admitting" &&
      !m.stopRequested
    )
      return;
    if (this.store.activeMember(m)) throw assistantProblem("active", 409);
    const occupied = this.store
      .members()
      .filter(
        (member) => member.phase !== "queued" && this.store.activeMember(member),
      ).length;
    if (occupied >= this.store.settings().hostMaxConcurrent)
      throw assistantProblem("active", 409);
  }
  subscribe(listener) {
    return this.assistants.events.subscribe(listener);
  }
  project(record) {
    const result = publicTeam(record);
    if (record.kind === "member")
      result.overrides = memberOverrides(
        record,
        this.assistants.store.getAssistant(record.assistantId),
      );
    else result.status = teamStatus(record, this.store.members(record.id));
    return result;
  }
  list() {
    assertWired(this);
    return {
      teams: this.store.list().map((r) => this.project(r)),
      members: this.store.members().map((r) => this.project(r)),
      settings: this.store.settings(),
      policies: Object.fromEntries(
        this.assistants.store
          .listAssistants()
          .filter((a) => !a.teamMemberId)
          .map((a) => [a.id, this.store.policy(a.id)]),
      ),
    };
  }
  lifecycle(action, id, revision) {
    return this.assistants.admit(async () => {
      if (!["promote", "archive", "restore"].includes(action))
        throw assistantProblem("invalid");
      const record = this.store.assertLifecycle(id, revision);
      const members = record.kind === "member" ? [record] : this.store.members(id);
      if (action === "archive")
        for (const member of members)
          if (!member.archivedAt && member.lifetime === "permanent")
            await this.assistants.reminders?.disable(member.assistantId);
      const result = this.store[action](id, revision);
      if (this.assistants.runtime.client?.ready)
        for (const member of members)
          await this.assistants.config.apply(member.assistantId);
      this.assistants.changed();
      return result;
    });
  }
  async propose(inv, input) {
    assertWired(this);
    exact(input, ["objective", "members", "ownerRequestedTeam", "ownerRequestQuote"]);
    inv.assertCurrent();
    const a = this.assistants,
      attempt = a.ledger.getAttempt(inv.attemptId),
      request = a.ledger.getRequest(attempt.requestId),
      parent = a.store.getAssistant(
        a.store.getConversation(request.conversationId).assistantId,
      );
    const lease = await a.models.resolve(parent.model);
    lease.release();
    inv.assertCurrent();
    if (this.closed) throw assistantProblem("unavailable", 503);
    const record = this.store.propose({
      ...input,
      operationId: inv.toolCallId,
      parentAttemptId: inv.attemptId,
    });
    if (record.phase === "approved") this.store.reserve(record.id);
    a.changed();
    return this.project(this.store.get(record.id));
  }
  decide(id, input, origin) {
    return decideAudited(
      this.audit,
      {
        origin,
        actionId: id,
        decision: input?.decision,
        revision: input?.revision,
        kind: "team",
        assistantId: () => this.store.get(id).parentAssistantId,
      },
      () => {
        exact(input, ["revision", "decision", "lifetime"]);
        const record = this.store.decide(id, input, origin);
        if (record.phase === "approved") this.store.reserve(id);
        this.assistants.changed();
        return this.project(this.store.get(id));
      },
    );
  }
  owned(inv, input) {
    inv.assertCurrent();
    exact(input, ["teamId", "memberId"]);
    const a = this.assistants,
      r = a.ledger.getRequest(a.ledger.getAttempt(inv.attemptId).requestId),
      team = this.store.get(input.teamId);
    if (
      team.kind !== "team" ||
      a.store.getConversation(r.conversationId).assistantId !== team.parentAssistantId
    )
      throw assistantProblem("invalid", 403);
    return team;
  }
  status(inv, input) {
    const t = this.owned(inv, input);
    return {
      ...this.project(t),
      members: this.store.members(t.id).map((r) => this.project(r)),
    };
  }
  async stop(id, memberId) {
    const tool = typeof id !== "string";
    if (tool) {
      const inv = id,
        input = memberId;
      id = this.owned(inv, input).id;
      memberId = input.memberId;
    }
    const t = this.store.get(id);
    if (t.kind !== "team") throw assistantProblem("notFound", 404);
    const origin = tool
      ? { kind: "owner", actor: "assistant", channel: "tool" }
      : { kind: "owner", channel: "ui" };
    // A parent's own stop tool withdraws its proposal; the owner stops through the UI.
    if (t.phase === "awaiting_approval")
      return this.decide(id, { revision: t.revision, decision: "decline" }, origin);
    const members = this.store.members(id);
    if (memberId && !members.some((m) => m.id === memberId))
      throw assistantProblem("notFound", 404);
    // Pending coding requests of the stopped members can no longer be approved.
    this.assistants.workflows?.withdrawTeam(id, memberId, origin);
    await Promise.all(
      members
        .filter((m) => !memberId || m.id === memberId)
        .map((m) => this.scheduler.stop(m.id)),
    );
    this.assistants.changed();
    return this.project(this.store.get(id));
  }
  async recoverMember(id, input) {
    exact(input, ["revision", "acknowledgeUnknownOutcome"]);
    const a = this.assistants,
      member = this.store.member(id);
    if (input.acknowledgeUnknownOutcome !== true) throw assistantProblem("invalid");
    if (member.revision !== input.revision || member.phase !== "provisioning_uncertain")
      throw assistantProblem("conflict", 409);
    if (a.recovering || a.ledger.pending().length) throw assistantProblem("active", 409);
    a.recovering = true;
    try {
      await a.runtime.stop();
      await Promise.allSettled(
        [...a.locks.values(), this.scheduler.running].filter(Boolean),
      );
      const current = this.store.member(id);
      if (current.phase !== "provisioning_uncertain")
        throw assistantProblem("conflict", 409);
      this.store.write(current, { phase: "failed", diagnostic: "OUTCOME_REVIEWED" });
      await a.runtime.start();
      a.changed();
      return this.project(this.store.member(id));
    } finally {
      a.recovering = false;
    }
  }
  reconcile() {
    return this.assistants.recovering || this.assistants.maintenance
      ? Promise.resolve()
      : this.scheduler.tick();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    await this.bridge?.close();
    await this.scheduler.close();
  }
}
