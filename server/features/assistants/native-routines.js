import { isDeepStrictEqual } from "node:util";
import { NativeReminders, exact, schedule, updateInput } from "./native-reminders.js";
import { RoutineEvents } from "./routine-events.js";
import { routineTools } from "./native-capabilities.js";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { isLeadRoutine, LeadRoutines } from "./lead-routines.js";
import { editRoutine } from "./routine-edits.js";
import { agentFailure } from "./routine-failures.js";
import { agentPerson, audienceOf, boundTo, turnAudience } from "./reminder-audience.js";
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
    // Routines a lead set up on its permanent members (lead-routines.js).
    this.lead = new LeadRoutines(this);
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
  payload(values, binding) {
    // A lead's routine on its member reports to the lead (lead-routine-reports.js);
    // the lead is not named, so a rename never rewrites the job.
    if (isLeadRoutine(binding))
      return [
        `This is the scheduled AgentPier routine ${JSON.stringify(values.name)} that your lead agent set up for you, not a message from the owner.`,
        "Carry out its saved task below. Your reply is your report: it goes to your lead agent and shows in your chat. If the task says to report only when something is found and there is nothing, reply with exactly NO_REPLY.",
        "",
        values.prompt,
      ].join("\n");
    // A user's routine runs in her chat: it reports to her, never to the owner.
    const who = typeof binding?.userId === "string" ? "your user" : "the owner";
    return [
      `This is the scheduled AgentPier routine ${JSON.stringify(values.name)}, not a message from ${who}.`,
      `Carry out its saved task below and reply with the result for ${who}.`,
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
        message: this.payload(values, binding),
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
      // Set up by the member's lead (lead-routines.js), named for the owner.
      ...(isLeadRoutine(binding)
        ? {
            createdBy: {
              kind: "lead",
              leadId: binding.leadId,
              leadName: this.leadName(binding),
            },
          }
        : {}),
    };
  }
  leadName(binding) {
    try {
      return this.assistants.store.getAssistant(binding.leadId).name;
    } catch {
      return "";
    }
  }
  /**
   * Whether a run of this routine may write: the owner's "May write", or for a
   * lead's routine on its member also the lead's autonomous team usage (read live).
   */
  writable(binding) {
    return !!this.lead.writeReason(binding);
  }
  /** Name, task or schedule in place (routine-edits.js). */
  edit(id, bindingId, input, assertCurrent) {
    return editRoutine(this, id, bindingId, input, assertCurrent);
  }
  /**
   * The owner's switch "May write": the routine's run may change files in its
   * project folders (workspace-calls.js), and the tasks it delegates count as the
   * owner's standing instruction and may change files. The agent's own routine tool
   * reaches it only on the owner's direct request (mayWrite); audited.
   */
  setWrites(binding, input, actor) {
    if ((binding.routineWrites === true) === input.writes) return;
    this.bindings.patch(binding.id, { routineWrites: input.writes });
    this.auditWrites(binding, input.writes, actor);
  }
  /** `actor` "assistant": switched by the agent's tool on the owner's request. */
  auditWrites(binding, writes, actor) {
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
          writes,
          ...(actor && { actor, channel: "tool" }),
        },
      });
    } catch (error) {
      console.error("Routine audit failed:", error?.message);
    }
  }
  async list(id, scope) {
    const { reminders } = await super.list(id, scope);
    return { routines: reminders };
  }
  /** The agent's tool list: OpenClaw's error text quoted as data (routine-failures.js). */
  async listForAgent(id, userId) {
    const { routines } = await this.list(id, { userId });
    return {
      routines: routines.map((r) => ({ ...r, lastFailure: agentFailure(r.lastFailure) })),
    };
  }
  /**
   * Whether this turn's person may switch "May write" with the agent's tool: only
   * where she may in the settings, which is the owner's own routines (the owner's
   * routine routes; a user's own route drops it, me-reminders.js). The turn is
   * already a direct one (turnAudience).
   */
  mayWrite(id, userId, writes) {
    if (writes === undefined) return;
    if (typeof writes !== "boolean") throw assistantProblem("invalid");
    if (userId !== null || agentPerson(this.assistants.store.getAssistant(id)) !== null)
      throw assistantProblem("routineWritesOwnerOnly", 403);
  }
  update(id, bindingId, input, assertCurrent = () => {}, actor) {
    // The owner's edit of a routine's name or task (and a lead's, lead-routines.js).
    if (input && ["name", "prompt", "trigger"].some((k) => k in input))
      return this.edit(id, bindingId, input, assertCurrent);
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
      if (input.writes !== undefined) this.setWrites(binding, input, actor);
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
    exact(input, [
      "action",
      "name",
      "prompt",
      "trigger",
      "id",
      "enabled",
      "revision",
      "telegram",
      "writes",
    ]);
    const request = this.assistants.ledger.getRequest(
      this.assistants.ledger.getAttempt(invocation.attemptId).requestId,
    );
    const conversation = this.assistants.store.getConversation(request.conversationId);
    const origin = this.assistants.teams.store.context(request.id);
    const id = conversation.assistantId;
    // The person whose chat the turn is in owns what it creates (reminder-audience.js).
    const userId = turnAudience(
      this.assistants.store.getAssistant(id),
      conversation,
      origin,
      input?.action !== "list",
    );
    this.agent(id, true);
    if (input.action === "list") return this.listForAgent(id, userId);
    if (["update", "remove"].includes(input.action))
      boundTo(this.bindings, id, input.id, userId);
    if (["create", "update"].includes(input.action))
      this.mayWrite(id, userId, input.writes);
    if (input.action === "create")
      return this.createOwn(id, invocation, input, origin, userId);
    if (input.action === "update")
      return this.update(
        id,
        input.id,
        {
          enabled: input.enabled,
          telegram: input.telegram,
          writes: input.writes,
          revision: input.revision,
        },
        invocation.assertCurrent,
        "assistant",
      );
    if (input.action === "remove")
      return this.remove(id, input.id, invocation.assertCurrent);
    throw assistantProblem("invalid");
  }
  /**
   * The tool's create; "May write" comes with the binding. It is logged when this call
   * brings the routine into being: also on a retry whose first attempt never got bound
   * (prepared, pending or unknown), never on a replay of one already bound.
   */
  async createOwn(id, invocation, input, origin, userId) {
    const clientRequestId = `${invocation.attemptId}:${invocation.toolCallId}`;
    const before = this.bindings.list(id).find((b) => b.key === clientRequestId);
    const logged = ["bound", "removed", "revoked"].includes(before?.state);
    const routine = await this.create(
      id,
      {
        clientRequestId,
        name: input.name,
        prompt: input.prompt,
        trigger: input.trigger,
        // The person's own paired chat only (routine-targets.js), on her request.
        ...(input.telegram !== undefined && { telegram: input.telegram }),
      },
      origin,
      invocation.assertCurrent,
      {
        ...(userId && { userId }),
        ...(input.writes !== undefined && { routineWrites: input.writes }),
      },
    );
    const binding = this.bindings.get(routine.id);
    if (!logged && binding.state === "bound" && binding.routineWrites === true)
      this.auditWrites(binding, true, "assistant");
    return routine;
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
    let changed = false;
    for (const binding of routines) {
      // Each routine runs in the main chat of the person it belongs to. One whose
      // person may no longer chat here is left as it is, never the agent's others.
      let conversation;
      try {
        conversation = await this.openMain(id, audienceOf(binding));
      } catch {
        continue;
      }
      const target = {
        conversationId: conversation.id,
        sessionKey: conversation.runtimeSessionKey,
      };
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
    const binding = this.bindings.list(assistant.id).find(
      (b) =>
        b.kind === "routine" &&
        b.state === "bound" &&
        b.routineEnabled !== false &&
        b.nativeId?.toLowerCase() === match[2].toLowerCase() &&
        // A lead's routine counts only while its lead and member still belong.
        (!isLeadRoutine(b) || !this.lead.ended(b)),
    );
    const conversation = binding && this.conversation(binding);
    return conversation ? { binding, conversation } : null;
  }
}
