import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { editableMember, leadsMember } from "./member-reach.js";

const choices = ["now", "after_task"];
// How long `now` waits for a summary without a memory step to report an end at once
// (nothing to summarise, refused); one that runs on answers "summarising".
export const summaryTiming = { answerMs: 2000 };
// What the lead reads beside each status.
const details = {
  summarising:
    "The member's chat is being summarised; the member first saves what it must keep to its memory. The summary shows in the member's chat.",
  queued:
    "The member's chat will be summarised once it finished its current task, before its next question or task from you.",
  busy: 'The member is busy. Call again with when "after_task" to summarise its chat once it finished its current task.',
  already: "The member's chat is being summarised already.",
  nothing: "The member's chat has nothing to summarise.",
};
const answer = (status, member) => ({
  status,
  memberId: member.id,
  detail: details[status],
});

// The error code a job settles with within `ms`; null for success or still running.
const settleWithin = (job, ms) => {
  let timer;
  return Promise.race([
    job.then(
      () => null,
      (error) => error?.code ?? "FAILED",
    ),
    new Promise((resolve) => {
      // Cleared once the job settles; it holds the tool call's answer only.
      timer = setTimeout(resolve, ms, null);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * A lead's summary of its own member's task chat (agentpier_team_member_summarise,
 * AGENTPIER-194): `now` runs Summarise now with its memory step (long-chats.js) at
 * once and is refused as busy while the member works; `after_task` keeps one pending
 * summary on the member's record (`summaryAfterTask`) that the team tick runs once
 * the member is idle, before the next queued lead request reaches its chat (the
 * tick in team-service.js reconcile, and each dispatch: before). A member that is
 * idle already summarises at once. Any summary that starts in that chat, the owner's too,
 * takes the pending one's place; an archived or removed member drops it. The member's
 * task chat (`member.conversationId`) is the only chat it acts on. Both chats note
 * who asked and when; the summary itself shows in the member's chat as usual.
 */
export class MemberSummaries {
  constructor({ teams, assistants, hints }) {
    Object.assign(this, { teams, assistants, hints });
    this.timing = { ...summaryTiming };
  }
  /** Whether a summary after the member's task is pending. */
  pending(memberId) {
    const member = this.teams.find(memberId);
    return !!member?.summaryAfterTask && this.reachable(member);
  }
  reachable(member) {
    if (!editableMember(member, member.parentAssistantId) || !member.conversationId)
      return false;
    try {
      return !this.assistants.store.getAssistant(member.parentAssistantId).archivedAt;
    } catch {
      return false;
    }
  }
  async request(inv, input) {
    exact(input, ["memberId", "when"]);
    if (!choices.includes(input?.when)) throw assistantProblem("invalid");
    const { conversation, member } = leadsMember(
      this.assistants,
      this.teams,
      inv,
      input.memberId,
    );
    if (!member.conversationId) return answer("nothing", member);
    const long = this.assistants.longChats;
    if (!long) throw assistantProblem("unavailable", 503);
    if (long.compacting(member.conversationId)) return answer("already", member);
    // An idle member's task is over: its summary runs now, unless its chat is busy.
    if (input.when === "after_task" && !this.teams.activeMember(member)) {
      const status = await this.start(member, { wait: true });
      if (status === "summarising") this.note(member, conversation, inv, "now");
      if (status !== "busy") return answer(status, member);
    }
    if (input.when === "after_task") {
      const current = this.teams.find(member.id);
      if (!current.summaryAfterTask) {
        this.teams.write(current, { summaryAfterTask: { at: new Date().toISOString() } });
        this.note(member, conversation, inv, "after_task");
        this.assistants.changed?.();
      }
      return answer("queued", member);
    }
    if (this.teams.activeMember(member)) return answer("busy", member);
    const status = await this.start(member, { wait: true });
    if (status === "summarising") this.note(member, conversation, inv, "now");
    return answer(status, member);
  }
  /**
   * Starts the summary of the member's task chat: "summarising", "already" (one ran),
   * "busy" (the chat has work) or, waited for (`wait`), "nothing".
   */
  async start(member, { wait = false } = {}) {
    let begun;
    try {
      begun = await this.assistants.longChats.begin(member.conversationId);
    } catch (error) {
      if (error?.code === "CHAT_BUSY") return "busy";
      throw error;
    }
    if (begun.joined) return "already";
    const code = wait ? await settleWithin(begun.job, this.timing.answerMs) : null;
    if (code === "CHAT_COMPACT_NOTHING") return "nothing";
    if (code === "CHAT_BUSY") return "busy";
    // Any other refusal reaches the lead as it is.
    if (code) await begun.job;
    return "summarising";
  }
  /** A summary started in the chat (LongChats.begin): no hint, no pending summary. */
  started(conversationId) {
    const member = this.teams.members().find((m) => m.conversationId === conversationId);
    if (!member) return;
    this.hints?.clear(conversationId);
    if (member.summaryAfterTask) this.drop(member);
  }
  drop(member) {
    const current = this.teams.find(member.id);
    if (!current?.summaryAfterTask) return;
    this.teams.write(current, { summaryAfterTask: undefined });
    this.assistants.changed?.();
  }
  /** Runs the pending summaries whose members are idle now (team-service.js). */
  async tick() {
    const a = this.assistants;
    if (!a.longChats || a.closed || a.maintenance || a.recovering) return;
    for (const member of this.teams.members()) {
      if (!member.summaryAfterTask) continue;
      try {
        await this.run(member);
      } catch (error) {
        // One member's summary must not hold back the others or the team tick.
        if (error?.status === 503) continue;
        console.warn(
          `Summarising the chat of member ${member.id} failed: ${error?.code || error?.message}`,
        );
        this.drop(member);
      }
    }
  }
  /**
   * Before a lead request is sent to the member (lead-requests.js dispatch): its
   * pending summary starts first, and the request waits while it runs (true); a busy
   * chat or a failure lets the request go and the summary waits for the next idle pass.
   */
  async before(member) {
    if (!member.summaryAfterTask || !this.pending(member.id)) return false;
    try {
      await this.run(member);
    } catch (error) {
      console.warn(
        `Summarising the chat of member ${member.id} failed: ${error?.code || error?.message}`,
      );
    }
    return !!this.assistants.longChats?.compacting(member.conversationId);
  }
  async run(member) {
    if (!this.reachable(member)) return this.drop(member);
    if (this.teams.activeMember(member)) return;
    if (!this.assistants.runtime.client?.ready) return;
    const status = await this.start(member);
    // Another summary or the chat's own work: it runs instead, or the next pass tries.
    if (status === "already") this.drop(member);
  }
  // One settled row per chat, the member's and the lead's (grantNotes).
  note(member, conversation, inv, when) {
    const store = this.assistants.workflows?.store;
    if (!store) return;
    const at = Date.now();
    let memberName = member.name;
    try {
      memberName ||= this.assistants.store.getAssistant(member.assistantId).name;
    } catch {
      /* The record's name only. */
    }
    const payload = {
      action: "member_summarise",
      memberId: member.id,
      memberName,
      teamId: member.teamId,
      when,
    };
    for (const [assistantId, conversationId] of [
      [member.assistantId, member.conversationId],
      [conversation.assistantId, conversation.id],
    ])
      store.reserve({
        assistantId,
        conversationId,
        attemptId: inv.attemptId,
        origin: { kind: "member-grant" },
        key: `member-summarise:${inv.attemptId}:${inv.toolCallId}:${assistantId}`,
        state: "completed",
        payload,
        chatNotes: { result: { at, state: "completed" } },
        settled: true,
      });
  }
}
