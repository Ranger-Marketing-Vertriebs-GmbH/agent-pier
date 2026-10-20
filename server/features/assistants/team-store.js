import { randomUUID, createHash } from "node:crypto";
import { refuseUserAgent } from "../users/user-agent-lock.js";
import { migrateTeams } from "./team-schema.js";
import {
  defaultTeamPolicy,
  defaultTeamUsage,
  normalizeTeamPolicy,
  normalizeTeamSettings,
  teamUsageLevels,
} from "./team-policy.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { RequestLedger } from "./request-ledger.js";
import { persisted } from "./assistant-store.js";
import { leadServerIds, memberServerNames } from "./team-mcp.js";
import {
  assertWithinLead,
  defaultFor,
  defaultGrants,
  grantInput,
  removeGrants,
} from "./member-grants.js";
import { ownerTeamQuote, parseOwnerText } from "./lead-request-proof.js";
const terminal = new Set(["completed", "failed", "cancelled", "declined"]);
// The quote must prove a team request, not merely an owner turn: at least three
// words containing "team" (also in compounds such as "Rechercheteam"), as whole
// words of the owner's own prose in the stored user text of the same request (for
// Telegram voice the stored transcript), and with the same rules as a lead's quote
// of a task: never quoted, pasted, coded or linked text, and no negation anywhere.
const quoted = (quote, text, context) =>
  ownerTeamQuote(quote, parseOwnerText(text, context.hidden));
