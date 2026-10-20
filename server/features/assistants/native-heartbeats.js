import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { personalCapabilities } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { heartbeatSchedule, heartbeatSettings } from "./heartbeat-schedule.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";
import {
  deliverableChannel,
  pairedChannel,
  sameTelegram,
  telegramOf,
  telegramTarget,
} from "./routine-targets.js";

import { agentName, agentPerson, pushAudience } from "./reminder-audience.js";
import { isShared } from "../users/user-access.js";

export const heartbeatKind = "heartbeat";
// OpenClaw's silent-reply token; an empty summary is just as silent.
const silent = (text) => !text.trim() || text.trim() === "NO_REPLY";
const declaration = (binding) => `agentpier-reminder:${binding.id}`;
// Creation was submitted but not confirmed: the job may still surface.
const unconfirmed = (binding) => ["pending", "unknown"].includes(binding.state);
const prompt = [
  "This is a scheduled check-in from AgentPier, not a message from the owner.",
  "First read MEMORY.md with memory_get; search your other notes with memory_search where it helps.",
  "Using this conversation and your memory, check whether anything needs the owner's attention right now.",
  "If something does, write one short message addressed to the owner.",
  "If nothing needs attention, reply exactly NO_REPLY and nothing else.",
].join("\n");

/**
 * Proactive check-ins ("heartbeat"): one native cron job per opted-in agent with
 * memory. It runs as a `current` job bound to the agent's main chat: a detached
 * turn with full context (instructions, notes, the conversation's recent tail)
 * whose visible result OpenClaw commits into that conversation once no turn is
 * running there. The run's summary also returns over the reminder webhook
 * (completion destination); AgentPier drops NO_REPLY, badges anything else in the
 * chat, sends an `agent-checkin` push notice and, unless the owner switched it
 * off, sends it to the paired Telegram chat too. A pairing change only moves that
 * extra delivery; it never retires the job. OpenClaw's own heartbeat stays off: it
 * would deliver through channels AgentPier leaves empty.
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
  /** Whether the agent should keep a check-in job, chat aside. */
  eligible(agent) {
    return (
      heartbeatSettings(agent).enabled &&
      // A shared agent has no one person to check in with (first version: off).
      !isShared(agent) &&
      // The notes are what a check-in looks at; without memory it has nothing.
      personalCapabilities(agent).memory &&
      !this.blocked(agent.id)
    );
  }
  /** The job an eligible agent should have: its main chat and Telegram extra. */
  wanted(agent) {
    // The main chat of the agent's person: the owner, or the user of her own agent.
    const conversation = this.reminders.mainConversation(agent.id, agentPerson(agent));
    if (!this.eligible(agent) || !conversation) return null;
    const settings = heartbeatSettings(agent);
    const channel =
      settings.telegram !== false && pairedChannel(this.reminders.channels, agent.id);
    return {
      settings,
      target: {
        conversationId: conversation.id,
        sessionKey: conversation.runtimeSessionKey,
      },
      telegram: channel ? telegramTarget(channel) : null,
    };
  }
  job(settings) {
    return {
      schedule: heartbeatSchedule(settings),
      payload: {
        kind: "agentTurn",
        message: prompt,
        timeoutSeconds: 120,
        lightContext: false,
        // Memory is read, never written, in a run nobody watches.
        toolsAllow: ["memory_search", "memory_get"],
      },
    };
  }
  current(id) {
    return this.bindings
      .list(id)
      .filter((b) => b.kind === heartbeatKind && b.state !== "removed");
  }
  async retire(binding, job) {
    // Kept until a listing shows its job: retiring it now could orphan a late job.
    if (!job && unconfirmed(binding)) return;
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
    // Check-ins run in the main chat; an agent that has none yet gets it now.
    if (this.eligible(agent)) await this.reminders.openMain(id, agentPerson(agent));
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
        job.sessionTarget === "current" &&
        job.sessionKey === want.target.sessionKey;
      if (same) keep = { binding: current, job };
      else await this.retire(current, job);
    }
    if (!want) return this.assistants.changed();
    const definition = this.job(want.settings);
    if (!keep) return this.create(agent, want, definition);
    const { binding, job } = keep;
    // The Telegram extra follows the pairing; the job stays as it is.
    if (
      !isDeepStrictEqual(binding.target, want.target) ||
      !isDeepStrictEqual(telegramOf(binding), want.telegram)
    ) {
      this.bindings.patch(binding.id, { target: want.target, telegram: want.telegram });
      this.assistants.changed();
    }
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
  async create(agent, { target, telegram }, definition) {
    const connection = await this.reminders.start();
    // A fresh key each time: a retired binding is never revived.
    const { binding } = this.bindings.reserve(
      agent.id,
      `heartbeat:${randomUUID()}`,
      { assistantId: agent.id },
      {},
      {
        kind: heartbeatKind,
        target,
        telegram,
        ...(agentPerson(agent) && { userId: agentPerson(agent) }),
      },
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
        // Commits the visible result into this conversation after any running turn.
        sessionTarget: "current",
        sessionKey: target.sessionKey,
        wakeMode: "now",
        failureAlert: false,
        // Announce is the session commit (no channels are configured); the
        // completion webhook hands the result to AgentPier.
        delivery: {
          mode: "announce",
          completionDestination: {
            mode: "webhook",
            to: `${connection.url}/complete/${binding.id}`,
          },
        },
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
  /** One agent outside any admission, after its pairing changed (channel-service.js). */
  resync(id) {
    return this.assistants.admit(async () => {
      if (this.assistants.runtime.client?.ready) await this.sync(id);
    });
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
  /** Whether the binding's check-ins are still wanted at all. */
  accepts(binding) {
    const agent = this.assistants.store.getAssistant(binding.assistantId);
    return (
      binding.kind === heartbeatKind &&
      !["revoked", "removed"].includes(binding.state) &&
      binding.deliveryEnabled !== false &&
      !!this.wanted(agent)
    );
  }
  /** Telegram outbox entries: only while check-ins still go to that chat. */
  acceptsDelivery(entry) {
    const binding = this.bindings.get(entry.source.reminderBindingId);
    return this.accepts(binding) && sameTelegram(binding, entry);
  }
  async complete(binding, event) {
    if (["revoked", "removed"].includes(binding.state)) return;
    // A lost creation acknowledgement: the job's own completion proves it exists.
    if (!binding.nativeId) {
      const agent = this.assistants.store.getAssistant(binding.assistantId);
      this.reminders.find(binding, await this.reminders.jobs(agent));
      binding = this.bindings.get(binding.id);
    }
    if (
      !event ||
      !binding.nativeId ||
      event.jobId !== binding.nativeId ||
      !Number.isSafeInteger(event.runAtMs) ||
      event.runAtMs < 0 ||
      !["ok", "error"].includes(event.status)
    )
      throw assistantProblem("invalid", 403);
    // A failed check-in is not news for the owner; its run history keeps it.
    if (event.status !== "ok" || !this.accepts(binding)) return;
    if (typeof event.summary !== "string" || silent(event.summary)) return;
    // Only a check-in OpenClaw committed to the conversation counts: an owner's
    // reply must find it there (a lost commit is in the run history).
    if (event.deliveryStatus !== "delivered") return;
    textValue(event.summary, 65536);
    const key = `native-heartbeat:${event.jobId}:${event.runAtMs}`;
    const { outbox } = this.reminders.channels;
    const channel = deliverableChannel(this.reminders.channels, telegramOf(binding));
    const sent = (c) => outbox.all(c.id).some((e) => e.key === key);
    // A replay is already handled; the prefix's language may have changed since.
    if (channel && sent(channel)) return;
    const prefix = channel ? telegramMessages(channel).heartbeatPrefix : "";
    // OpenClaw's webhook caps a long check-in; the run's session has all of it.
    const result = await this.reminders.resultText(binding, event, {
      limit: 65536 - prefix.length - 1,
    });
    // The read waits on the Gateway: a pause or a replay meanwhile still holds.
    binding = this.bindings.get(binding.id);
    if (!this.accepts(binding)) return;
    // Badged in the chat in the owner's interface language (routine-results.js).
    const recorded = this.reminders.completed(binding, event, result);
    const telegram = deliverableChannel(this.reminders.channels, telegramOf(binding));
    if (telegram && !sent(telegram))
      outbox.enqueue({
        key,
        // The destination is the binding's: the chat paired when it last synced.
        source: {
          assistantId: binding.assistantId,
          ...telegramOf(binding),
          reminderBindingId: binding.id,
        },
        kind: heartbeatKind,
        // Marked in the chat's language, so a check-in never passes for a reply.
        text: `${telegramMessages(telegram).heartbeatPrefix} ${result.trim()}`.slice(
          0,
          65536,
        ),
      });
    if (recorded?.fresh)
      Promise.resolve()
        .then(() =>
          this.notifications?.notify({
            kind: "agent-checkin",
            ...pushAudience(binding),
            assistantId: binding.assistantId,
            conversationId: recorded.conversation.id,
            eventId: `heartbeat-${event.runAtMs}-${binding.id}`,
            // The agent's name and the check-in as a preview, for devices that show
            // them; whether the paired Telegram chat has it too.
            label: agentName(this.assistants, binding.assistantId),
            preview: result,
            ...(telegram ? { telegram: true } : {}),
          }),
        )
        .catch(() => {});
    this.assistants.changed({ conversationId: recorded?.conversation.id });
  }
}
