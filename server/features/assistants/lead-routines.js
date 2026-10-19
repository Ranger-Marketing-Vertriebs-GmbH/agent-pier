import { assistantProblem, textValue } from "./assistant-validation.js";
import { personalCapabilities, personalEligible } from "./native-capabilities.js";
import { exact, schedule } from "./reminder-input.js";
import { namesMember, ownerProse, parseOwnerText } from "./lead-request-proof.js";
import { minGapMinutes } from "./cron-gap.js";
import { routineReport } from "./lead-routine-reports.js";

// What a lead may set up on one of its permanent members (AGENTPIER-175).
export const leadRoutineLimits = { perMember: 5, minIntervalMinutes: 15 };
export const isLeadRoutine = (binding) => binding?.createdBy === "lead";
const live = (b) => !["removed", "revoked"].includes(b.state);

/**
 * Routines a lead sets up on its own permanent members through
 * agentpier_team_member_routine. Each is the member's own routine binding with the
 * provenance `createdBy: "lead"`, `leadId` and `leadMemberId`: it runs as the
 * member's native routine with the member's own capabilities and its lead's standing
 * shares, its result shows in the member's chat and reaches the lead as an attributed
 * member result (lead-routine-reports.js). It writes only when the owner marked it
 * "May write" or the lead uses its team autonomously (`writable`). It ends for good
 * when the relation does (`prune`): lead or member archived, or the member no longer
 * the lead's permanent member.
 */
