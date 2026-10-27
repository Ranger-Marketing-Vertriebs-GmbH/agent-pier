import { createHash } from "node:crypto";
import { AgentApprovalEvents } from "./agent-approval-events.js";
import { replyPreview, requestNotice, runNotice, sessionNotice } from "./push-notices.js";

// The audited action of each status that ends a pipeline run.
const pipelineEnded = {
  completed: "pipeline.completed",
  failed: "pipeline.failed",
  cancelled: "pipeline.cancelled",
};

// Pushed events that start a model turn, whatever the poll reads afterwards.
const turnStarts = new Set(["UserPromptSubmit", "turn/started"]);

// How long a request of a session an agent controls waits for the agent before it
// notifies the owner anyway.
export const agentRequestHoldMs = 15 * 60 * 1000;

/** Observe durable metadata and native activity without attaching a terminal client. */
export class OperationsEvents {
  constructor(options) {
    // The services, read late: agents' coding sessions learn who answered a prompt.
    this.host = options;
    this.init(options);
    // Agents' approvals and team proposals, for the agent-approval push.
    this.agentApprovals = new AgentApprovalEvents({
      services: options,
      notifications: this.notifications,
      onError: this.onError,
    });
  }
  init({
    audit,
    notifications,
    sessions,
    activity,
    pipelines,
    intervalMs = 2500,
    // A reported wait must last this long before it notifies, so an AgentPier
    // request for the same wait (a Codex approval) arrives first and wins.
    waitingGraceMs = 3000,
    now = Date.now,
    onError = () => {},
    requests = null,
    chat = null,
  }) {
    Object.assign(this, {
      requests,
      chat,
      audit,
      notifications,
      sessions,
      activity,
      pipelines,
      onError,
      waitingGraceMs,
      now,
    });
    // When each session last sent an approval or question push.
    this.requested = new Map();
    // Each session's current wait: when it began and whether it was handled.
    this.waits = new Map();
    // Request pushes held while an agent controls their session, by request ID.
    // Held only in memory: a restart forgets them (the broker does not re-announce).
    this.held = new Map();
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
    if (event.action === "request.created")
      this.requested.set(event.sessionId, this.now());
    if (event.action === "request.created")
      this.requestCreated(event).catch(this.onError);
    // An answered, handed-off or expired request no longer needs its held push.
    if (
      ["request.answered", "request.handed-off", "request.expired"].includes(
        event.action,
      ) &&
      event.outcome === "success"
    )
      this.held.delete(event.resourceId);
    if (event.action === "request.answered" || event.action === "request.handed-off")
      try {
        this.host.assistants?.workflows?.sessions?.requestEvent(event);
      } catch (error) {
        this.onError(error);
      }
  }
  /** Whether an agent controls the session now (its pushes are the agent's first). */
  controlled(sessionId) {
    try {
      return !!this.host.assistants?.workflows?.sessions?.controls?.(sessionId);
    } catch (error) {
      this.onError(error);
      return false;
    }
  }
  /**
   * A native question or approval. A session an agent controls holds the push until
   * the agent escalates it (releaseRequest), control ends or agentRequestHoldMs pass.
   */
  async requestCreated(event) {
    if (this.controlled(event.sessionId)) {
      this.held.set(event.resourceId, { event, since: this.now() });
      return;
    }
    await this.notifyRequest(event);
  }
  /** Notify a held request now with its stored event, then forget it. */
  async releaseRequest(requestId) {
    const held = this.held.get(requestId);
    if (!held) return;
    this.held.delete(requestId);
    await this.notifyRequest(held.event);
  }
  /** Release each held request whose session left agent control or whose hold ran out. */
  async releaseHeld() {
    const now = this.now();
    for (const [id, { event, since }] of [...this.held])
      if (now - since >= agentRequestHoldMs || !this.controlled(event.sessionId))
        await this.releaseRequest(id).catch(this.onError);
  }
  /** A request's push: its session, and the question as a preview. */
  async notifyRequest(event) {
    const session = await Promise.resolve(this.sessions.get?.(event.sessionId)).catch(
      () => null,
    );
    const entry = this.requests?.listAll?.().find((e) => e.id === event.resourceId);
    await this.notifications.notify({
      kind: event.kind,
      eventId: event.resourceId,
      ...requestNotice(event, session, entry),
    });
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
  /**
   * A CLI pushed an activity report (hooks, Codex proxy, OpenCode plugin). A started
   * turn is remembered at once, so a turn that ends before the next poll still
   * notifies as finished, and the push is checked now instead of at the next interval.
   */
  nativeActivity(sessionId, event) {
    if (this.closed || typeof sessionId !== "string") return;
    try {
      if (turnStarts.has(event) && this.notifications.deviceCount?.() > 0)
        this.transition(`activity:${sessionId}`, "working");
    } catch (error) {
      this.onError(error);
    }
    // One more poll after the running one, however many pushes arrive meanwhile.
    if (this.again) return;
    this.again = Promise.resolve(this.pending)
      .catch(() => {})
      .then(() => {
        this.again = null;
        return this.poll();
      })
      .catch(this.onError);
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
    const sessions = await this.sessions.list();
    const running = new Set(
      sessions.filter((session) => session.status === "running").map(({ id }) => id),
    );
    for (const map of [this.requested, this.waits])
      for (const id of map.keys()) if (!running.has(id)) map.delete(id);
    // A held request of a session that stopped can no longer be answered.
    for (const [id, { event }] of this.held)
      if (!running.has(event.sessionId)) this.held.delete(id);
    if (this.held.size) await this.releaseHeld();
    for (const session of sessions) {
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
          eventId: change.eventId,
          ...sessionNotice(session),
        });
      }
      if (session.status !== "running") continue;
      if (!enabled) {
        // Without devices nothing notifies; only a remembered request needs the
        // reading, to forget it once its session no longer waits.
        if (
          this.requested.has(session.id) &&
          (await this.activity.read(session)).state !== "waiting"
        )
          this.requested.delete(session.id);
        continue;
      }
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
        // An agent's session wakes the agent instead (session-wakes.js).
        if (!this.controlled(session.id))
          await this.notifications.notify({
            kind: "session-completed",
            eventId: activity.eventId,
            ...sessionNotice(session),
            // Read only when a device shows previews.
            preview: () => replyPreview(this.chat, session),
          });
      }
    }
    for (const run of this.pipelines.store.all()) this.pipeline(run);
    await this.agentApprovals.poll();
  }
  /** A CLI reported that it waits for the owner, outside AgentPier's own requests. */
  async waiting(session, state, source) {
    const waiting = state === "waiting";
    const change = this.transition(`waiting:${session.id}`, waiting);
    if (!waiting) {
      this.waits.delete(session.id);
      this.requested.delete(session.id);
      return;
    }
    const now = this.now();
    let wait = this.waits.get(session.id);
    // A wait already under way when AgentPier (re)started never notifies late.
    if (change.changed || !wait)
      this.waits.set(
        session.id,
        (wait = { since: now, eventId: change.eventId, done: !change.changed }),
      );
    // Only a reported wait counts: a terminal dialog the owner opened (a model
    // picker) is no reason to notify, and AgentPier's requests notify on their own.
    if (wait.done || source !== "hook" || now - wait.since < this.waitingGraceMs) return;
    wait.done = true;
    if (this.requested.get(session.id) >= wait.since - this.waitingGraceMs) return;
    // An agent's session wakes the agent instead (session-wakes.js).
    if (this.controlled(session.id)) return;
    await this.notifications.notify({
      kind: "session-waiting",
      eventId: wait.eventId,
      ...sessionNotice(session),
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
    // A cancelled run was stopped on purpose; it notifies nobody.
    if (run.status === "cancelled") return;
    this.notifications
      .notify({
        kind: ended ? `pipeline-${run.status}` : "pipeline-gate",
        eventId: change.eventId,
        ...runNotice(run, !ended),
      })
      .catch(this.onError);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.again;
    await this.pending;
  }
}
