import { AssistantAccess, exact } from "./assistant-access.js";
import {
  AssistantActionStore,
  actionTerminal as terminal,
} from "./assistant-action-store.js";
import { AssistantMemoryForget } from "./assistant-memory-forget.js";
import { AssistantCoding } from "./assistant-coding.js";
import {
  noteCodingRun,
  notifyAction,
  telegramTarget,
} from "./assistant-action-notifications.js";
import { deliverMemoryFollowUp } from "./memory-follow-up.js";
import { deliverFollowUps } from "./team-coding.js";
import { decideAudited } from "./approval-audit.js";
import { approvalAudience } from "../users/approval-audience.js";
import { assistantProblem } from "./assistant-validation.js";
import { permanentReasons } from "./native-routines.js";
import { ExecApprovals, execDecisions } from "./exec-approvals.js";
import { allowAlwaysByAgentPier, decideExec, execPlan } from "./exec-decisions.js";
import { AgentSsh } from "./agent-ssh.js";
import { sshDecisions } from "./agent-ssh-approvals.js";
import { sshTelegramApprovable } from "./agent-ssh-notifications.js";
import { sftpDecisions } from "./agent-sftp-approvals.js";
import { sftpTelegramApprovable } from "./agent-sftp-notifications.js";
import { AgentProjectFiles } from "./agent-project-files.js";
import { AgentBrowserUploads } from "./agent-browser-uploads.js";
import { LeadShares } from "./lead-shares.js";
import { TaskMemberGrants } from "./task-member-grants.js";
import { workspaceCall, workspaceContext } from "./workspace-calls.js";
import { AgentGithub } from "./agent-github.js";
import { backfillSshCommands } from "./ssh-command-backfill.js";
import {
  advanceHookProposal,
  decideHookProposal,
  decisionKeys,
} from "./agent-hook-proposals.js";
import { advanceSshProposal, decideSshProposal } from "./agent-ssh-proposals.js";
const maxEventRetryMs = 300000;
// How long an expired exec action waits for the Gateway's own outcome.
const execExpiryGraceMs = 60000;
export class AssistantWorkflows {
  constructor({ services, autoStart = true, now = Date.now }) {
    this.now = now;
    this.s = services;
    this.a = services.assistants;
    this.access = new AssistantAccess(services);
    this.store = new AssistantActionStore(this.a.store.db);
    this.store.onWrite = (...rows) => this.written(rows);
    this.coding = new AssistantCoding(this);
    this.exec = new ExecApprovals(this);
    this.ssh = new AgentSsh(this);
    this.forget = new AssistantMemoryForget(this);
    this.folders = new AgentProjectFiles(this);
    this.browserUploads = new AgentBrowserUploads(this);
    this.shares = new LeadShares(this);
    this.memberGrants = new TaskMemberGrants(this);
    this.github = new AgentGithub(this);
    if (autoStart) this.start();
  }
  /** Starts advancing open actions; the application starts it after recovery. */
  start() {
    if (this.timer || this.closed) return;
    // Once, before the first tick: SSH commands stored before redaction existed.
    backfillSshCommands(this);
    this.ssh.start().catch(() => {});
    // Staged browser uploads of an earlier process go (agent-browser-uploads.js).
    this.browserUploads.start();
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  get(id) {
    return this.store.get(id);
  }
  project(a) {
    const projected = Object.fromEntries(
      [
        "id",
        "assistantId",
        "revision",
        "payload",
        "state",
        "createdAt",
        "expiresAt",
        "runId",
        "run",
        "result",
        "projectName",
        "pipelineName",
        "requestedBy",
        "onBehalfOf",
        "teamId",
        "leadAssistantId",
        "memberName",
        "diagnostic",
      ]
        .filter((k) => k in a)
        .map((k) => [k, a[k]]),
    );
    // allow-always on this request makes AgentPier write the allowlist entry,
    // which the owner is warned about before deciding.
    if (a.payload?.action === "exec" && allowAlwaysByAgentPier(a.payload)) {
      projected.allowAlwaysByAgentPier = true;
      // `{ kind: "paths", paths }` or `{ kind: "once", reason, program? }`.
      projected.allowAlwaysPlan = execPlan(a.payload);
    } else if (a.payload?.action === "exec") projected.allowAlwaysByAgentPier = false;
    return projected;
  }
  // `delegated` adds members' requests still waiting in turns this agent delegated,
  // for the owner's views; the agent's own tool listing leaves them out.
  list(id, { delegated = false } = {}) {
    this.a.store.getAssistant(id);
    const actions = this.store.list(id);
    if (delegated) actions.push(...this.store.delegated(id));
    return {
      actions: actions.map((a) => ({ ...this.project(a), ...this.liveRun(a) })),
    };
  }
  /**
   * What waits for the owner in this agent's chat, pushed on its chat feed
   * (conversation-feeds.js): its approvals (team coding requests included), its
   * members' approvals in turns it delegated, and allowed SSH commands and SFTP jobs
   * while they run. Null when the agent is gone.
   */
  pending(id) {
    try {
      return this.list(id, { delegated: true }).actions.filter(
        (a) =>
          a.state === "awaiting_approval" ||
          (["ssh", "sftp"].includes(a.payload?.action) && a.state === "executing"),
      );
    } catch {
      return null;
    }
  }
  // Every written action re-reads the open chats of its agent and of the lead that
  // shows it, once per batch of writes.
  written(rows) {
    this.touched ??= new Set();
    for (const a of rows)
      for (const id of [a?.assistantId, a?.leadAssistantId]) if (id) this.touched.add(id);
    if (this.flushing) return;
    this.flushing = true;
    queueMicrotask(() => {
      const ids = this.touched;
      this.touched = new Set();
      this.flushing = false;
      this.a.feeds?.invalidateOwners(ids);
    });
  }
  // The run as it is now; the stored snapshot only covers runs that are gone.
  liveRun(a) {
    if (!a.runId || !a.run) return {};
    try {
      return { run: this.s.mcpTools.summary(this.s.pipelines.get(a.runId)) };
    } catch {
      return {};
    }
  }
  /** A workspace call's turn context (workspace-calls.js workspaceContext). */
  context(inv) {
    return workspaceContext(this, inv);
  }
  authorize(action) {
    // A request on a lead's share is authorized on the lead's grant (lead-shares.js).
    const p = (action.inherited ? this.shares : this.access).authorize(
      action.assistantId,
      action.payload.projectId,
      action.payload.pipelineId,
      action.accessRevision,
      action.inherited,
    );
    if (action.payload.action === "memory_write" && !p.memoryWrite)
      throw assistantProblem("invalid", 403);
    return p;
  }
  invoke(inv, input) {
    return this.a.admit(() => workspaceCall(this, inv, input));
  }
  decide(id, input, origin) {
    let kind = "action";
    try {
      kind =
        { exec: "exec", ssh: "ssh", sftp: "sftp" }[this.store.get(id).payload.action] ||
        "action";
    } catch {}
    const exec = kind === "exec";
    return decideAudited(
      this.s.audit,
      {
        origin: this.auditOrigin(id, origin),
        actionId: id,
        decision: input?.decision,
        revision: input?.revision,
        kind,
        assistantId: () => this.store.get(id).assistantId,
        attribution: () => this.store.get(id),
        // Whether AgentPier wrote the allowlist entry for a withheld allow-always.
        outcome: (result) => {
          const allowlist = result?.result?.allowlist;
          if (!exec || !allowlist) return {};
          const outcome = { resolvedAs: result.result.resolvedAs };
          if (allowlist.written)
            return {
              ...outcome,
              allowlist: "written",
              allowlistEntryIds: allowlist.entries.map((e) => e.entryId),
            };
          if (allowlist.skipped)
            return {
              ...outcome,
              allowlist: "skipped",
              allowlistReason: allowlist.skipped,
            };
          return { ...outcome, allowlist: "failed", allowlistError: allowlist.code };
        },
      },
      () => this.decideOnce(id, input, origin),
    );
  }
  // A button of a user's own bot decides as her, so the audit names her, not the owner.
  auditOrigin(id, origin) {
    if (origin?.kind !== "telegram") return origin;
    try {
      const audience = approvalAudience(this.store.get(id), this.a.store);
      if (audience.kind === "user")
        return { ...origin, actor: "user", actorUserId: audience.userId };
    } catch {}
    return origin;
  }
  decideOnce(id, input, origin) {
    return this.a.admit(async () => {
      // The owner's edited rights of a hook proposal, or his key and mode for an SSH
      // access proposal, come with his decision.
      exact(input, decisionKeys(this, id, input, origin));
      const coding = ["approve", "decline", "review"];
      if (![...coding, ...execDecisions].includes(input.decision))
        throw assistantProblem("invalid");
      const action = this.store.get(id);
      // Exec approvals take the Gateway's decisions; other actions their own.
      const exec = action.payload.action === "exec",
        ssh = action.payload.action === "ssh",
        sftp = action.payload.action === "sftp";
      const allowed = exec
        ? execDecisions
        : ssh
          ? sshDecisions
          : sftp
            ? sftpDecisions
            : coding;
      if (!allowed.includes(input.decision)) throw assistantProblem("invalid");
      if (input.decision === "review" && origin.kind !== "owner")
        throw assistantProblem("invalid", 403);
      // Telegram approves only commands it showed in full (agent-ssh-notifications.js).
      if (
        ssh &&
        input.decision === "approve" &&
        origin.kind !== "owner" &&
        !sshTelegramApprovable(action.payload.command)
      )
        throw assistantProblem("invalid", 403);
      // Likewise only SFTP plans it listed in full (agent-sftp-notifications.js).
      if (
        sftp &&
        input.decision !== "decline" &&
        origin.kind !== "owner" &&
        !sftpTelegramApprovable(action.payload)
      )
        throw assistantProblem("invalid", 403);
      // A user's approval is hers alone: the owner never finds it, another user neither.
      // Her own bot's buttons decide it too; the chat check below proves the button.
      const audience = approvalAudience(action, this.a.store);
      if (
        audience.kind === "user"
          ? origin.kind === "user"
            ? origin.userId !== audience.userId
            : origin.kind !== "telegram"
          : origin.kind === "user"
      )
        throw assistantProblem("notFound", 404);
      const target = telegramTarget(action);
      if (
        origin.kind !== "owner" &&
        origin.kind !== "user" &&
        !(
          origin.kind === "telegram" &&
          target &&
          ["channelId", "chatId", "userId"].every((k) => origin[k] === target[k])
        )
      )
        throw assistantProblem("invalid", 403);
      if (
        action.revision !== input.revision ||
        action.state !==
          (input.decision === "review" ? "unknown" : "awaiting_approval") ||
        (input.decision !== "review" && action.expiresAt < Date.now())
      )
        throw assistantProblem("conflict", 409);
      // SSH approvals re-check grant, host and pin themselves (agent-ssh-approvals.js),
      // a member's shell or SSH grant its lead's ceiling (member-grant-requests.js).
      if (ssh) return this.project(this.ssh.approvals.decide(action, input.decision));
      if (sftp)
        return this.project(this.ssh.sftp.approvals.decide(action, input.decision));
      if (action.payload.action === "member_grant")
        return this.project(this.a.teams.grants.decide(action, input.decision));
      if (action.payload.action === "hook_proposal")
        return this.project(decideHookProposal(this, action, input.decision, input));
      if (action.payload.action === "ssh_access")
        return this.project(await decideSshProposal(this, action, input.decision, input));
      // Project grants do not apply to exec; the Gateway decides the request.
      if (exec) return this.project(await decideExec(this, action, input.decision));
      if (input.decision === "approve")
        try {
          this.authorize(action);
        } catch (error) {
          this.revoked(action, error);
          throw error;
        }
      const next = this.store.patch(id, {
        state: { approve: "approved", decline: "declined", review: "reviewed" }[
          input.decision
        ],
      });
      this.a.changed({ feeds: false });
      return this.project(next);
    });
  }
  // Access changed since the request: the action fails closed and never starts.
  revoked(action, error) {
    if (![403, 404, 409].includes(error.status)) throw error;
    const next = this.store.patch(action.id, {
      state: "failed",
      diagnostic: "GRANT_REVOKED",
    });
    this.a.changed({ feeds: false });
    return next;
  }
  /**
   * A project row that was merged into or rebound to `toId` leaves every agent's
   * grants, and its approvals that have not started fail closed. Agent access never
   * follows a project to another row (docs/assistant-release-qualification.md): the
   * owner grants the surviving row explicitly. One audit record per changed agent.
   */
  // Whether a grant or an unstarted approval still names the project.
  holdsProject(projectId) {
    return (
      this.access.holdsProject(projectId) || this.store.unstarted(projectId).length > 0
    );
  }
  // Runs during agent maintenance as well, like an SSH host removal (revokeSsh).
  revokeProject(projectId, toId) {
    const closed = new Map();
    const changed = this.access.revokeProject(projectId, () => {
      for (const a of this.store.unstarted(projectId)) {
        this.store.patch(a.id, { state: "failed", diagnostic: "GRANT_REVOKED" });
        closed.set(a.assistantId, (closed.get(a.assistantId) || 0) + 1);
      }
    });
    const revisions = new Map(changed.map((c) => [c.id, c.after.revision]));
    for (const id of new Set([...revisions.keys(), ...closed.keys()]))
      try {
        this.s.audit?.append({
          action: "assistant.updated",
          resourceType: "assistant",
          resourceId: id,
          projectId: toId,
          source: "system",
          outcome: "success",
          details: {
            kind: "project-rebind",
            fromProjectId: projectId,
            ...(revisions.has(id) ? { revision: revisions.get(id) } : {}),
            count: closed.get(id) || 0,
          },
        });
      } catch (error) {
        console.error("Agent project grant audit failed:", error?.message);
      }
    if (changed.length || closed.size) this.a.changed();
  }
  // Stopping a team (or one member) withdraws its pending member requests, so
  // they can no longer be approved; each withdrawal is audited.
  withdrawTeam(teamId, memberId, origin) {
    for (const a of this.store.list()) {
      if (
        a.teamId !== teamId ||
        a.state !== "awaiting_approval" ||
        (memberId && a.requestedBy !== memberId)
      )
        continue;
      decideAudited(
        this.s.audit,
        {
          origin,
          actionId: a.id,
          decision: "decline",
          revision: a.revision,
          kind: "action",
          assistantId: () => a.assistantId,
          attribution: () => a,
        },
        () => this.store.patch(a.id, { state: "declined", diagnostic: "TEAM_STOPPED" }),
      );
    }
    this.a.changed({ feeds: false });
  }
  tick() {
    if (this.closed || this.a.maintenance) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.advance().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  // A pass that wrote no action changes nothing the owner sees.
  async advance() {
    const writes = this.store.writes;
    for (const action of this.store.open()) {
      if (this.closed || this.a.maintenance) return;
      try {
        await this.advanceAction(this.store.get(action.id));
      } catch {
        const current = this.store.get(action.id);
        if (["executing", "running"].includes(current.state))
          this.store.patch(action.id, { state: "unknown" });
      }
    }
    if (this.store.writes !== writes) this.a.changed({ feeds: false });
  }
  async advanceAction(a) {
    if (a.payload.action === "ssh") return this.ssh.approvals.advance(a);
    if (a.payload.action === "sftp") return this.ssh.sftp.approvals.advance(a);
    if (a.payload.action === "member_grant") return this.a.teams?.grants?.advance(a);
    if (a.payload.action === "hook_proposal") return advanceHookProposal(this, a);
    if (a.payload.action === "ssh_access") return advanceSshProposal(this, a);
    // An exec decision being sent finishes the action itself.
    if (a.payload.action === "exec" && this.exec.deciding.has(a.payload.approvalId))
      return;
    if (a.state === "awaiting_approval") {
      // An exec request's outcome is the Gateway's: a decision whose reply was
      // lost may still have run it, so its list and history decide while it is
      // reachable. Without it, or once the grace has passed, the clock decides.
      if (
        a.expiresAt < Date.now() &&
        a.payload.action === "exec" &&
        this.a.runtime?.client?.ready &&
        Date.now() < a.expiresAt + execExpiryGraceMs
      )
        return this.exec.expired();
      if (a.expiresAt < Date.now()) a = this.store.patch(a.id, { state: "expired" });
      else notifyAction(this, a, "approval");
    }
    if (a.state === "approved")
      try {
        this.authorize(a);
      } catch (error) {
        a = [403, 404, 409].includes(error.status)
          ? this.revoked(a, error)
          : this.store.patch(a.id, {
              state: [400, 422].includes(error.status) ? "failed" : "unknown",
            });
      }
    if (a.state === "approved") {
      try {
        a = this.store.patch(a.id, { state: "executing" });
        if (a.payload.action === "coding_start") {
          const result = await this.coding.start(a);
          a = this.store.patch(a.id, {
            state: "running",
            runId: result.run.id,
            run: result.run,
          });
        } else {
          const { action: _action, projectId, ...input } = a.payload;
          const result = this.s.memory.write(
            projectId,
            { ...input, requestId: a.id },
            { kind: "assistant", assistantId: a.assistantId, actionId: a.id },
          );
          a = this.store.patch(a.id, {
            state: "completed",
            result: { id: result.id, revision: result.revision },
          });
        }
      } catch (error) {
        a = this.store.patch(a.id, {
          ...this.forget.refusal(a, error),
          state:
            a.payload.action === "coding_start" && this.coding.receipt(a)
              ? "unknown"
              : [400, 403, 404, 409, 422].includes(error.status)
                ? "failed"
                : "unknown",
        });
        this.forget.refused(a);
      }
    }
    if (a.state === "unknown") {
      if (a.payload.action === "coding_start") {
        const run = this.coding.recover(a);
        if (run) a = this.store.patch(a.id, { state: "running", runId: run.id, run });
      } else {
        const result = this.s.memory.writeReceipt(
          a.payload.projectId,
          `assistant:${a.assistantId}`,
          a.id,
        );
        if (result)
          a = this.store.patch(a.id, {
            state: "completed",
            result: { id: result.id, revision: result.revision },
          });
      }
    }
    if (a.state === "unknown") notifyAction(this, a, "unknown");
    if (a.state === "running") {
      const run = this.s.mcpTools.summary(this.s.pipelines.get(a.runId));
      const state = ["completed", "failed", "cancelled"].includes(run.status)
        ? run.status
        : "running";
      if (JSON.stringify(a.run) !== JSON.stringify(run) || a.state !== state)
        a = this.store.patch(a.id, { state, run });
      notifyAction(this, a, run.status === "awaiting-human" ? "human" : "started");
      a = noteCodingRun(this, a);
    }
    if (terminal.has(a.state)) {
      a = noteCodingRun(this, a);
      notifyAction(this, a, "result");
      const emitted = await this.emitCompletion(a),
        delivered = await deliverFollowUps(this, a),
        reported = await deliverMemoryFollowUp(this, a);
      if (emitted && delivered && reported) this.store.patch(a.id, { settled: true });
    }
  }
  // Returns whether the terminal action has no follow-up work left.
  async emitCompletion(a) {
    if (
      a.payload.action !== "coding_start" ||
      a.state !== "completed" ||
      // A member's run is reported to the member and the team, not to the
      // parent's own coding.completed routines.
      a.requestedBy ||
      !this.s.assistantRoutines ||
      a.eventEmitted ||
      a.eventSkipped
    )
      return true;
    if (a.eventRetryAt > this.now()) return false;
    try {
      const results = await this.s.assistantRoutines.emit({
        assistantId: a.assistantId,
        kind: "coding.completed",
        eventId: `coding:${a.id}:completed`,
      });
      const skipped = results.filter((r) => r.status === "skipped");
      this.store.patch(a.id, {
        eventEmitted: true,
        eventRetryAt: undefined,
        ...(skipped.length ? { eventSkippedBindings: skipped } : {}),
      });
      return true;
    } catch (error) {
      const reason = permanentReasons[error.status];
      if (reason) {
        this.store.patch(a.id, {
          eventSkipped: { status: error.status, reason },
          eventRetryAt: undefined,
        });
        return true;
      }
      const failures = (a.eventFailures || 0) + 1;
      this.store.patch(a.id, {
        eventFailures: failures,
        eventRetryAt: this.now() + Math.min(1000 * 2 ** failures, maxEventRetryMs),
      });
      return false;
    }
  }
  async close() {
    this.closed = true;
    this.forget.close();
    this.browserUploads.close();
    clearInterval(this.timer);
    this.exec.close();
    this.ssh.close();
    await this.running?.catch(() => {});
  }
}