const teamCommand = /^\/team\s+\S/;
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class TeamStore {
  constructor({
    store,
    servers = () => null,
    sshGranted = () => false,
    projectFiles = () => ({}),
    github = () => null,
  }) {
    this.store = store;
    // Whether an agent holds an SSH grant (AssistantAccess.hasSshGrants).
    this.sshGranted = sshGranted;
    // An agent's project folder levels (AssistantAccess projectFiles), read live.
    this.projectFiles = projectFiles;
    // An agent's own GitHub access (agent-github.js held), read live.
    this.github = github;
    // The central MCP server store, looked up when a proposal names servers.
    this.servers = servers;
    this.db = store.db;
    this.ledger = new RequestLedger(this.db);
    migrateTeams(this.db);
    store.memberGrants = (member) => ({
      // Members reserved before grants existed get the default.
      // Members reserved before grants existed get the default (within the lead).
      grants: this.find(member.teamMemberId)?.grants ?? defaultGrants,
      shellSsh: this.shellSsh(member.teamId, member.parentAssistantId),
    });
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
  /**
   * Whether a team's members may use shell and SSH right now: the team was proposed
   * while the lead's "Team members may use shell and SSH" was on and it still is, so
   * a setting switched on later never widens a team.
   */
  shellSsh(teamId, leadId) {
    return (
      !!this.find(teamId)?.policy?.memberShellSsh &&
      !!this.find(`policy:${leadId}`)?.memberShellSsh
    );
  }
  /**
   * The lead's "Team members may use shell and SSH" went off: its teams lose the
   * setting for good (switching it on again restores nothing) and their members
   * lose their shell and SSH grants, logged as the owner's change. Pending cards
   * are cancelled by MemberGrants.settingOff.
   */
  latchShellSsh(leadId) {
    const at = new Date().toISOString();
    for (const team of this.list(leadId)) {
      if (team.policy?.memberShellSsh)
        this.write(team, { policy: { ...team.policy, memberShellSsh: false } });
      for (const m of this.members(team.id)) {
        const revoked = ["shell", "ssh"].filter((key) => m.grants?.[key]);
        if (!revoked.length) continue;
        this.write(m, {
          grants: removeGrants(m.grants, { shell: true, ssh: true }),
          grantLog: [...(m.grantLog || []), { at, by: "owner", revoked }].slice(-50),
        });
      }
    }
  }
  policy(id) {
    this.store.getAssistant(id);
    const p = this.find(`policy:${id}`);
    return p
      ? {
          revision: p.revision,
          autonomous: p.autonomous,
          // Policies saved before team usage levels existed use the default.
          usage: teamUsageLevels.includes(p.usage) ? p.usage : defaultTeamUsage,
          maxMembers: p.maxMembers,
          runTimeoutMinutes: p.runTimeoutMinutes,
          memberShellSsh: p.memberShellSsh === true,
        }
      : { ...defaultTeamPolicy };
  }
  /** savePolicy without its own transaction, for a caller that already holds one. */
  writePolicy(id, input, revision) {
    const a = this.store.getAssistant(id);
    if (a.teamMemberId) throw assistantProblem("active", 409);
    refuseUserAgent(a);
    const current = this.policy(id);
    if (current.revision !== revision) throw assistantProblem("conflict", 409);
    const values = normalizeTeamPolicy(input, current);
    if (current.memberShellSsh && values.memberShellSsh === false) this.latchShellSsh(id);
    if (values.maxMembers > this.settings().hostMaxConcurrent)
      throw assistantProblem("capacity", 409);
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
  }
  savePolicy(id, input, revision) {
    return this.transaction(() => this.writePolicy(id, input, revision));
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
    // `template` and its instructions come from TeamService (team-templates.js).
    const memberKeys = [
      "name",
      "role",
      "assignment",
      "mcpServers",
      "grants",
      "template",
      "templateInstructions",
    ];
    const drafts = members.map((m) => {
      if (!m || Object.keys(m).some((k) => !memberKeys.includes(k)))
        throw assistantProblem("invalid");
      const servers = memberServerNames(m.mcpServers);
      return {
        name: textValue(m.name, 100),
        role: textValue(m.role, 200),
        assignment: textValue(m.assignment, 8192),
        // Server names and grants belong to the fingerprint: other ones are another
        // proposal.
        ...(servers.length ? { mcpServers: servers } : {}),
        ...(m.template
          ? {
              template: m.template,
              templateInstructions: textValue(m.templateInstructions, 48000),
            }
          : {}),
        ...(m.grants !== undefined ? { grants: grantInput(m.grants) } : {}),
      };
    });
    return this.transaction(() => {
      const attempt = this.ledger.getAttempt(parentAttemptId),
        request = this.ledger.getRequest(attempt.requestId),
        conversation = this.store.getConversation(request.conversationId),
        parent = this.store.getAssistant(conversation.assistantId);
      // A template counts by its id, as the lead named it: a retry after the catalog
      // moved to a new revision is the same proposal.
      const hash = fingerprint({
          objective,
          members: drafts.map(({ template, templateInstructions: _text, ...d }) => ({
            ...d,
            ...(template ? { template: template.id } : {}),
          })),
        }),
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
      // A lead passes on only servers bound to itself, resolved now by name, and
      // only what it holds itself; without grants a member gets the default.
      const shellSsh = policy.memberShellSsh === true;
      const stored = drafts.map(({ mcpServers = [], grants, ...draft }) => {
        const ids = leadServerIds(this.servers(), parent.id, mcpServers);
        if (grants)
          assertWithinLead(parent, grants, {
            shellSsh,
            ssh: !!this.sshGranted(parent.id),
            projects: this.projectFiles(parent.id),
            github: this.github(parent.id),
          });
        return {
          ...draft,
          grants: grants ?? defaultFor(parent),
          ...(ids.length ? { mcpServerIds: ids } : {}),
        };
      });
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
        quoted(ownerRequestQuote, request.text, context);
      // Shell or SSH for a member always waits for the owner's own decision.
      // So does a template the scan warned about (team-templates.js).
      const ownerMust = stored.some(
        (m) => m.grants.shell || m.grants.ssh || m.template?.verdict === "warn",
      );
      const authorization = ownerMust
        ? null
        : ownerTurn && (context.teamAllowed || ownerRequest) && !consumed
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
          members: stored,
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
        ...(decision === "decline" ? { finishedAt: new Date().toISOString() } : {}),
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
      // When the team actually started; the lead's chat places its start note there.
      return this.write(p, {
        phase: "queued",
        memberIds,
        startedAt: new Date().toISOString(),
      });
    });
  }
  setPhase(id, expected, patch) {
    const current = this.get(id);
    if (current.phase !== expected) throw assistantProblem("conflict", 409);
    return this.write(current, patch);
  }
  turnInFlight(m) {
    return this.ledger
      .pending()
      .some(
        (a) =>
          this.store.getConversation(this.ledger.getRequest(a.requestId).conversationId)
            .assistantId === m.assistantId,
      );
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
  // `turnOnly`: a lead's promotion waits only for a turn in flight, not for the end
  // of the member's task (member-promotion.js).
  assertLifecycle(id, revision, { turnOnly = false } = {}) {
    const value = this.get(id);
    if (value.revision !== revision) throw assistantProblem("conflict", 409);
    if (
      value.kind === "member"
        ? turnOnly
          ? this.turnInFlight(value)
          : this.activeMember(value)
        : !terminal.has(value.phase) || this.members(id).some((m) => this.activeMember(m))
    )
      throw assistantProblem("active", 409);
    return value;
  }
  lifecycle(id, revision, patch, check, options) {
    return this.transaction(() => {
      const value = this.assertLifecycle(id, revision, options);
      // A caller's own conditions, re-checked in the same transaction.
      check?.(value);
      // A kept member runs on its lead's model of this moment from now on, and a later
      // change of its own counts against it (memberOverrides).
      const frozen = (member) =>
        patch.lifetime === "permanent" && member.lifetime !== "permanent"
          ? {
              snapshot: {
                ...member.snapshot,
                model: this.store.getAssistant(member.assistantId).model,
              },
            }
          : {};
      const next = this.write(
        value,
        value.kind === "member" ? { ...patch, ...frozen(value) } : patch,
      );
      const members = value.kind === "member" ? [next] : this.members(id);
      for (const member of members) {
        if (value.kind === "team") this.write(member, { ...patch, ...frozen(member) });
        // Read with the model it runs on: a temporary member's is its lead's, which
        // the stored record keeps once the member is permanent.
        const a = persisted(this.store.getAssistant(member.assistantId));
        const updated = {
          ...a,
          ...("lifetime" in patch ? { lifetime: patch.lifetime } : {}),
          // A promoted member keeps instructions the team lead wrote; the owner
          // reviews them before relying on the permanent agent.
          ...(patch.lifetime === "permanent" && a.lifetime !== "permanent"
            ? { instructionsSource: "model" }
            : {}),
          ...("archivedAt" in patch ? { archivedAt: patch.archivedAt } : {}),
          // A promotion's own settings, written in the same transaction.
          ...(options?.assistantPatch?.(a) || {}),
          revision: a.revision + 1,
        };
        this.db
          .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
          .run(JSON.stringify(updated), updated.revision, a.id);
      }
      return next;
    });
  }
  // A promoted task member keeps its own memory, readable and writable.
  promote(id, revision) {
    const m = this.member(id);
    return this.lifecycle(id, revision, { lifetime: "permanent" }, null, {
      assistantPatch: (a) =>
        m.lifetime === "permanent"
          ? {}
          : { capabilities: { ...(a.capabilities || {}), memory: true } },
    });
  }
  /**
   * A lead keeps its own member as a permanent agent (member-promotion.js): the
   * flip, the member's record and its new own settings in one transaction.
   */
  promoteByLead(id, revision, { memberPatch = {}, settings = {} } = {}) {
    this.member(id);
    return this.lifecycle(id, revision, { lifetime: "permanent", ...memberPatch }, null, {
      turnOnly: true,
      assistantPatch: () => settings,
    });
  }
  archive(id, revision, check) {
    return this.lifecycle(id, revision, { archivedAt: new Date().toISOString() }, check);
  }
  restore(id, revision) {
    return this.lifecycle(id, revision, { archivedAt: null });
  }
}
