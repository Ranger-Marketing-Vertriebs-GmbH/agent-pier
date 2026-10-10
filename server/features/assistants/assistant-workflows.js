import { AssistantAccess, exact } from "./assistant-access.js";
import {
  AssistantActionStore,
  actionTerminal as terminal,
} from "./assistant-action-store.js";
import { AssistantCoding } from "./assistant-coding.js";
import {
  noteCodingRun,
  notifyAction,
  telegramTarget,
} from "./assistant-action-notifications.js";
import { deliverFollowUps, memberActions, memberContext } from "./team-coding.js";
import { decideAudited } from "./approval-audit.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { permanentReasons } from "./native-routines.js";
const maxEventRetryMs = 300000;
export class AssistantWorkflows {
  constructor({ services, autoStart = true, now = Date.now }) {
    this.now = now;
    this.s = services;
    this.a = services.assistants;
    this.access = new AssistantAccess(services);
    this.store = new AssistantActionStore(this.a.store.db);
    this.coding = new AssistantCoding(this);
    if (autoStart) this.start();
  }
  /** Starts advancing open actions; the application starts it after recovery. */
  start() {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  get(id) {
    return this.store.get(id);
  }
  project(a) {
    return Object.fromEntries(
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
        "memberName",
        "diagnostic",
      ]
        .filter((k) => k in a)
        .map((k) => [k, a[k]]),
    );
  }
  list(id) {
    this.a.store.getAssistant(id);
    return {
      actions: this.store
        .list(id)
        .map((a) => ({ ...this.project(a), ...this.liveRun(a) })),
    };
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
  context(inv) {
    inv.assertCurrent();
    const attempt = this.a.ledger.getAttempt(inv.attemptId);
    if (!["pending", "accepted", "running"].includes(attempt.state) || attempt.reviewedAt)
      throw assistantProblem("invalid", 403);
    const req = this.a.ledger.getRequest(attempt.requestId),
      chat = this.a.store.getConversation(req.conversationId);
    const origin = this.a.teams.store.context(req.id);
    if (origin.kind === "team-member") return memberContext(this, chat, attempt, origin);
    this.access.eligible(chat.assistantId);
    if (!["owner", "telegram"].includes(origin.kind) || origin.forwarded)
      throw assistantProblem("invalid", 403);
    return {
      assistantId: chat.assistantId,
      conversationId: chat.id,
      attemptId: attempt.id,
      origin,
    };
  }
  authorize(action) {
    const p = this.access.authorize(
      action.assistantId,
      action.payload.projectId,
      action.payload.pipelineId,
      action.accessRevision,
    );
    if (action.payload.action === "memory_write" && !p.memoryWrite)
      throw assistantProblem("invalid", 403);
    return p;
  }
  invoke(inv, input) {
    return this.a.admit(async () => {
      const ctx = this.context(inv);
      exact(input, [
        "action",
        "projectId",
        "pipelineId",
        "task",
        "baseBranch",
        "query",
        "page",
        "id",
        "title",
        "content",
        "expectedRevision",
        "nodeId",
      ]);
      if (ctx.requestedBy && !memberActions.has(input.action))
        throw assistantProblem("invalid", 403);
      if (input.action === "catalog") {
        const p = this.access.get(ctx.assistantId),
          catalog = this.access.catalog();
        return {
          projects: catalog.projects.filter((x) => p.projectIds.includes(x.id)),
          pipelines: catalog.pipelines.filter((x) => p.pipelineIds.includes(x.id)),
        };
      }
      if (["coding_status", "coding_cancel", "coding_artifacts"].includes(input.action))
        return this.coding.call(
          ctx.assistantId,
          input.id,
          {
            coding_status: "run_get",
            coding_cancel: "run_cancel",
            coding_artifacts: "run_artifacts",
          }[input.action],
          input.nodeId ? { nodeId: input.nodeId } : {},
          ctx.requestedBy,
        );
      if (input.action === "actions") return this.list(ctx.assistantId);
      const p = this.access.authorize(ctx.assistantId, input.projectId, input.pipelineId);
      if (input.action === "memory_search") {
        const result = this.s.memory.list(input.projectId, {
          query: input.query || "",
          page: input.page || 1,
        });
        return {
          ...result,
          items: result.items.map(({ content, ...item }) => ({
            ...item,
            excerpt: Array.from(content).slice(0, 256).join(""),
          })),
        };
      }
      if (input.action === "memory_read")
        return this.s.memory.read(input.projectId, input.id);
      if (!["memory_write", "coding_start"].includes(input.action))
        throw assistantProblem("invalid");
      const payload =
        input.action === "coding_start"
          ? {
              action: input.action,
              projectId: input.projectId,
              pipelineId: textValue(input.pipelineId, 100),
              task: textValue(input.task, 65536),
              ...(input.baseBranch
                ? { baseBranch: textValue(input.baseBranch, 300) }
                : {}),
            }
          : {
              action: input.action,
              projectId: input.projectId,
              title: textValue(input.title, 200),
              content: textValue(input.content, 32768),
              ...(input.id
                ? { id: input.id, expectedRevision: input.expectedRevision }
                : {}),
            };
      if (input.action === "memory_write" && !p.memoryWrite)
        throw assistantProblem("invalid", 403);
      if (
        payload.id &&
        (!Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1)
      )
        throw assistantProblem("invalid");
      inv.assertCurrent();
      const action = this.store.reserve({
        ...ctx,
        payload,
        accessRevision: p.revision,
        key: `${inv.attemptId}:${inv.toolCallId}`,
        // A member's request always waits for the owner, whatever the parent's
        // standing permission says.
        state:
          input.action === "coding_start" && p.autonomous && !ctx.requestedBy
            ? "approved"
            : "awaiting_approval",
        projectName: this.s.memory.project(input.projectId).name,
        ...(input.pipelineId
          ? {
              pipelineName: this.s.pipelineDefinitions.getPipeline(input.pipelineId).name,
            }
          : {}),
      });
      if (action.state === "awaiting_approval") notifyAction(this, action, "approval");
      this.a.changed();
      return this.project(action);
    });
  }
  decide(id, input, origin) {
    return decideAudited(
      this.s.audit,
      {
        origin,
        actionId: id,
        decision: input?.decision,
        revision: input?.revision,
        kind: "action",
        assistantId: () => this.store.get(id).assistantId,
        attribution: () => this.store.get(id),
      },
      () => this.decideOnce(id, input, origin),
    );
  }
  decideOnce(id, input, origin) {
    return this.a.admit(async () => {
      exact(input, ["revision", "decision"]);
      if (!["approve", "decline", "review"].includes(input.decision))
        throw assistantProblem("invalid");
      const action = this.store.get(id);
      if (input.decision === "review" && origin.kind !== "owner")
        throw assistantProblem("invalid", 403);
      const target = telegramTarget(action);
      if (
        origin.kind !== "owner" &&
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
      this.a.changed();
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
    this.a.changed();
    return next;
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
    this.a.changed();
  }
  tick() {
    if (this.closed || this.a.maintenance) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.advance().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async advance() {
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
    this.a.changed();
  }
  async advanceAction(a) {
    if (a.state === "awaiting_approval") {
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
              state: error.status === 400 ? "failed" : "unknown",
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
          state:
            a.payload.action === "coding_start" && this.coding.receipt(a)
              ? "unknown"
              : [400, 403, 404, 409].includes(error.status)
                ? "failed"
                : "unknown",
        });
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
        delivered = await deliverFollowUps(this, a);
      if (emitted && delivered) this.store.patch(a.id, { settled: true });
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
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
