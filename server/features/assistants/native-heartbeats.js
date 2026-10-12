import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { personalCapabilities, personalEligible } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { heartbeatSchedule, heartbeatSettings } from "./heartbeat-schedule.js";

export const heartbeatKind = "heartbeat";
// OpenClaw's silent-reply token; an empty summary is just as silent.
const silent = (text) => !text.trim() || text.trim() === "NO_REPLY";
const declaration = (binding) => `agentpier-reminder:${binding.id}`;
const prompt = (memory) =>
  [
    "This is a scheduled check-in from AgentPier, not a message from the owner.",
    `Check whether anything needs the owner's attention right now${memory ? ", using your memory where it helps" : ""}.`,
    "If something does, write one short message addressed to the owner.",
    "If nothing needs attention, reply exactly NO_REPLY and nothing else.",
  ].join("\n");

/**
 * Proactive check-ins ("heartbeat"): one native cron job per opted-in agent, built
 * like a reminder. The run's summary returns over the reminder webhook; AgentPier
 * drops NO_REPLY and sends anything else to the agent's paired chat, which the
 * binding fixed when the job was created. OpenClaw's own heartbeat stays off: it
 * would deliver through channels AgentPier does not configure.
 */
export class NativeHeartbeats {
  constructor({ reminders, notifications }) {
    Object.assign(this, { reminders, notifications });
    this.assistants = reminders.assistants;
    this.bindings = reminders.bindings;
    // Replaced at wiring: agents whose model connection is blocked stay unscheduled.
    this.blocked = () => false;
    reminders.heartbeats = this;
  }
  /** The agent's paired, enabled chat, or null. */
  channel(id) {
    const channel = this.reminders.channels.store
      .list()
      .find((c) => c.assistantId === id && c.enabled && c.chatId);
    return channel
      ? {
          assistantId: id,
          channelId: channel.id,
          chatId: channel.chatId,
          userId: channel.userId,
        }
      : null;
  }
  requireChannel(id) {
    this.assistants.store.getAssistant(id);
    if (!this.channel(id)) throw assistantProblem("heartbeatChannelRequired", 409);
  }
  wanted(agent) {
    const settings = heartbeatSettings(agent);
    const source = this.channel(agent.id);
    if (
      !settings.enabled ||
      !personalEligible(agent) ||
      !source ||
      this.blocked(agent.id)
    )
      return null;
    return { settings, source };
  }
  job(agent, settings) {
    const memory = personalCapabilities(agent).memory;
    return {
      schedule: heartbeatSchedule(settings),
      payload: {
        kind: "agentTurn",
        message: prompt(memory),
        timeoutSeconds: 120,
        lightContext: true,
        // Memory is read, never written, in a run nobody watches.
        toolsAllow: memory ? ["memory_search", "memory_get"] : [],
      },
    };
  }
  current(id) {
    return this.bindings
      .list(id)
      .filter((b) => b.kind === heartbeatKind && b.state !== "removed");
  }
  async retire(binding, job) {
    // Revoked before the RPC: a lost acknowledgement must not keep delivering.
    this.bindings.patch(binding.id, { state: "revoked" });
    if (job) await this.assistants.runtime.client.call("cron.remove", { id: job.id });
    this.bindings.patch(binding.id, { state: "removed" });
  }
  /**
   * Converges the agent's native job with its settings. Callers hold admission;
   * without a ready Gateway and webhook nothing changes (the next ready repeats it).
   */
  async sync(id) {
    const agent = this.assistants.store.getAssistant(id);
    const want = this.wanted(agent);
    const existing = this.current(id);
    if (!want && !existing.length) return;
    const jobs = await this.reminders.jobs(agent);
    let keep = null;
    for (const binding of existing) {
      const job = this.reminders.find(binding, jobs);
      // find() adopts a job an unconfirmed creation did submit.
      const current = this.bindings.get(binding.id);
      const same =
        want &&
        !keep &&
        current.state === "bound" &&
        job &&
        ["channelId", "chatId", "userId"].every(
          (k) => current.source[k] === want.source[k],
        );
      if (same) keep = { binding: current, job };
      else await this.retire(current, job);
    }
    if (!want) return this.assistants.changed();
    const definition = this.job(agent, want.settings);
    if (!keep) return this.create(agent, want.source, definition);
    const { binding, job } = keep;
    if (
      job.enabled &&
      binding.deliveryEnabled !== false &&
      isDeepStrictEqual(job.schedule, definition.schedule) &&
      isDeepStrictEqual(job.payload, definition.payload)
    )
      return;
    await this.assistants.runtime.client.call("cron.update", {
      id: job.id,
      patch: { ...definition, enabled: true },
    });
    this.bindings.patch(binding.id, { deliveryEnabled: true });
    this.assistants.changed();
  }
  async create(agent, source, definition) {
    const connection = await this.reminders.start();
    // A fresh key each time: a retired binding is never revived.
    const { binding } = this.bindings.reserve(
      agent.id,
      `heartbeat:${randomUUID()}`,
      source,
      {},
      { kind: heartbeatKind },
    );
    this.bindings.patch(binding.id, { state: "pending" });
    try {
      const result = await this.assistants.runtime.client.call("cron.add", {
        name: "AgentPier check-in",
        declarationKey: declaration(binding),
        agentId: agent.runtimeAgentId,
        enabled: true,
        deleteAfterRun: false,
        ...definition,
        sessionTarget: "isolated",
        wakeMode: "now",
        failureAlert: false,
        delivery: { mode: "webhook", to: `${connection.url}/complete/${binding.id}` },
      });
      const job = result?.job || result;
      if (!job?.id) throw assistantProblem("unavailable", 503);
      this.bindings.patch(binding.id, { nativeId: job.id, state: "bound" });
    } catch (error) {
      // An unconfirmed job is found by its declaration on the next sync and retired.
      this.bindings.patch(binding.id, {
        state: error.code === "INVALID_REQUEST" ? "rejected" : "unknown",
      });
      throw assistantProblem("unavailable", 503);
    } finally {
      this.assistants.changed();
    }
  }
  /** Every agent with settings or a binding, outside any admission (ready, leave). */
  reconcile() {
    return this.assistants.admit(async () => {
      if (!this.assistants.runtime.client?.ready) return;
      for (const agent of this.assistants.store.listAssistants()) {
        if (!agent.heartbeat?.enabled && !this.current(agent.id).length) continue;
        await this.sync(agent.id).catch(() => {});
      }
    });
  }
  acceptsDelivery(entry) {
    const binding = this.bindings.get(entry.source.reminderBindingId);
    const agent = this.assistants.store.getAssistant(binding.assistantId);
    return (
      binding.kind === heartbeatKind &&
      !["revoked", "removed"].includes(binding.state) &&
      binding.deliveryEnabled !== false &&
      !!this.wanted(agent)
    );
  }
  async complete(binding, event) {
    if (["revoked", "removed"].includes(binding.state)) return;
    if (
      !event ||
      !binding.nativeId ||
      event.jobId !== binding.nativeId ||
      !Number.isSafeInteger(event.runAtMs) ||
      event.runAtMs < 0 ||
      !["ok", "error"].includes(event.status)
    )
      throw assistantProblem("invalid", 403);
    const entry = { source: { reminderBindingId: binding.id } };
    // A failed check-in is not news for the owner; its run history keeps it.
    if (event.status !== "ok" || !this.acceptsDelivery(entry)) return;
    if (typeof event.summary !== "string" || silent(event.summary)) return;
    const text = textValue(event.summary, 65536);
    const key = `native-heartbeat:${event.jobId}:${event.runAtMs}`;
    const known = this.reminders.channels.outbox
      .all(binding.source.channelId)
      .some((e) => e.key === key);
    this.reminders.channels.outbox.enqueue({
      key,
      // The destination is the binding's, fixed when the owner enabled check-ins.
      source: { ...binding.source, reminderBindingId: binding.id },
      kind: heartbeatKind,
      text,
    });
    if (!known)
      this.notifications
        ?.notify({
          kind: "agent-checkin",
          assistantId: binding.assistantId,
          eventId: `heartbeat-${event.runAtMs}-${binding.id}`,
        })
        .catch(() => {});
    this.assistants.changed();
  }
}
