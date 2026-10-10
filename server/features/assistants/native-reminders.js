import { ReminderBindings } from "./reminder-bindings.js";
import { ReminderWebhook } from "./reminder-webhook.js";
import { personalCapabilities } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";
const declaration = (binding) => `agentpier-reminder:${binding.id}`;
const revoked = (binding) => ["revoked", "removed"].includes(binding.state);
// Creation was submitted but never confirmed; only an owner review resolves it.
const unconfirmed = (binding) => ["pending", "unknown"].includes(binding.state);
// One-shot times must carry an explicit offset; a bare local time would be read
// in the server's time zone, which may differ from the user's.
const offsetTimestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
export const exact = (input, keys) => {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
};
export function schedule(input, allowPast = false) {
  exact(input, input?.kind === "at" ? ["kind", "at"] : ["kind", "expr", "tz"]);
  if (input.kind === "at") {
    if (typeof input.at !== "string" || !offsetTimestamp.test(input.at))
      throw assistantProblem("reminderTimezoneRequired");
    const at = Date.parse(input.at);
    if (!Number.isFinite(at) || (!allowPast && at <= Date.now()))
      throw assistantProblem("invalid");
    return { kind: "at", at: new Date(at).toISOString() };
  }
  if (input.kind !== "cron") throw assistantProblem("invalid");
  textValue(input.expr, 100);
  textValue(input.tz, 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.tz });
  } catch {
    throw assistantProblem("invalid");
  }
  return { kind: "cron", expr: input.expr, tz: input.tz };
}
export class NativeReminders {
  constructor({ assistants, channels, dataDir, shared }) {
    Object.assign(this, { assistants, channels });
    this.kind = "reminder";
    this.bindings = shared?.bindings || new ReminderBindings(assistants.store.db);
    // Bindings whose cron.add is in flight; their outcome is not yet unknown.
    this.creating = shared?.creating || new Set();
    this.webhook =
      shared?.webhook ||
      new ReminderWebhook({
        dataDir,
        receive: (id, event) => this.complete(id, event),
      });
  }
  start() {
    return this.webhook.start();
  }
  close() {
    return this.webhook.close();
  }
  agent(id, enabled = false) {
    const a = this.assistants.store.getAssistant(id);
    if (
      a.archivedAt ||
      (a.teamMemberId && a.lifetime !== "permanent") ||
      (enabled && !personalCapabilities(a).reminders)
    )
      throw assistantProblem("invalid", 403);
    this.assistants.requireReady();
    return a;
  }
  async jobs(agent) {
    const jobs = [];
    let offset = 0;
    do {
      const page = await this.assistants.runtime.client.call("cron.list", {
        agentId: agent.runtimeAgentId,
        includeDisabled: true,
        limit: 200,
        offset,
      });
      if (!Array.isArray(page.jobs)) throw assistantProblem("unavailable", 503);
      jobs.push(...page.jobs);
      if (!page.hasMore) return jobs;
      if (!(page.nextOffset > offset) || jobs.length >= 10000)
        throw assistantProblem("unavailable", 503);
      offset = page.nextOffset;
    } while (true);
  }
  find(binding, jobs) {
    binding = this.bindings.get(binding.id);
    const job = jobs.find((j) => j.declarationKey === declaration(binding));
    if (job && binding.nativeId !== job.id)
      this.bindings.patch(binding.id, {
        nativeId: job.id,
        state: revoked(binding) ? binding.state : "bound",
      });
    return job;
  }
  project(binding, job) {
    const delivery = this.channels.outbox
      .all(binding.source.channelId)
      .filter((e) => e.source.reminderBindingId === binding.id)
      .at(-1);
    return {
      id: binding.id,
      name: job?.name || "",
      enabled: job?.enabled === true && binding.deliveryEnabled !== false,
      status:
        binding.state === "removed"
          ? "removed"
          : binding.state === "revoked" || binding.reminderUpdateUnknown
            ? "unknown"
            : job
              ? "ready"
              : binding.state === "rejected"
                ? "failed"
                : "unknown",
      revision: job?.updatedAtMs ?? null,
      schedule:
        job?.schedule?.kind === "at"
          ? { kind: "at", at: job.schedule.at }
          : job?.schedule?.kind === "cron"
            ? { kind: "cron", expr: job.schedule.expr, tz: job.schedule.tz }
            : null,
      nextRunAtMs: job?.state?.nextRunAtMs ?? null,
      lastRunStatus: job?.state?.lastRunStatus ?? null,
      lastDeliveryStatus: job?.state?.lastDeliveryStatus ?? null,
      deliveryState: delivery?.state || null,
      reviewRequired: !job && unconfirmed(binding) && !this.creating.has(binding.id),
    };
  }
  list(id) {
    return this.assistants.admit(async () => {
      const agent = this.agent(id),
        jobs = await this.jobs(agent);
      return {
        reminders: this.bindings
          .list(id)
          .filter((b) => b.state !== "removed" && (b.kind || "reminder") === this.kind)
          .map((b) => this.project(b, this.find(b, jobs))),
      };
    });
  }
  source(id, channelId, origin) {
    const channel =
      origin?.kind === "telegram"
        ? this.channels.store.get(origin.channelId)
        : channelId
          ? this.channels.store.get(channelId)
          : this.channels.store
              .list()
              .find((c) => c.assistantId === id && c.enabled && c.chatId);
    if (!channel || channel.assistantId !== id || !channel.enabled || !channel.chatId)
      throw assistantProblem("reminderChannelRequired", 409);
    if (
      origin?.kind === "telegram" &&
      ["chatId", "userId"].some((k) => channel[k] !== origin[k])
    )
      throw assistantProblem("invalid", 403);
    return {
      assistantId: id,
      channelId: channel.id,
      chatId: channel.chatId,
      userId: channel.userId,
    };
  }
  values(input, old) {
    exact(input, ["clientRequestId", "name", "message", "schedule", "channelId"]);
    textValue(input.message, 8192);
    return {
      name: input.name,
      message: input.message,
      schedule: schedule(input.schedule, !!old),
    };
  }
  payload(values) {
    return `Deliver this reminder by returning its text verbatim. Do not use tools.\n\n${values.message}`;
  }
  nativeEnabled() {
    return true;
  }
  create(id, input, origin, assertCurrent = () => {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      textValue(input?.clientRequestId, 768);
      textValue(input.name, 100);
      const agent = this.agent(id, true);
      const source = this.source(id, input.channelId, origin);
      const old = this.bindings.list(id).find((b) => b.key === input.clientRequestId);
      // Replay lookup precedes due-time validation: an acknowledged one-shot may
      // already be in the past when the caller recovers its creation result.
      const values = this.values(input, old);
      const { binding, fresh } = this.bindings.reserve(
        id,
        input.clientRequestId,
        source,
        values,
        { kind: this.kind, definition: values, routineEnabled: true },
      );
      if (!fresh && binding.state !== "prepared") {
        if (binding.state === "removed") return this.project(binding);
        if (binding.state === "rejected") throw assistantProblem("invalid");
        const job = this.find(binding, await this.jobs(agent));
        if (job || !unconfirmed(binding)) return this.project(binding, job);
        // The earlier submission may still surface; resubmitting could duplicate it.
        throw Object.assign(
          assistantProblem(
            this.kind === "routine" ? "routineReviewRequired" : "reminderReviewRequired",
            409,
          ),
          { code: "REVIEW_REQUIRED" },
        );
      }
      await this.assistants.config.apply(id);
      const connection = await this.start();
      assertCurrent();
      this.agent(id, true);
      this.bindings.patch(binding.id, { state: "pending" });
      this.creating.add(binding.id);
      try {
        const result = await this.assistants.runtime.client.call("cron.add", {
          name: values.name,
          declarationKey: declaration(binding),
          agentId: agent.runtimeAgentId,
          enabled: this.nativeEnabled(values),
          deleteAfterRun: false,
          schedule: values.schedule,
          sessionTarget: "isolated",
          wakeMode: "now",
          failureAlert: false,
          payload: {
            kind: "agentTurn",
            message: this.payload(values),
            timeoutSeconds: 90,
            lightContext: true,
            toolsAllow: [],
          },
          delivery: { mode: "webhook", to: `${connection.url}/complete/${binding.id}` },
        });
        const job = result?.job || result;
        if (!job?.id) throw assistantProblem("unavailable", 503);
        this.bindings.patch(binding.id, { nativeId: job.id, state: "bound" });
        this.assistants.changed();
        return this.project(binding, job);
      } catch (error) {
        this.bindings.patch(binding.id, {
          state: error.code === "INVALID_REQUEST" ? "rejected" : "unknown",
        });
        throw assistantProblem(
          error.code === "INVALID_REQUEST" ? "invalid" : "unavailable",
          error.code === "INVALID_REQUEST" ? 400 : 503,
        );
      } finally {
        this.creating.delete(binding.id);
      }
    });
  }
  owned(id, bindingId) {
    this.agent(id);
    const binding = this.bindings.get(bindingId);
    if (binding.assistantId !== id || (binding.kind || "reminder") !== this.kind)
      throw assistantProblem("notFound", 404);
    return binding;
  }
  // The owner acknowledges an unconfirmed creation. A job that reached the
  // runtime is adopted; otherwise the binding is closed and never resubmitted.
  review(id, bindingId, input) {
    return this.assistants.admit(async () => {
      exact(input, ["acknowledgeUnknownOutcome"]);
      if (input.acknowledgeUnknownOutcome !== true) throw assistantProblem("invalid");
      const binding = this.owned(id, bindingId);
      if (!unconfirmed(binding) || this.creating.has(binding.id))
        throw assistantProblem("conflict", 409);
      const job = this.find(binding, await this.jobs(this.agent(id)));
      const reviewed = job
        ? this.bindings.get(binding.id)
        : this.bindings.patch(binding.id, {
            state: "removed",
            reviewedAt: new Date().toISOString(),
          });
      this.assistants.changed();
      return this.project(reviewed, job);
    });
  }
  update(id, bindingId, input, assertCurrent = () => {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      exact(input, ["enabled", "revision"]);
      if (typeof input.enabled !== "boolean") throw assistantProblem("invalid");
      const agent = this.agent(id, input.enabled),
        binding = this.owned(id, bindingId);
      if (revoked(binding)) throw assistantProblem("notFound", 404);
      const job = this.find(binding, await this.jobs(agent));
      if (!job || job.updatedAtMs !== input.revision)
        throw assistantProblem("conflict", 409);
      if (input.enabled)
        this.source(id, binding.source.channelId, {
          kind: "telegram",
          ...binding.source,
        });
      assertCurrent();
      // Pause delivery before the RPC; a lost acknowledgement must stay paused.
      if (!input.enabled) this.bindings.patch(bindingId, { deliveryEnabled: false });
      this.bindings.patch(bindingId, { reminderUpdateUnknown: true });
      const updated = await this.assistants.runtime.client.call("cron.update", {
        id: job.id,
        patch: { enabled: input.enabled },
      });
      const confirmed = this.bindings.patch(bindingId, {
        deliveryEnabled: input.enabled,
        reminderUpdateUnknown: false,
      });
      this.assistants.changed();
      return this.project(confirmed, updated);
    });
  }
  remove(id, bindingId, assertCurrent = () => {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      const binding = this.owned(id, bindingId);
      // Revoke delivery first, even if the native removal response is lost.
      const revokedBinding = this.bindings.patch(binding.id, { state: "revoked" });
      const job = this.find(revokedBinding, await this.jobs(this.agent(id)));
      assertCurrent();
      if (job) await this.assistants.runtime.client.call("cron.remove", { id: job.id });
      this.bindings.patch(binding.id, { state: "removed" });
      this.assistants.changed();
      return { removed: true };
    });
  }
  runs(id, bindingId) {
    return this.assistants.admit(async () => {
      const binding = this.owned(id, bindingId);
      if (!binding.nativeId) return { entries: [] };
      const result = await this.assistants.runtime.client.call("cron.runs", {
        id: binding.nativeId,
        limit: 20,
      });
      return {
        entries: (result.entries || []).map((r) => ({
          runAtMs: r.runAtMs,
          status: r.status,
          completionStatus: r.completionStatus,
          deliveryStatus: r.deliveryStatus,
        })),
      };
    });
  }
  acceptsDelivery(entry) {
    const binding = this.bindings.get(entry.source.reminderBindingId);
    return (
      !revoked(binding) &&
      binding.deliveryEnabled !== false &&
      (binding.kind !== "routine" || binding.routineEnabled !== false) &&
      personalCapabilities(this.assistants.store.getAssistant(binding.assistantId))
        .reminders
    );
  }
  async complete(bindingId, event) {
    let binding = this.bindings.get(bindingId);
    if (
      revoked(binding) ||
      !personalCapabilities(this.assistants.store.getAssistant(binding.assistantId))
        .reminders
    )
      return;
    if (!binding.nativeId) {
      this.find(binding, await this.jobs(this.agent(binding.assistantId)));
      binding = this.bindings.get(bindingId);
    }
    // Reconciliation may overlap removal, archival or capability revocation.
    if (!this.acceptsDelivery({ source: { reminderBindingId: binding.id } })) return;
    if (
      !event ||
      !binding.nativeId ||
      event.jobId !== binding.nativeId ||
      !Number.isSafeInteger(event.runAtMs) ||
      event.runAtMs < 0 ||
      !["ok", "error"].includes(event.status)
    )
      throw assistantProblem("invalid", 403);
    const text =
      event.status === "ok"
        ? textValue(event.summary, 65536)
        : telegramMessages(this.channels.store.get(binding.source.channelId))
            .reminderFailed;
    this.channels.outbox.enqueue({
      key: `native-reminder:${event.jobId}:${event.runAtMs}`,
      source: { ...binding.source, reminderBindingId: binding.id },
      kind: "reminder",
      text,
      // Only the failure notice is AgentPier wording; a reminder's own summary
      // must keep conflicting when it differs.
      localized: event.status !== "ok",
      // A delivered reminder is the reminder itself; a failure notice links to
      // the agent settings where its history can be reviewed.
      ...(event.status === "ok"
        ? {}
        : { path: `/agents/${encodeURIComponent(binding.assistantId)}/settings` }),
    });
    this.assistants.changed();
  }
  async hasRunning() {
    for (const agent of this.assistants.store.listAssistants()) {
      if (!this.bindings.list(agent.id).length) continue;
      if ((await this.jobs(agent)).some((job) => Number.isFinite(job.state?.runningAtMs)))
        return true;
    }
    return false;
  }
  async disable(id) {
    if (!this.bindings.list(id).some((b) => b.state !== "removed")) return;
    const agent = this.agent(id);
    for (const binding of this.bindings.list(id)) {
      if (binding.kind !== "routine")
        this.bindings.patch(binding.id, { deliveryEnabled: false });
      if (binding.kind === "routine" && binding.routineEnabled !== false)
        this.bindings.patch(binding.id, {
          routineEnabled: false,
          routineRevision: (binding.routineRevision || 1) + 1,
        });
    }
    const jobs = await this.jobs(agent);
    for (const binding of this.bindings.list(id)) {
      const job = this.find(binding, jobs);
      if (job?.enabled)
        await this.assistants.runtime.client.call("cron.update", {
          id: job.id,
          patch: { enabled: false },
        });
    }
  }
  invoke(invocation, input) {
    invocation.assertCurrent();
    exact(input, ["action", "name", "message", "schedule", "id", "enabled", "revision"]);
    const request = this.assistants.ledger.getRequest(
      this.assistants.ledger.getAttempt(invocation.attemptId).requestId,
    );
    const conversation = this.assistants.store.getConversation(request.conversationId);
    const origin = this.assistants.teams.store.context(request.id);
    if (!["owner", "telegram"].includes(origin.kind) || origin.forwarded)
      throw assistantProblem("invalid", 403);
    this.agent(conversation.assistantId, true);
    if (input.action === "list") return this.list(conversation.assistantId);
    if (input.action === "create")
      return this.create(
        conversation.assistantId,
        {
          clientRequestId: `${invocation.attemptId}:${invocation.toolCallId}`,
          name: input.name,
          message: input.message,
          schedule: input.schedule,
        },
        origin,
        invocation.assertCurrent,
      );
    if (input.action === "remove")
      return this.remove(conversation.assistantId, input.id, invocation.assertCurrent);
    if (input.action === "update")
      return this.update(
        conversation.assistantId,
        input.id,
        {
          enabled: input.enabled,
          revision: input.revision,
        },
        invocation.assertCurrent,
      );
    throw assistantProblem("invalid");
  }
}
