import { exact } from "../assistant-access.js";
import { assistantProblem } from "../assistant-validation.js";
import { codingSessionDefinition } from "../team-plugin/coding-session-tool.js";
import { refuseUserAgent } from "../../users/user-agent-lock.js";
import { isUserAgent } from "../../users/user-access.js";
import { AgentSessionStore } from "./session-store.js";
import { sessionContext } from "./session-turns.js";
import { sessionOptions } from "./session-options.js";
import { advanceStart, startSession } from "./session-start.js";
import { readSession, sendToSession, waitForSession } from "./session-steering.js";
import { answerPrompt, listPrompts } from "./session-requests.js";
import { removeWorktree, stopSession } from "./session-worktrees.js";
import {
  advanceEscalation,
  answerEscalation,
  answerEscalationText,
  escalatePrompt,
} from "./session-escalations.js";
import { holdsGoal, tickWakes, wakeEscalation } from "./session-wakes.js";

const toolKeys = Object.keys(
  codingSessionDefinition.coding_session.parameters.properties,
);
// What needs a project with coding sessions on; every other action works on the
// agent's existing records (session-control.js control checks their grant).
const needsProjects = new Set(["options", "start"]);
// What runs after admission instead of under it: a wait polls for up to 100 s and a
// send or an answer may wait on the terminal, which must never hold every agent's
// admission; a stop waits on the terminal and a worktree removal fetches origin.
const unlocked = new Set([
  "send",
  "read",
  "wait",
  "requests",
  "answer",
  "stop",
  "worktree_remove",
]);
// Who answered a session prompt, as the broker's events name it (requestEvent).
const answerers = new Set(["owner", "agent", "telegram"]);
const maxAnswers = 1000;

/**
 * agentpier_coding_session (AssistantWorkflows.sessions): an agent's interactive
 * coding CLI sessions on projects the owner switched coding sessions on for it.
 * The agent reaches only sessions it started itself (AgentSessionStore); the turn
 * decides the session class (session-turns.js).
 */