export class LeadRoutines {
  constructor(routines) {
    this.routines = routines;
    this.prunedAt = 0;
  }
  get assistants() {
    return this.routines.assistants;
  }
  get teams() {
    return this.assistants.teams?.store || null;
  }
  // --- live relation ----------------------------------------------------------
  /** Why a lead routine no longer belongs to its lead, or null. Never throws. */
  ended(binding) {
    const store = this.assistants.store;
    let lead, member;
    try {
      lead = store.getAssistant(binding.leadId);
    } catch {
      return "lead-gone";
    }
    if (lead.archivedAt) return "lead-archived";
    if (!personalEligible(lead) || lead.teamMemberId) return "lead-gone";
    try {
      member = store.getAssistant(binding.assistantId);
    } catch {
      return "member-gone";
    }
    if (member.archivedAt) return "member-archived";
    const record = this.teams?.find(binding.leadMemberId);
    if (
      !record ||
      record.kind !== "member" ||
      member.teamMemberId !== record.id ||
      member.lifetime !== "permanent" ||
      record.lifetime !== "permanent" ||
      record.parentAssistantId !== binding.leadId
    )
      return "member-left";
    return record.archivedAt ? "member-archived" : null;
  }
  /**
   * Why a run of this routine may write: the owner's "May write" (`owner`), or for a
   * lead routine the lead's autonomous team usage (`autonomous`, read live); null.
   */
  writeReason(binding) {
    if (binding?.routineWrites === true) return "owner";
    if (!isLeadRoutine(binding) || this.ended(binding)) return null;
    try {
      return this.teams?.policy(binding.leadId).usage === "autonomous"
        ? "autonomous"
        : null;
    } catch {
      return null;
    }
  }
  // --- the lead's tool --------------------------------------------------------
  async invoke(inv, input) {
    inv.assertCurrent();
    exact(input, [
      "action",
      "memberId",
      "id",
      "name",
      "prompt",
      "trigger",
      "enabled",
      "revision",
    ]);
    if (!inv.attemptId) throw assistantProblem("invalid", 403);
    const { request, lead } = this.assistants.teams.requests.store.lead(inv.attemptId);
    const origin = this.teams.context(request.id);
    // Standing work for a member: only in a turn of the owner's own message, never
    // from forwarded, scheduled, member-result or other internal turns.
    if (!["owner", "telegram"].includes(origin.kind) || origin.forwarded)
      throw assistantProblem("leadRoutineOwnerTurn", 403);
    if (input.action === "list") return this.list(lead, input.memberId);
    if (input.action === "create") return this.create(inv, lead, request, origin, input);
    const binding = this.owned(lead, input.id);
    if (input.action === "update") return this.update(inv, binding, input);
    if (input.action === "remove") {
      const result = await this.routines.remove(
        binding.assistantId,
        binding.id,
        inv.assertCurrent,
      );
      this.audit(binding, { change: "remove", by: "lead" });
      return result;
    }
    throw assistantProblem("invalid");
  }
  /** One of the lead's own permanent members, reachable and with routines on. */
  member(lead, memberId) {
    textValue(memberId, 100);
    const record = this.teams.find(memberId);
    if (!record || record.kind !== "member" || record.parentAssistantId !== lead.id)
      throw assistantProblem("notFound", 404);
    const agent = this.assistants.store.getAssistant(record.assistantId);
    if (record.archivedAt || agent.archivedAt) throw assistantProblem("notFound", 404);
    if (record.lifetime !== "permanent" || agent.lifetime !== "permanent")
      throw assistantProblem("leadRoutineNotPermanent", 409);
    if (!personalCapabilities(agent).reminders)
      throw assistantProblem("leadRoutineMemberOff", 409);
    return { record, agent };
  }
  /** A routine this lead set up on one of its members that still lives. */
  owned(lead, id) {
    textValue(id, 100);
    let binding;
    try {
      binding = this.routines.bindings.get(id);
    } catch {
      throw assistantProblem("notFound", 404);
    }
    if (
      binding.kind !== "routine" ||
      !isLeadRoutine(binding) ||
      binding.leadId !== lead.id ||
      !live(binding) ||
      this.ended(binding)
    )
      throw assistantProblem("notFound", 404);
    return binding;
  }
  /** The lead's routines on its members, as the member's settings show them. */
  async list(lead, memberId) {
    const records = this.teams
      .members()
      .filter(
        (m) =>
          m.parentAssistantId === lead.id &&
          m.lifetime === "permanent" &&
          !m.archivedAt &&
          (memberId === undefined || m.id === memberId),
      );
    const routines = [];
    for (const record of records) {
      const mine = this.routines.bindings
        .list(record.assistantId)
        .filter((b) => isLeadRoutine(b) && b.leadId === lead.id && live(b));
      if (!mine.length) continue;
      const agent = this.assistants.store.getAssistant(record.assistantId);
      const { routines: listed } = await this.routines.list(record.assistantId);
      for (const r of listed)
        if (mine.some((b) => b.id === r.id))
          routines.push({
            ...publicRoutine(r, !!this.writeReason(this.routines.bindings.get(r.id))),
            memberId: record.id,
            member: agent.name,
          });
    }
    return { routines };
  }
  /** Checks a lead's schedule: one time or a cron, never more often than the minimum. */
  trigger(input) {
    if (input?.kind === "event") throw assistantProblem("invalid");
    const trigger = schedule(input);
    if (trigger.kind === "cron") {
      const gap = minGapMinutes(trigger.expr);
      if (gap === null) throw assistantProblem("invalid");
      if (gap < leadRoutineLimits.minIntervalMinutes)
        throw assistantProblem("leadRoutineInterval");
    }
    return trigger;
  }
  async create(inv, lead, request, origin, input) {
    const { record, agent } = this.member(lead, input.memberId);
    textValue(input.name, 100);
    textValue(input.prompt, 8192);
    const trigger = this.trigger(input.trigger);
    const key = `${inv.attemptId}:${inv.toolCallId}`;
    const mine = this.routines.bindings.list(agent.id);
    const replay = mine.some((b) => b.key === key);
    // On request, the owner's own message in this turn names the member.
    if (!replay && this.teams.policy(lead.id).usage === "onRequest") {
      const others = this.teams
        .members()
        .filter((m) => m.parentAssistantId === lead.id && m.id !== record.id)
        .map((m) => this.assistants.store.getAssistant(m.assistantId).name);
      const prose = ownerProse(parseOwnerText(request.text, origin.hidden)) || "";
      if (!namesMember(prose, agent.name, others))
        throw assistantProblem("leadRoutineNotRequested", 403);
    }
    if (
      !replay &&
      mine.filter((b) => isLeadRoutine(b) && b.leadId === lead.id && live(b)).length >=
        leadRoutineLimits.perMember
    )
      throw assistantProblem("leadRoutineLimit", 409);
    const created = await this.routines.create(
      agent.id,
      { clientRequestId: key, name: input.name, prompt: input.prompt, trigger },
      null,
      inv.assertCurrent,
      { createdBy: "lead", leadId: lead.id, leadMemberId: record.id },
    );
    const binding = this.routines.bindings.get(created.id);
    if (!replay) this.audit(binding, { change: "create", by: "lead" });
    return {
      ...publicRoutine(created, !!this.writeReason(binding)),
      memberId: record.id,
      member: agent.name,
    };
  }
  async update(inv, binding, input) {
    if (!Number.isInteger(input.revision)) throw assistantProblem("invalid");
    const edit = ["name", "prompt", "trigger"].filter((k) => input[k] !== undefined);
    let revision = input.revision,
      result;
    if (edit.length) {
      result = await this.routines.edit(
        binding.assistantId,
        binding.id,
        {
          ...Object.fromEntries(
            edit.map((k) => [
              k,
              k === "trigger" ? this.trigger(input.trigger) : input[k],
            ]),
          ),
          revision,
        },
        inv.assertCurrent,
      );
      revision = result.revision;
    }
    if (input.enabled !== undefined)
      result = await this.routines.update(
        binding.assistantId,
        binding.id,
        { enabled: input.enabled, revision },
        inv.assertCurrent,
      );
    if (!result) throw assistantProblem("invalid");
    this.audit(binding, {
      change: "update",
      by: "lead",
      edited: [...edit, ...(input.enabled !== undefined ? ["enabled"] : [])],
    });
    return publicRoutine(
      result,
      !!this.writeReason(this.routines.bindings.get(binding.id)),
    );
  }
  // --- results ----------------------------------------------------------------
  /** A finished run of a lead routine reaches its lead (lead-routine-reports.js). */
  report(binding, event, text) {
    if (!isLeadRoutine(binding) || this.ended(binding)) return;
    try {
      if (routineReport(this, binding, event, text)) {
        this.assistants.changed();
        this.assistants.teams?.requests?.advance().catch(() => {});
      }
    } catch (error) {
      console.error("Lead routine report failed:", error?.message);
    }
  }
  // --- lifecycle --------------------------------------------------------------
  /**
   * Removes lead routines whose relation ended (`ended`), audited with the reason. A
   * binding is revoked at once, so it neither delivers nor reaches tools; its native
   * job goes once the Gateway is ready. At most every 30 seconds; never throws.
   */
  async prune(now = Date.now()) {
    if (now - this.prunedAt < 30000) return;
    this.prunedAt = now;
    const ending = [];
    try {
      for (const agent of this.assistants.store.listAssistants())
        for (const b of this.routines.bindings.list(agent.id))
          if (b.kind === "routine" && isLeadRoutine(b) && b.state !== "removed") {
            const reason = b.leadEnded || this.ended(b);
            if (reason) ending.push({ agent, binding: b, reason });
          }
    } catch {
      return;
    }
    for (const { binding, reason } of ending)
      if (!binding.leadEnded) {
        this.routines.bindings.patch(binding.id, { state: "revoked", leadEnded: reason });
        this.audit(binding, { change: "remove", by: "system", reason });
      }
    if (!ending.length || !this.assistants.runtime.client?.ready) return;
    await this.assistants
      .admit(async () => {
        for (const { agent, binding } of ending) {
          const job = this.routines.find(binding, await this.routines.jobs(agent));
          if (job)
            await this.assistants.runtime.client.call("cron.remove", { id: job.id });
          this.routines.bindings.patch(binding.id, { state: "removed" });
        }
        this.assistants.changed();
      })
      .catch(() => {});
  }
  audit(binding, details) {
    try {
      this.assistants.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: binding.assistantId,
        source: details.by === "system" ? "system" : "assistant",
        outcome: "success",
        details: {
          kind: "lead-routine",
          routineId: binding.id,
          leadAssistantId: binding.leadId,
          ...details,
        },
      });
    } catch (error) {
      console.error("Lead routine audit failed:", error?.message);
    }
  }
}
// What the lead's tool returns of a routine: never Telegram or owner-only details.
// `writes`: whether its runs may write right now (the owner's switch or autonomous).
function publicRoutine(r, writes = r.writes === true) {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    trigger: r.trigger,
    status: r.status,
    enabled: r.enabled,
    revision: r.revision,
    // The owner's "May write" or the lead's autonomous usage; never set by the lead.
    mayWrite: writes,
    nextRunAtMs: r.nextRunAtMs ?? null,
    lastRunStatus: r.lastRunStatus ?? null,
  };
}
