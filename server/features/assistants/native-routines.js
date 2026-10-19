import { isDeepStrictEqual } from "node:util";
import { NativeReminders, exact, schedule, updateInput } from "./native-reminders.js";
import { RoutineEvents } from "./routine-events.js";
import { routineTools } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
export const permanentReasons = {
  400: "INVALID",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};
// A run's session (`agent:<agent>:cron:<job>`, per run `…:run:<id>`).
const runSession = /^agent:([^:]+):cron:([^:]+)(?::run:[^:]+)?$/i;
// Run settings, also the target existing jobs are brought to (reconcile).
export const routineTimeoutSeconds = 300;
const destination = (delivery) => delivery?.completionDestination?.to ?? delivery?.to;
// Compared field by field: OpenClaw may add its own payload fields.
const current = (job, want) =>
  job.sessionTarget === want.sessionTarget &&
  (want.sessionTarget !== "current" || job.sessionKey === want.sessionKey) &&
  Object.entries(want.payload).every(([key, value]) =>
    isDeepStrictEqual(job.payload?.[key], value),
  ) &&
  job.delivery?.mode === want.delivery.mode &&
  destination(job.delivery) === destination(want.delivery);

/**
 * Routines: one native cron job per saved prompt. A run has the agent's own chat
 * tools (routineTools, intersected by OpenClaw with the agent's tools.allow) and
 * full context. It runs detached from the agent's main chat, so a live turn is
 * never disturbed, and OpenClaw commits its result into that conversation once no
 * turn runs there: the chat shows it and a later turn can refer to it. The
 * completion webhook records it for the chat's badge, sends a push notice and, when
 * the routine has Telegram switched on, sends it to the paired chat too.
 */