export class AgentCodingSessions {
  constructor(w) {
    this.w = w;
    this.store = new AgentSessionStore(w.a.store.db);
    // Starts running in this process, by action key (session-start.js runStart).
    this.starting = new Map();
    // Sessions an agent is waiting on right now (session-steering.js waitForSession).
    this.waiting = new Set();
    // Who answered each recent prompt: promptId -> { actor, sessionId, at }.
    this.answers = new Map();
    // When each session last read, by id (session-wakes.js holdsGoal).
    this.readAt = new Map();
    // Injectable for tests: the clock and the pause between wait polls.
    this.now = () => Date.now();
    this.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    // Each action: (ctx, input, inv) => result. Later actions register here.
    this.actions = {
      options: (ctx) => sessionOptions(this.w, ctx.assistantId),
      list: (ctx) => this.list(ctx),
      start: (ctx, input) => startSession(this.w, ctx, input),
      send: (ctx, input, inv) => sendToSession(this.w, ctx, input, inv),
      read: (ctx, input) => readSession(this.w, ctx, input),
      wait: (ctx, input, inv) => waitForSession(this.w, ctx, input, inv),
      requests: (ctx, input) => listPrompts(this.w, ctx, input),
      answer: (ctx, input, inv) => answerPrompt(this.w, ctx, input, inv),
      escalate: (ctx, input, inv) => escalatePrompt(this.w, ctx, input, inv),
      stop: (ctx, input, inv) => stopSession(this.w, ctx, input, inv),
      worktree_remove: (ctx, input, inv) => removeWorktree(this.w, ctx, input, inv),
    };
  }
  async invoke(inv, input) {
    const run = await this.w.a.admit(() => this.call(inv, input));
    return run();
  }
  // Admits the call; returns its result, or for an unlocked action the run itself.
  async call(inv, input) {
    exact(input, toolKeys);
    const ctx = sessionContext(this.w, inv);
    refuseUserAgent(this.w.a.store.getAssistant(ctx.assistantId));
    if (needsProjects.has(input.action) && !this.projects(ctx.assistantId).length)
      throw assistantProblem("sessionsNotEnabled", 403);
    const action = this.actions[input.action];
    if (!action) throw assistantProblem("invalid");
    if (unlocked.has(input.action)) return () => action(ctx, input, inv);
    const result = await action(ctx, input, inv);
    return () => result;
  }
  /** Starts the wake watcher (session-wakes.js), once a second besides the action tick. */
  start() {
    this.closed = false;
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 1000);
    this.timer.unref();
  }
  /**
   * A session prompt was answered or handed to the terminal (operations-events.js):
   * remembers who did, so an agent that answers too late learns it (PROMPT_ANSWERED).
   */
  requestEvent(event) {
    if (event?.outcome !== "success" || typeof event.resourceId !== "string") return;
    const actor = answerers.has(event.details?.actor) ? event.details.actor : "owner";
    this.answers.delete(event.resourceId);
    this.answers.set(event.resourceId, {
      actor,
      sessionId: event.sessionId,
      at: this.now(),
    });
    while (this.answers.size > maxAnswers)
      this.answers.delete(this.answers.keys().next().value);
  }
  /** Who answered the prompt: owner, agent or telegram; else the session itself. */
  answeredBy(promptId) {
    return this.answers.get(promptId)?.actor ?? "session";
  }
  /** One pass of the wake watcher; a pass under way is joined. */
  tick() {
    if (this.closed || this.w.a.maintenance) return Promise.resolve();
    return tickWakes(this);
  }
  /** Whether a session the chat's agent drives holds its open goal (session-wakes.js). */
  holdsGoal(conversationId) {
    return holdsGoal(this, conversationId);
  }
  /** Delivers an answered escalation's wake turn; whether it settled. */
  wakeEscalation(a) {
    return wakeEscalation(this, a);
  }
  /** The action tick of a `session_start` action (session-start.js advanceStart). */
  advanceStart(a) {
    return advanceStart(this.w, a);
  }
  /** The action tick of a `session_request` (session-escalations.js). */
  advanceEscalation(a) {
    return advanceEscalation(this.w, a);
  }
  /** Answers an escalated prompt from its Telegram chat (session-escalations.js). */
  answerEscalation(actionId, answer, origin) {
    return answerEscalation(this.w, actionId, answer, origin);
  }
  /** Whether a Telegram message replied to an escalation and was consumed by it. */
  answerEscalationText(channel, message) {
    return answerEscalationText(this.w, channel, message);
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = null;
  }
  /**
   * The projects the agent may start sessions on: its own grants with the sessions
   * switch, and standing lead shares with coding on projects the lead itself has
   * sessions on for (session-control.js sessionGrant).
   */
  projects(assistantId) {
    const w = this.w;
    let policy;
    try {
      if (isUserAgent(w.access.eligible(assistantId))) return [];
      policy = w.access.get(assistantId);
    } catch {
      return [];
    }
    const ids = new Set(
      policy.sessionProjectIds.filter((id) => policy.projectIds.includes(id)),
    );
    for (const share of w.shares.codingProjects(assistantId, {}))
      if (w.access.sessionsEnabled(share.leadId, share.projectId))
        ids.add(share.projectId);
    if (!ids.size) return [];
    return w.s.memory
      .projects()
      .projects.filter((p) => ids.has(p.id))
      .map(({ id, name }) => ({ projectId: id, name }));
  }
  /** Whether an agent controls this session now: a record that has not ended. */
  controls(sessionId) {
    const record = this.store.get(sessionId);
    return !!record && !record.ended;
  }
  // The sessions the agent started, each with its live status ("gone" once removed).
  async list(ctx) {
    const names = new Map(this.w.s.memory.projects().projects.map((p) => [p.id, p.name]));
    const sessions = [];
    for (const record of this.store.forAgent(ctx.assistantId)) {
      let session = null;
      try {
        session = await this.w.s.sessions.get(record.sessionId);
      } catch (error) {
        if (error?.status !== 404) throw error;
      }
      sessions.push({
        sessionId: record.sessionId,
        projectId: record.projectId,
        projectName: names.get(record.projectId) ?? null,
        tool: session?.tool ?? null,
        name: session?.name ?? null,
        status: session ? session.status : "gone",
        ended: record.ended,
        worktree: record.worktree
          ? {
              branch: record.worktree.branch,
              baseBranch: record.worktree.baseBranch,
              removed: record.worktree.removed === true,
            }
          : null,
        createdAt: record.createdAt,
      });
    }
    return { sessions };
  }
}
