import { ReminderBindings } from "./reminder-bindings.js";
import { ReminderWebhook } from "./reminder-webhook.js";
import { personalCapabilities } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";
import { cronResultText } from "./cron-result-text.js";
import { RoutineResults } from "./routine-results.js";
import {
  deliverableChannel,
  mainConversation,
  pairedChannel,
  sameTelegram,
  telegramOf,
  telegramTarget,
} from "./routine-targets.js";
import { exact, schedule, updateInput } from "./reminder-input.js";
import { invokeReminder } from "./reminder-tools.js";

// The agent's name for a push notice; a notice without it still goes out.
const agentName = (assistants, id) => {
  try {
    return assistants.store.getAssistant(id)?.name;
  } catch {
    return undefined;
  }
};
export { exact, schedule, updateInput } from "./reminder-input.js";
export { memberReminderLimit } from "./reminder-tools.js";
const declaration = (binding) => `agentpier-reminder:${binding.id}`;
// OpenClaw's silent-reply token; an empty summary is just as silent.
const silent = (text) => !text.trim() || text.trim() === "NO_REPLY";
const revoked = (binding) => ["revoked", "removed"].includes(binding.state);
// Creation was submitted but never confirmed; only an owner review resolves it.
const unconfirmed = (binding) => ["pending", "unknown"].includes(binding.state);
export class NativeReminders {
  constructor({ assistants, channels, dataDir, shared, notifications }) {
    Object.assign(this, { assistants, channels });
    this.kind = "reminder";
    this.notifications = shared ? shared.notifications : notifications;
    this.bindings = shared?.bindings || new ReminderBindings(assistants.store.db);
    // What the main chat shows of reminders, routines and check-ins.
    this.results = shared?.results || new RoutineResults(assistants.store.db);
    // Refusals during a routine run, by native job id (note → when), until its
    // completion records them. Memory only: the tool error already reached the model.
    this.refusals = shared?.refusals || new Map();
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
    const telegram = telegramOf(binding);
    const delivery =
      telegram &&
      this.channels.outbox
        .all(telegram.channelId)
        .filter((e) => e.source.reminderBindingId === binding.id)
        .at(-1);
    return {
      id: binding.id,
      telegram: !!telegram,
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
  /** The agent's main chat (routine-targets.js), or null before it has one. */
  mainConversation(id) {
    return mainConversation(this.assistants.store, id);
  }
  /** The main chat, opened first when the agent has none yet. Callers hold admission. */
  async openMain(id) {
    return (
      this.mainConversation(id) ||
      (await this.assistants.mainConversation(id, { turn: false }))
    );
  }
  /** The conversation a binding's results go to: its agent's main chat. */
  conversation(binding) {
    const conversation = this.mainConversation(binding.assistantId);
    return conversation?.assistantId === binding.assistantId ? conversation : null;
  }
  /** The paired Telegram chat a binding may also deliver to (origin: the asking chat). */
  telegramTarget(id, channelId, origin) {
    const channel =
      origin?.kind === "telegram"
        ? this.channels.store.get(origin.channelId)
        : channelId
          ? this.channels.store.get(channelId)
          : pairedChannel(this.channels, id);
    if (!channel || channel.assistantId !== id || !channel.enabled || !channel.chatId)
      throw assistantProblem("reminderChannelRequired", 409);
    if (
      origin?.kind === "telegram" &&
      ["chatId", "userId"].some((k) => channel[k] !== origin[k])
    )
      throw assistantProblem("invalid", 403);
    return telegramTarget(channel);
  }
  /** Whether a binding asks for Telegram too: by default only when asked from there. */
  wantsTelegram(input, origin) {
    if (input.telegram !== undefined && typeof input.telegram !== "boolean")
      throw assistantProblem("invalid");
    return input.telegram ?? (origin?.kind === "telegram" || !!input.channelId);
  }
  /** Switches a binding's extra Telegram delivery; on needs a paired chat. */
  setTelegram(binding, on) {
    this.bindings.patch(binding.id, {
      telegram: on ? this.telegramTarget(binding.assistantId) : null,
    });
  }
  values(input, old) {
    exact(input, [
      "clientRequestId",
      "name",
      "message",
      "schedule",
      "channelId",
      "telegram",
    ]);
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
  /** How a run executes and where its result goes; `to` is its completion webhook. */
  run(binding, values, to) {
    return {
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: this.payload(values),
        timeoutSeconds: 90,
        lightContext: true,
        // A reminder returns its text verbatim: it needs no tool at all.
        toolsAllow: [],
      },
      delivery: { mode: "webhook", to },
    };
  }
  create(id, input, origin, assertCurrent = () => {}, metadata = {}) {
    return this.assistants.admit(async () => {
      assertCurrent();
      textValue(input?.clientRequestId, 768);
      textValue(input.name, 100);
      const agent = this.agent(id, true);
      const telegram = this.wantsTelegram(input, origin)
        ? this.telegramTarget(id, input.channelId, origin)
        : null;
      const old = this.bindings.list(id).find((b) => b.key === input.clientRequestId);
      // Replay lookup precedes due-time validation: an acknowledged one-shot may
      // already be in the past when the caller recovers its creation result.
      const values = this.values(input, old);
      // The source is the agent alone: results go to its main chat, and the
      // Telegram extra may be switched later.
      const { binding, fresh } = this.bindings.reserve(
        id,
        input.clientRequestId,
        { assistantId: id },
        { ...values, telegram: !!telegram },
        {
          kind: this.kind,
          definition: values,
          routineEnabled: true,
          telegram,
          ...metadata,
        },
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
      const conversation = await this.openMain(id);
      assertCurrent();
      this.agent(id, true);
      this.bindings.patch(binding.id, {
        state: "pending",
        target: {
          conversationId: conversation.id,
          sessionKey: conversation.runtimeSessionKey,
        },
      });
      this.creating.add(binding.id);
      try {
        const result = await this.assistants.runtime.client.call("cron.add", {
          name: values.name,
          declarationKey: declaration(binding),
          agentId: agent.runtimeAgentId,
          enabled: this.nativeEnabled(values),
          deleteAfterRun: false,
          schedule: values.schedule,
          wakeMode: "now",
          failureAlert: false,
          ...this.run(
            this.bindings.get(binding.id),
            values,
            `${connection.url}/complete/${binding.id}`,
          ),
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
      updateInput(input);
      const agent = this.agent(id, input.enabled === true),
        binding = this.owned(id, bindingId);
      if (revoked(binding)) throw assistantProblem("notFound", 404);
      const job = this.find(binding, await this.jobs(agent));
      if (!job || job.updatedAtMs !== input.revision)
        throw assistantProblem("conflict", 409);
      assertCurrent();
      if (input.telegram !== undefined) this.setTelegram(binding, input.telegram);
      if (input.enabled === undefined) {
        this.assistants.changed();
        return this.project(this.bindings.get(bindingId), job);
      }
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
  /** Telegram outbox entries: only while the binding still delivers to that chat. */
  acceptsDelivery(entry) {
    const binding = this.bindings.get(entry.source.reminderBindingId);
    return sameTelegram(binding, entry) && this.accepts(binding);
  }
  accepts(binding) {
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
    if (binding.kind === "heartbeat") return this.heartbeats?.complete(binding, event);
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
    if (!this.accepts(binding)) return;
    if (
      !event ||
      !binding.nativeId ||
      event.jobId !== binding.nativeId ||
      !Number.isSafeInteger(event.runAtMs) ||
      event.runAtMs < 0 ||
      !["ok", "error"].includes(event.status)
    )
      throw assistantProblem("invalid", 403);
    const key = `native-reminder:${event.jobId}:${event.runAtMs}`;
    const ok = event.status === "ok";
    if (ok) textValue(event.summary, 65536);
    const text = ok ? await this.resultText(binding, event, { key }) : null;
    // Reading the full result waits on the Gateway: a pause or a Telegram switch
    // meanwhile still holds.
    binding = this.bindings.get(bindingId);
    if (!this.accepts(binding)) return;
    // A routine that found nothing to say (OpenClaw's silent token) sends nothing.
    if (binding.kind === "routine" && ok && silent(text)) return;
    const viaTelegram = Boolean(deliverableChannel(this.channels, telegramOf(binding)));
    this.toTelegram(binding, { key, ok, text });
    // The main chat shows it, and a push notice links there.
    const recorded = this.completed(binding, event, text);
    if (recorded?.fresh)
      Promise.resolve()
        .then(() =>
          this.notifications?.notify({
            kind: "agent-routine",
            assistantId: binding.assistantId,
            conversationId: recorded.conversation.id,
            eventId: `routine-${event.runAtMs}-${binding.id}`,
            // The agent's name for devices that show names; a routine never previews.
            label: agentName(this.assistants, binding.assistantId),
            ...(viaTelegram ? { telegram: true } : {}),
          }),
        )
        .catch(() => {});
    this.assistants.changed({ conversationId: recorded?.conversation.id });
  }
  /** The extra Telegram delivery, while the binding's chat is still paired. */
  toTelegram(binding, { key, ok, text }) {
    const telegram = telegramOf(binding);
    const channel = deliverableChannel(this.channels, telegram);
    if (!channel) return;
    this.channels.outbox.enqueue({
      key,
      source: {
        assistantId: binding.assistantId,
        ...telegram,
        reminderBindingId: binding.id,
      },
      kind: "reminder",
      text: ok ? text : telegramMessages(channel).reminderFailed,
      // Only the failure notice is AgentPier wording; a reminder's own summary
      // must keep conflicting when it differs.
      localized: !ok,
      // A delivered reminder is the reminder itself; a failure notice links to
      // the agent settings where its history can be reviewed.
      ...(ok
        ? {}
        : { path: `/agents/${encodeURIComponent(binding.assistantId)}/settings` }),
    });
  }
  /**
   * Records an accepted completion for the main chat: a routine's result OpenClaw
   * committed there is only badged, any other result is kept with its text. Null
   * without a chat; `fresh` is false for a replayed completion.
   */
  completed(binding, event, text = event.summary) {
    const conversation = this.conversation(binding);
    if (!conversation) return null;
    const ok = event.status === "ok";
    const key = String(event.jobId || "").toLowerCase();
    // A run that completed without a record (silent, paused) leaves its notes here;
    // only notes from this run's start on belong to it.
    const notes = [...(this.refusals.get(key) || [])]
      .filter(([, at]) => at >= event.runAtMs)
      .map(([note]) => note);
    this.refusals.delete(key);
    const kind = binding.kind || "reminder";
    const fresh = this.results.record({
      id: `${event.jobId}:${event.runAtMs}`,
      conversationId: conversation.id,
      bindingId: binding.id,
      ...(kind !== "routine" && { kind }),
      name: binding.definition?.name || "",
      runAtMs: event.runAtMs,
      at: Date.now(),
      status: ok ? "ok" : "error",
      // Committed: OpenClaw wrote it into the conversation, whose history shows it.
      // A reminder's isolated run reports its webhook delivery, never a commit.
      ...(ok && {
        text: text.trim(),
        committed: kind !== "reminder" && event.deliveryStatus === "delivered",
      }),
      ...(notes.length ? { notes } : {}),
    });
    return { conversation, fresh };
  }
  /**
   * A successful run's full result. OpenClaw's webhook caps the summary; the run's
   * session has the rest. A replay keeps what the outbox entry `key` already holds.
   */
  resultText(binding, event, { key, limit } = {}) {
    return cronResultText({
      client: this.assistants.runtime.client,
      agentId: this.assistants.store.getAssistant(binding.assistantId).runtimeAgentId,
      event,
      known:
        key &&
        telegramOf(binding) &&
        this.channels.outbox.all(telegramOf(binding).channelId).find((e) => e.key === key)
          ?.text,
      limit,
    });
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
    return invokeReminder(this, invocation, input);
  }
}