export class NativeRoutines extends NativeReminders {
  constructor({ reminders }) {
    super({
      assistants: reminders.assistants,
      channels: reminders.channels,
      shared: reminders,
    });
    this.kind = "routine";
    this.receipts = new RoutineEvents(this.assistants.store.db);
    reminders.routines = this;
  }
  values(input, old) {
    exact(input, [
      "clientRequestId",
      "name",
      "prompt",
      "trigger",
      "channelId",
      "telegram",
    ]);
    textValue(input.prompt, 8192);
    let trigger;
    if (input.trigger?.kind === "event") {
      exact(input.trigger, ["kind", "eventKind"]);
      const eventKind = input.trigger.eventKind || "manual";
      if (!["manual", "coding.completed"].includes(eventKind))
        throw assistantProblem("invalid");
      trigger = { kind: "event", eventKind };
    } else trigger = schedule(input.trigger, !!old);
    return {
      name: input.name,
      prompt: input.prompt,
      trigger,
      schedule:
        trigger.kind === "event"
          ? { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" }
          : trigger,
    };
  }
  payload(values) {
    return [
      `This is the scheduled AgentPier routine ${JSON.stringify(values.name)}, not a message from the owner.`,
      "Carry out its saved task below and reply with the result for the owner.",
      "",
      values.prompt,
    ].join("\n");
  }
  /** A run reads the agent's main chat and commits into it (create opens it). */
  run(binding, values, to) {
    const sessionKey = this.conversation(binding)?.runtimeSessionKey;
    if (!sessionKey) throw assistantProblem("unavailable", 503);
    return {
      sessionTarget: "current",
      sessionKey,
      payload: {
        kind: "agentTurn",
        message: this.payload(values),
        timeoutSeconds: routineTimeoutSeconds,
        lightContext: false,
        toolsAllow: [...routineTools],
      },
      // Announce is the commit into the conversation (no channels are configured);
      // the completion webhook hands the result to AgentPier.
      delivery: { mode: "announce", completionDestination: { mode: "webhook", to } },
    };
  }
  nativeEnabled(values) {
    return values.trigger.kind !== "event";
  }
  project(binding, job) {
    binding = this.bindings.get(binding.id);
    const projected = super.project(binding, job);
    return {
      ...projected,
      status: binding.routineUpdateUnknown ? "unknown" : projected.status,
      lastEvent: this.receipts.latest(binding.id),
      prompt: binding.definition?.prompt || "",
      trigger: binding.definition?.trigger || null,
      enabled:
        projected.status === "ready" &&
        binding.routineEnabled !== false &&
        (binding.definition?.trigger.kind === "event" || projected.enabled),
      revision: binding.routineRevision || 1,
      // The owner lets this routine write: project folders and delegated tasks.
      writes: binding.routineWrites === true,
    };
  }
  /**
   * The owner's switch "May write": the routine's run may change files in its
   * project folders (workspace-calls.js), and the tasks it delegates count as the
   * owner's standing instruction and may change files.
   * Never reachable from the agent's own routine tool; audited.
   */
  setWrites(binding, input) {
    if ((binding.routineWrites === true) === input.writes) return;
    this.bindings.patch(binding.id, { routineWrites: input.writes });
    try {
      this.assistants.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: binding.assistantId,
        source: "user",
        outcome: "success",
        details: {
          kind: "routine-writes",
          routineId: binding.id,
          writes: input.writes,
        },
      });
    } catch (error) {
      console.error("Routine audit failed:", error?.message);
    }
  }
  async list(id) {
    const { reminders } = await super.list(id);
    return { routines: reminders };
  }
  update(id, bindingId, input, assertCurrent = () => {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      updateInput(input, { routine: true });
      const agent = this.agent(id, input.enabled === true),
        binding = this.owned(id, bindingId);
      if (["removed", "revoked"].includes(binding.state))
        throw assistantProblem("notFound", 404);
      if ((binding.routineRevision || 1) !== input.revision)
        throw assistantProblem("conflict", 409);
      const job = this.find(binding, await this.jobs(agent));
      if (!job) throw assistantProblem("unavailable", 503);
      assertCurrent();
      if (input.telegram !== undefined) this.setTelegram(binding, input.telegram);
      if (input.writes !== undefined) this.setWrites(binding, input);
      if (input.enabled === undefined) {
        this.bindings.patch(bindingId, { routineRevision: input.revision + 1 });
        this.assistants.changed();
        return this.project(binding, job);
      }
      // Pausing revokes delivery before the RPC, including on an uncertain response.
      if (!input.enabled) this.bindings.patch(bindingId, { routineEnabled: false });
      this.bindings.patch(bindingId, { routineUpdateUnknown: true });
      const updated = await this.assistants.runtime.client.call("cron.update", {
        id: job.id,
        patch: { enabled: input.enabled && binding.definition.trigger.kind !== "event" },
      });
      this.bindings.patch(bindingId, {
        routineUpdateUnknown: false,
        routineEnabled: input.enabled,
        routineRevision: input.revision + 1,
      });
      this.assistants.changed();
      return this.project(binding, updated);
    });
  }
  trigger(id, bindingId, input) {
    return this.assistants.admit(async () => {
      exact(input, ["eventId"]);
      textValue(input.eventId, 512);
      const agent = this.agent(id, true),
        binding = this.owned(id, bindingId);
      if (
        ["removed", "revoked"].includes(binding.state) ||
        binding.definition?.trigger.kind !== "event"
      )
        throw assistantProblem("invalid", 409);
      const old = this.receipts.get(bindingId, input.eventId);
      if (old) return old;
      if (binding.routineEnabled === false) throw assistantProblem("active", 409);
      const job = this.find(binding, await this.jobs(agent));
      // A listed scheduler without this job will not grow it back; retrying is futile.
      if (!job) throw assistantProblem("notFound", 404);
      if (job.enabled) throw assistantProblem("unavailable", 503);
      await this.assistants.config.apply(id);
      this.agent(id, true);
      const { receipt, fresh } = this.receipts.reserve(bindingId, input.eventId);
      if (!fresh) return receipt;
      try {
        const result = await this.assistants.runtime.client.call("cron.run", {
          id: job.id,
          mode: "force",
        });
        return this.receipts.write(bindingId, {
          eventId: input.eventId,
          status:
            result?.enqueued === true
              ? "queued"
              : result?.ran === false
                ? "rejected"
                : "unknown",
        });
      } catch {
        return receipt;
      } finally {
        this.assistants.changed();
      }
    });
  }
  async emit({ assistantId, kind, eventId }) {
    if (kind !== "coding.completed") throw assistantProblem("invalid");
    textValue(eventId, 512);
    const bindings = this.bindings
      .list(assistantId)
      .filter(
        (b) =>
          b.kind === "routine" &&
          b.state === "bound" &&
          b.routineEnabled !== false &&
          b.definition?.trigger.eventKind === kind,
      );
    const settled = await Promise.allSettled(
      bindings.map((binding) =>
        this.trigger(assistantId, binding.id, { eventId: `${kind}:${eventId}` }),
      ),
    );
    // Receipts make a repeated emission idempotent, so any transient failure is
    // retried as a whole; permanent rejections are reported, never retried.
    const transient = settled.find(
      (r) => r.status === "rejected" && !permanentReasons[r.reason?.status],
    );
    if (transient) throw transient.reason;
    return settled.map((r, n) =>
      r.status === "fulfilled"
        ? { id: bindings[n].id, ...r.value }
        : {
            id: bindings[n].id,
            status: "skipped",
            reason: permanentReasons[r.reason.status],
          },
    );
  }
  invoke(invocation, input) {
    invocation.assertCurrent();
    exact(input, ["action", "name", "prompt", "trigger", "id", "enabled", "revision"]);
    const request = this.assistants.ledger.getRequest(
      this.assistants.ledger.getAttempt(invocation.attemptId).requestId,
    );
    const conversation = this.assistants.store.getConversation(request.conversationId);
    const origin = this.assistants.teams.store.context(request.id);
    if (!["owner", "telegram"].includes(origin.kind) || origin.forwarded)
      throw assistantProblem("invalid", 403);
    const id = conversation.assistantId;
    this.agent(id, true);
    if (input.action === "list") return this.list(id);
    if (input.action === "create")
      return this.create(
        id,
        {
          clientRequestId: `${invocation.attemptId}:${invocation.toolCallId}`,
          name: input.name,
          prompt: input.prompt,
          trigger: input.trigger,
        },
        origin,
        invocation.assertCurrent,
      );
    if (input.action === "update")
      return this.update(
        id,
        input.id,
        { enabled: input.enabled, revision: input.revision },
        invocation.assertCurrent,
      );
    if (input.action === "remove")
      return this.remove(id, input.id, invocation.assertCurrent);
    throw assistantProblem("invalid");
  }
  /**
   * Brings the agent's routine jobs to the current run settings: jobs created
   * before tools and the chat commit, or before the main chat changed, are updated
   * in place (each binding keeps its target). Callers hold admission; a job that is
   * not listed is left to its binding.
   */
  async sync(id) {
    const routines = this.bindings
      .list(id)
      .filter((b) => b.kind === "routine" && b.state === "bound" && b.definition);
    if (!routines.length) return;
    const jobs = await this.jobs(this.agent(id));
    const connection = await this.start();
    const conversation = await this.openMain(id);
    const target = {
      conversationId: conversation.id,
      sessionKey: conversation.runtimeSessionKey,
    };
    let changed = false;
    for (const binding of routines) {
      if (!isDeepStrictEqual(binding.target, target))
        this.bindings.patch(binding.id, { target });
      const job = this.find(binding, jobs);
      if (!job) continue;
      const want = this.run(
        binding,
        binding.definition,
        `${connection.url}/complete/${binding.id}`,
      );
      if (current(job, want)) continue;
      await this.assistants.runtime.client.call("cron.update", {
        id: job.id,
        patch: want,
      });
      changed = true;
    }
    if (changed) this.assistants.changed();
  }
  /** One agent outside any admission, after its chats changed; never retires a job. */
  resync(id) {
    return this.assistants.admit(async () => {
      if (this.assistants.runtime.client?.ready) await this.sync(id);
    });
  }
  /** Every agent with routines, outside any admission (Gateway ready, upgrade). */
  reconcile() {
    return this.assistants.admit(async () => {
      if (!this.assistants.runtime.client?.ready) return;
      for (const agent of this.assistants.store.listAssistants()) {
        if (agent.archivedAt) continue;
        if (!this.bindings.list(agent.id).some((b) => b.kind === "routine")) continue;
        await this.sync(agent.id).catch(() => {});
      }
    });
  }
  /** A run session's refusal (agent-ssh.js), shown with that run's result. */
  noteRefusal(sessionKey, note) {
    const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
    if (!match) return;
    const key = match[2].toLowerCase();
    // The latest time counts: a stale note from an earlier run must not hide it.
    this.refusals.set(key, new Map(this.refusals.get(key)).set(note, Date.now()));
  }
  /**
   * The routine a native run session belongs to, with the conversation its result
   * goes to; null for any other session. Exec approvals of a run are shown there.
   */
  runOrigin(assistant, sessionKey) {
    const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
    if (!match || match[1].toLowerCase() !== assistant.runtimeAgentId?.toLowerCase())
      return null;
    const binding = this.bindings
      .list(assistant.id)
      .find(
        (b) =>
          b.kind === "routine" &&
          b.state === "bound" &&
          b.routineEnabled !== false &&
          b.nativeId?.toLowerCase() === match[2].toLowerCase(),
      );
    const conversation = binding && this.conversation(binding);
    return conversation ? { binding, conversation } : null;
  }
}
