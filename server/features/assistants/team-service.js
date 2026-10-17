import { teamStatus, memberOverrides } from "./team-presentation.js";
import { TeamStore } from "./team-store.js";
import { TeamScheduler } from "./team-scheduler.js";
import { assistantProblem } from "./assistant-validation.js";
import { decideAudited } from "./approval-audit.js";
import { assertWired } from "./service-wiring.js";
import { TeamMcpBindings } from "./team-mcp.js";
import { LeadRequests } from "./lead-requests.js";
import { publicRequest } from "./lead-request-store.js";
import { reportText } from "./team-results.js";
import { MemberGrants } from "./member-grant-requests.js";
import { mirrorLeadMemory } from "./member-memory.js";
function exact(input, keys) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
}
// Drafts show their MCP servers by name with the stdio marker, never their ids. A
// list that cannot be read is marked unavailable instead of shown short.
const servers = (ids, describe) => {
  if (!ids?.length) return {};
  const list = describe(ids);
  return list ? { mcpServers: list } : { mcpServersUnavailable: true };
};
const publicDraft = ({ mcpServerIds, ...draft }, describe) => ({
  ...draft,
  ...servers(mcpServerIds, describe),
});
export function publicTeam(record, describe = () => []) {
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
          // What the lead granted, and its later changes (member-grant-requests.js).
          "grants",
          "grantLog",
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
          "startedAt",
          "finishedAt",
          "resultState",
          "resultDiagnostic",
          "resultBatch",
        ];
  return {
    ...Object.fromEntries(keys.filter((k) => k in record).map((k) => [k, record[k]])),
    ...(record.kind === "member"
      ? servers(record.mcpServerIds, describe)
      : Array.isArray(record.members)
        ? { members: record.members.map((m) => publicDraft(m, describe)) }
        : {}),
    inheritedRevision: record.snapshot?.parentRevision,
    // Task members of this team may use the lead's shell and SSH (Work tab setting).
    ...(record.kind === "team"
      ? { memberShellSsh: record.policy?.memberShellSsh === true }
      : {}),
    // The owner's own words that started this team, shown beside it.
    ...(record.authorization?.source === "ownerRequest"
      ? { ownerRequestQuote: record.authorization.ownerRequestQuote }
      : {}),
  };
}
export class TeamService {
  constructor({
    assistants,
    store = new TeamStore({
      store: assistants.store,
      servers: () => assistants.mcp?.servers,
      sshGranted: (id) => !!assistants.workflows?.access.hasSshGrants(id),
    }),
    autoStart = true,
    now,
    audit = null,
  }) {
    Object.assign(this, { assistants, store, audit });
    this.mcp = new TeamMcpBindings({ teams: store, assistants });
    this.scheduler = new TeamScheduler({ teams: store, assistants, now, mcp: this.mcp });
    this.requests = new LeadRequests({ teams: store, service: this });
    this.grants = new MemberGrants({
      teams: store,
      assistants,
      audit,
      onChanged: (member) => this.memberChanged(member),
    });
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
    const result = publicTeam(record, (ids) => this.mcp.describe(ids));
    if (record.kind === "member")
      result.overrides = memberOverrides(
        record,
        this.assistants.store.getAssistant(record.assistantId),
      );
    else {
      result.status = teamStatus(record, this.store.members(record.id));
      // Teams that ended before finishedAt was recorded end at their synthesis turn.
      if (!result.finishedAt && record.resultAttemptId)
        try {
          result.finishedAt = this.assistants.ledger.getAttempt(
            record.resultAttemptId,
          ).createdAt;
        } catch {
          /* Unknown: the note sits beside the team's start. */
        }
    }
    return result;
  }
  list() {
    assertWired(this);
    return {
      teams: this.store.list().map((r) => this.project(r)),
      members: this.store.members().map((r) => this.project(r)),
      requests: this.requests.list(),
      settings: this.store.settings(),
      policies: Object.fromEntries(
        this.assistants.store
          .listAssistants()
          .filter((a) => !a.teamMemberId)
          .map((a) => [a.id, this.store.policy(a.id)]),
      ),
    };
  }
  /** `check` (archive only) runs inside the archiving transaction. */
  lifecycle(action, id, revision, check) {
    return this.assistants.admit(async () => {
      if (!["promote", "archive", "restore"].includes(action))
        throw assistantProblem("invalid");
      const record = this.store.assertLifecycle(id, revision);
      const members = record.kind === "member" ? [record] : this.store.members(id);
      // An archived agent must not keep answering people on its own Telegram bot.
      if (
        action === "archive" &&
        members.some((m) => this.assistants.telegramSenders?.connected(m.assistantId))
      )
        throw assistantProblem("telegramSendersArchive", 409);
      if (action === "archive")
        for (const member of members)
          if (!member.archivedAt && member.lifetime === "permanent")
            await this.assistants.reminders?.disable(member.assistantId);
      // A task member kept as a permanent agent keeps none of its lead's memory copy.
      if (action === "promote")
        for (const member of members)
          if (member.lifetime !== "permanent")
            await mirrorLeadMemory(
              this.assistants.config?.workspaces,
              this.assistants.store.getAssistant(member.assistantId),
              false,
            ).catch(() => {});
      const result =
        action === "archive"
          ? this.store.archive(id, revision, check)
          : this.store[action](id, revision);
      await this.applyMcp();
      if (this.assistants.runtime.client?.ready)
        for (const member of members) {
          await this.assistants.config.apply(member.assistantId);
          // Archive retires a check-in job, restore schedules it again.
          await this.assistants.reminders?.heartbeats
            ?.sync(member.assistantId)
            .catch(() => {});
        }
      this.assistants.changed();
      return result;
    });
  }
  /**
   * Archived agents hold no MCP servers and restored ones hold theirs again; a patch
   * that fails stays pending for the scheduler's next tick. Callers hold admission.
   */
  async applyMcp() {
    const mcp = this.assistants.mcp;
    if (!mcp) return;
    this.mcp.sync();
    this.mcp.dirty = false;
    try {
      await mcp.apply();
    } catch {
      /* Pending; retried at the next tick. */
    }
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
    if (record.phase === "approved") {
      this.store.reserve(record.id);
      // Saved now; the next tick applies it before the members are provisioned.
      this.mcp.sync();
    }
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
        // The owner approves only servers they could see.
        if (input.decision === "approve" && !this.mcp.describable(this.store.get(id)))
          throw assistantProblem("teamMcpServersUnavailable", 503);
        const record = this.store.decide(id, input, origin);
        if (record.phase === "approved") {
          this.store.reserve(id);
          this.mcp.sync();
        }
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
    const { resultBatch, ...team } = this.project(t);
    // Reports are excerpts here; the whole ones reach the lead in the synthesis turn
    // and stay in each member's chat.
    const short = resultBatch?.some((m) => m.truncated || m.cut);
    return {
      ...team,
      ...(resultBatch
        ? {
            resultBatch: resultBatch.map(({ truncated, cut, ...m }) =>
              truncated || cut ? { ...m, shortened: true } : m,
            ),
          }
        : {}),
      ...(short
        ? {
            note: "Reports marked shortened are excerpts. The whole report is in that member's own chat; the team result turn carries as much of it as fits.",
          }
        : {}),
      members: this.store.members(t.id).map((r) => this.project(r)),
    };
  }
  /** One member's whole report of a finished team, for its card. */
  report(teamId, memberId) {
    const team = this.store.get(teamId);
    const entry =
      team.kind === "team" && team.resultBatch?.find((m) => m.memberId === memberId);
    if (!entry) throw assistantProblem("notFound", 404);
    return {
      memberId,
      text: reportText(this.store, team, entry),
      ...(entry.cut ? { cut: true } : {}),
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
    // Cancelled members lose their servers at once; stopping ones once they end.
    this.mcp.sync();
    this.assistants.changed();
    return this.project(this.store.get(id));
  }
  // A lead's questions and tasks for its own members (lead-requests.js).
  members(inv, input) {
    assertWired(this);
    return this.requests.members(inv, input);
  }
  ask(inv, input) {
    assertWired(this);
    return this.requests.ask(inv, input);
  }
  delegate(inv, input) {
    assertWired(this);
    return this.requests.delegate(inv, input);
  }
  cancel(inv, input) {
    return this.requests.cancel(inv, input);
  }
  // A lead's later grant to a running task member (member-grant-requests.js).
  grant(inv, input) {
    assertWired(this);
    return this.grants.grant(inv, input);
  }
  // A changed grant reaches the member now: its servers at the next tick, its entry
  // with an apply that waits for admission (and every turn applies first anyway).
  memberChanged(member) {
    this.mcp.sync();
    const a = this.assistants;
    if (a.runtime?.client?.ready)
      Promise.resolve()
        .then(() => a.admit(() => a.config.apply(member.assistantId)))
        .catch(() => {});
  }
  archive(inv, input) {
    return this.requests.archive(inv, input);
  }
  requestDetail(id) {
    return this.requests.detail(id);
  }
  async cancelRequest(id) {
    return publicRequest(await this.requests.stop(id, "owner"));
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
      : this.scheduler.tick().finally(() => this.requests.advance());
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.poll);
    await this.bridge?.close();
    await this.scheduler.close();
    await this.requests.close();
  }
}
