import { createHash } from "node:crypto";

// The audited action of each status that ends a pipeline run.
const pipelineEnded = {
  completed: "pipeline.completed",
  failed: "pipeline.failed",
  cancelled: "pipeline.cancelled",
};

/** Observe durable metadata and native activity without attaching a terminal client. */
export class OperationsEvents {
  constructor({
    audit,
    notifications,
    sessions,
    activity,
    pipelines,
    intervalMs = 2500,
    onError = () => {},
  }) {
    Object.assign(this, { audit, notifications, sessions, activity, pipelines, onError });
    // Sessions whose current wait already sent an approval or question push.
    this.requested = new Set();
    if (intervalMs > 0) {
      this.timer = setInterval(() => this.poll().catch(onError), intervalMs);
      this.timer.unref();
    }
  }
  emit(event) {
    try {
      this.audit.append(event);
    } catch (error) {
      this.onError(error);
    }
    if (event.action === "request.created") this.requested.add(event.sessionId);
    if (event.action === "request.created")
      this.notifications
        .notify({
          kind: event.kind,
          sessionId: event.sessionId,
          eventId: event.resourceId,
        })
        .catch(this.onError);
  }
  transition(key, value) {
    const stored = this.notifications.observation(key);
    const previous = stored ? JSON.parse(stored) : null;
    const next = {
      value,
      sequence: (previous?.sequence || 0) + (previous?.value === value ? 0 : 1),
    };
    this.notifications.observe(key, JSON.stringify(next));
    return {
      changed: previous !== null && previous.value !== value,
      previous: previous?.value,
      eventId: createHash("sha256").update(`${key}:${next.sequence}`).digest("hex"),
    };
  }
  async poll() {
    if (this.pending || this.closed) return this.pending;
    this.pending = this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async collect() {
    const enabled = this.notifications.status().subscriptions.length > 0;
    for (const session of await this.sessions.list()) {
      if (
        session.imported?.historyOnly ||
        session.purpose === "login" ||
        session.tool === "shell"
      )
        continue;
      const change = this.transition(`session:${session.id}`, session.status);
      if (change.changed && session.status === "stopped") {
        this.emit({
          action: "session.ended",
          resourceType: "session",
          resourceId: session.id,
          sessionId: session.id,
          source: "system",
          outcome: "success",
          details: { tool: session.tool },
        });
        await this.notifications.notify({
          kind: "session-ended",
          sessionId: session.id,
          eventId: change.eventId,
        });
      }
      if (!enabled || session.status !== "running") continue;
      const { state, source } = await this.activity.read(session);
      await this.waiting(session, state, source);
      if (!["working", "idle"].includes(state)) continue;
      const activity = this.transition(`activity:${session.id}`, state);
      if (activity.changed && activity.previous === "working" && state === "idle") {
        this.emit({
          action: "session.completed",
          resourceType: "session",
          resourceId: session.id,
          sessionId: session.id,
          source: "system",
          outcome: "success",
          details: { kind: "completion", tool: session.tool },
        });
        await this.notifications.notify({
          kind: "session-completed",
          sessionId: session.id,
          eventId: activity.eventId,
        });
      }
    }
    for (const run of this.pipelines.store.all()) this.pipeline(run);
  }
  /** A CLI reported that it waits for the owner, outside AgentPier's own requests. */
  async waiting(session, state, source) {
    const waiting = state === "waiting";
    const change = this.transition(`waiting:${session.id}`, waiting);
    if (!waiting) {
      this.requested.delete(session.id);
      return;
    }
    // Only a reported wait counts: a terminal dialog the owner opened (a model
    // picker) is no reason to notify, and AgentPier's requests notify on their own.
    if (!change.changed || source !== "hook" || this.requested.has(session.id)) return;
    await this.notifications.notify({
      kind: "session-waiting",
      sessionId: session.id,
      eventId: change.eventId,
    });
  }
  pipeline(run) {
    try {
      this.observePipeline(run);
    } catch (error) {
      this.onError(error);
    }
  }
  observePipeline(run) {
    if (this.closed || run.imported?.historyOnly) return;
    const node = run.nodes?.find((node) => node.id === run.currentNodeId);
    const value = JSON.stringify([
      run.status,
      run.currentNodeId,
      run.currentAttemptId,
      node?.failReason,
      node?.gateDecision,
    ]);
    const change = this.transition(`pipeline:${run.id}`, value);
    if (!change.changed) return;
    const ended = Object.hasOwn(pipelineEnded, run.status);
    if (!ended && run.status !== "awaiting-human") return;
    this.emit({
      action: ended ? pipelineEnded[run.status] : "pipeline.updated",
      resourceType: "pipeline",
      resourceId: run.id,
      ...(run.projectId ? { projectId: run.projectId } : {}),
      source: "system",
      outcome: run.status === "failed" ? "failure" : "success",
      details: { kind: ended ? "completion" : "gate" },
    });
    this.notifications
      .notify({
        kind: ended ? "pipeline-ended" : "pipeline-gate",
        runId: run.id,
        eventId: change.eventId,
      })
      .catch(this.onError);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }
}
