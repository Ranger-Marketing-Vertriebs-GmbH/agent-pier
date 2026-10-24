// The `agentpier_goal` actions (AGENTPIER-208). The owner's own turn sets a goal;
// it or a goal turn notes its steps, any attempt-bound turn of that chat may end it
// as done or blocked, and the owner stops it. Every change is visible in the chat as a note
// and audited by its kind only, never with the goal's texts.
import { assistantProblem, textValue } from "./assistant-validation.js";
import { directOwnerTurn, goalChat, goalLimits, goalTurn } from "./goal-turns.js";
import { WorkGoalStore } from "./work-goal-store.js";
import { tickGoals } from "./work-goal-nudges.js";

// Each action's keys, the required ones first, and how its texts are read.
const actions = {
  set: { required: ["title", "done"], optional: ["steps"] },
  update: { required: ["steps"], optional: [] },
  done: { required: ["summary"], optional: [] },
  blocked: { required: ["reason"], optional: [] },
};
const toolRunLimit = 256;
// The goal tool itself is no progress on the goal (the no-progress brake).
export const goalToolName = "agentpier_goal";

function goalInput(input) {
  const spec =
    input &&
    typeof input === "object" &&
    Object.hasOwn(actions, input.action) &&
    actions[input.action];
  if (
    !spec ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => k !== "action" && !spec.required.includes(k) && !spec.optional.includes(k),
    )
  )
    throw assistantProblem("invalid");
  const values = {};
  for (const key of [...spec.required, ...spec.optional])
    if (spec.required.includes(key) || input[key] !== undefined)
      // Steps may be cleared; every other text says something.
      values[key] = textValue(input[key], goalLimits[key], key === "steps");
  return { action: input.action, values };
}

// Keeps the newest `toolRunLimit` ids.
function remember(set, id) {
  set.delete(id);
  set.add(id);
  if (set.size > toolRunLimit) set.delete(set.values().next().value);
}

