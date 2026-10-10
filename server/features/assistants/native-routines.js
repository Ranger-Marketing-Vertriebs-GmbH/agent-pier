import { NativeReminders, exact, schedule } from "./native-reminders.js";
import { RoutineEvents } from "./routine-events.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
export const permanentReasons = {
  400: "INVALID",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
};
export class NativeRoutines extends NativeReminders {
  constructor({ reminders }) {
    super({
      assistants: reminders.assistants,
      channels: reminders.channels,
      shared: reminders,
    });
    this.kind = "routine";
    this.receipts = new RoutineEvents(this.assistants.store.db);
  }
  values(input, old) {
    exact(input, ["clientRequestId", "name", "prompt", "trigger", "channelId"]);
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
    return values.prompt;
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
    };
  }
  async list(id) {
    const { reminders } = await super.list(id);
    return { routines: reminders };
  }
  update(id, bindingId, input, assertCurrent = () => {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      exact(input, ["enabled", "revision"]);
      if (typeof input.enabled !== "boolean") throw assistantProblem("invalid");
      const agent = this.agent(id, input.enabled),
        binding = this.owned(id, bindingId);
      if (["removed", "revoked"].includes(binding.state))
        throw assistantProblem("notFound", 404);
      if ((binding.routineRevision || 1) !== input.revision)
        throw assistantProblem("conflict", 409);
      const job = this.find(binding, await this.jobs(agent));
      if (!job) throw assistantProblem("unavailable", 503);
      if (input.enabled)
        this.source(id, binding.source.channelId, {
          kind: "telegram",
          ...binding.source,
        });
      assertCurrent();
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
      this.source(id, binding.source.channelId, { kind: "telegram", ...binding.source });
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
}