export class WorkGoals {
  constructor({ teams, service, now = Date.now }) {
    Object.assign(this, { teams, service, now });
    this.store = new WorkGoalStore(teams);
    this.toolRuns = new Set();
    this.sentRuns = new Set();
    this.ownerCancels = new Set();
    // In memory only (work-goal-nudges.js): since when each goal's chat is idle, and
    // since when a background command holds it.
    this.idleSince = new Map();
    this.backgroundSince = new Map();
    service.assistants?.gatewayEvents?.on("agent", (p) => this.observe(p));
  }
  get assistants() {
    return this.service.assistants;
  }
  // The chat of the invocation's turn, its request and the request's context; only
  // the owner's own chats with an eligible agent hold goals.
  turn(inv) {
    if (!inv?.attemptId) throw assistantProblem("goalUnavailable", 409);
    const a = this.assistants,
      request = this.teams.ledger.getRequest(
        this.teams.ledger.getAttempt(inv.attemptId).requestId,
      ),
      conversation = a.store.getConversation(request.conversationId);
    let agent = null;
    try {
      agent = a.store.getAssistant(conversation.assistantId);
    } catch {
      /* No agent: no goal. */
    }
    if (!agent || !goalChat(agent, conversation))
      throw assistantProblem("goalUnavailable", 409);
    return { request, conversation, context: this.teams.context(request.id) };
  }
  async invoke(inv, input) {
    const { action, values } = goalInput(input);
    const { request, conversation, context } = this.turn(inv);
    if (action === "set" && !directOwnerTurn(context))
      throw assistantProblem("goalOwnerTurn", 403);
    if (action === "update" && !directOwnerTurn(context) && !goalTurn(context))
      throw assistantProblem("goalUpdateTurn", 403);
    inv.assertCurrent?.();
    const conversationId = conversation.id;
    if (action === "set") {
      const changes = [];
      const goal = this.teams.transaction(() => {
        const old = this.store.open(conversationId);
        if (old) {
          this.store.write(old, { state: "replaced", endedAt: this.now() });
          changes.push(["replaced", old]);
        }
        return this.store.insert({
          parentAssistantId: conversation.assistantId,
          conversationId,
          title: values.title,
          done: values.done,
          steps: values.steps ?? "",
          setRequestId: request.id,
          anchorRequestId: request.id,
          createdAt: this.now(),
        });
      });
      for (const [change, old] of [...changes, ["set", goal]]) this.audit(old, change);
      this.assistants.changed({ conversationId });
      return { goal: this.view(conversationId) };
    }
    const open = this.store.open(conversationId);
    if (!open) throw assistantProblem("goalNotOpen", 409);
    // A goal turn notes the steps of its own goal only, never of one set after it.
    if (
      action === "update" &&
      !directOwnerTurn(context) &&
      goalTurn(context).id !== open.id
    )
      throw assistantProblem("goalUpdateTurn", 403);
    if (action === "update") {
      this.store.write(open, { steps: values.steps });
      this.audit(open, "updated");
      this.assistants.changed({ conversationId });
    } else this.end(open, action, values);
    return { goal: this.view(conversationId) };
  }
  /** The owner's Stop: the goal ends, the turn under way runs on. */
  stop(conversationId) {
    const open = this.store.open(conversationId);
    if (open) this.end(open, "stopped", { source: "user" });
    return { goal: null };
  }
  end(
    goal,
    state,
    { reasonCode = null, summary = null, reason = null, source = "system" } = {},
  ) {
    const next = this.store.write(goal, {
      state,
      reasonCode,
      summary,
      reason,
      endedAt: this.now(),
    });
    this.audit(next, state, source);
    this.assistants.changed({ conversationId: goal.conversationId });
    return next;
  }
  view(conversationId) {
    const goal = this.store.open(conversationId);
    if (!goal) return null;
    const { id, title, done, steps, createdAt } = goal;
    return { id, title, done, steps, state: "open", createdAt };
  }
  /** The chat's notes: each goal's start and, once it ended, its end. */
  notes(conversationId) {
    return this.store.list(conversationId).flatMap((goal) => {
      const note = (phase, timestamp, extra = {}) => ({
        id: `goal:${goal.id}:${phase}`,
        role: "event",
        event: "goal",
        phase,
        title: goal.title,
        ...extra,
        timestamp,
        runId: null,
      });
      if (goal.state === "open") return [note("set", goal.createdAt)];
      const text = goal.summary ?? goal.reason;
      return [
        note("set", goal.createdAt),
        note(goal.state, goal.endedAt, {
          ...(text ? { text } : {}),
          ...(goal.reasonCode ? { reasonCode: goal.reasonCode } : {}),
        }),
      ];
    });
  }
  forget(conversationId) {
    this.store.forget(conversationId);
  }
  /**
   * Marks a run that used a tool other than the goal tool: the turn made progress.
   * The Gateway's item event names the tool; one without a name counts.
   */
  observe(payload) {
    if (
      payload?.stream !== "item" ||
      payload.data?.kind !== "tool" ||
      payload.data.name === goalToolName ||
      typeof payload.runId !== "string"
    )
      return;
    remember(this.toolRuns, payload.runId);
  }
  toolRun(runId) {
    return this.toolRuns.has(runId);
  }
  /** Marks a continuation attempt this process sent: its tool calls are watched. */
  sent(attemptId) {
    remember(this.sentRuns, attemptId);
  }
  sentRun(attemptId) {
    return this.sentRuns.has(attemptId);
  }
  /** Marks an attempt the owner cancels with the chat's stop control (routes). */
  ownerCancel(attemptId) {
    if (typeof attemptId === "string") remember(this.ownerCancels, attemptId);
  }
  ownerCancelFailed(attemptId) {
    this.ownerCancels.delete(attemptId);
  }
  ownerCancelled(attemptId) {
    return this.ownerCancels.has(attemptId);
  }
  /** One nudge pass over the open goals (work-goal-nudges.js). */
  tick() {
    return tickGoals(this);
  }
  close() {
    this.closed = true;
  }
  // Names the change and the goal, never its title, steps or texts.
  audit(goal, change, source = "system") {
    try {
      this.assistants.audit?.append({
        action: "assistant.updated",
        resourceType: "assistant",
        resourceId: goal.parentAssistantId,
        source,
        outcome: "success",
        details: {
          kind: "work-goal",
          change,
          goalId: goal.id,
          conversationId: goal.conversationId,
        },
      });
    } catch (error) {
      console.error("Work goal audit failed:", error?.message);
    }
  }
}
