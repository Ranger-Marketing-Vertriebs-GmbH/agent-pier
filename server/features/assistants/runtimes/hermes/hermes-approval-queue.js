import { hermesError } from "./hermes-rpc-client.js";

// Hermes asks before a dangerous command (and, with AgentPier's guard plugin, before
// every command) with an event to every connection attached to the session:
// `approval.request { kind: "approval", prompt_id, execution_generation, command,
// description, choices: [once, deny, session, always], timeout_s }`, answered with
// `approval.respond { session_id, execution_generation, prompt_id, choice }`
// (gateway/session_pending_controls.py). `approval.settled { prompt_id }` follows
// every answer, also one another viewer gave or Hermes's own timeout, and
// `approval.cancelled { request_ids, reason }` withdraws those an interrupt or
// teardown dropped. A session attached again lists what still waits (`prompts` of its
// snapshot), which reopened() asks anew. Questions of the clarify tool
// (`clarify.request`) are skipped at once (an empty answer) until AgentPier offers
// them, so the agent goes on instead of waiting out Hermes's deadline.
//
// The queue turns each into the exec approval OpenClaw's adapter produces (frame
// `exec.approval.requested`, payload `{ id, request, createdAtMs, expiresAtMs }`), so
// exec-approvals.js, its actions and the UI take it unchanged; Hermes's own fields
// ride along as `request.hermes`; `request.cwd` is the folder the agent's commands run
// in (its workspace, given by the supervisor), and while a request of a running turn
// waits that run reports the approval phase (a `progress` event whose `step` is the
// lifecycle phase `waiting-approval`, then `approval-resolved`). Decisions: allow-once → once, deny → deny, and
// allow-session → session (Hermes allows the pattern for the rest of the session;
// OpenClaw has no such answer, so the UI decides later whether to offer it).
// Hermes's `always` is never offered: it would allow the whole pattern class (every
// "recursive delete") for good, and its allowlist lives in config.yaml, which
// AgentPier compiles. "Always allow" therefore stays AgentPier's own (allow once and
// remember the exact command, exec-decisions.js).

const defaultTimeoutS = 300;
const pluginTarget = /^<[\w.-]{1,64}> \(plugin approval rule\)$/;
// How many ended requests a connection remembers for history().
const keptHistory = 200;
const choices = { "allow-once": "once", "allow-session": "session", deny: "deny" };
const decisionOf = { once: "allow-once", session: "allow-session", deny: "deny" };
const decisionOrder = ["allow-once", "allow-session", "deny"];
const statuses = { "allow-once": "allowed", "allow-session": "allowed", deny: "denied" };
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** A refusal of a call Hermes would refuse too: answered, as OpenClaw's would be. */
export const refused = (message) =>
  Object.assign(hermesError("INVALID_REQUEST"), {
    answered: true,
    remoteMessage: message,
  });

// The decisions a request offers, in OpenClaw's names and order.
function offered(listed) {
  const named = new Set(
    (Array.isArray(listed) ? listed : ["once", "deny"]).map((c) => decisionOf[c]),
  );
  return decisionOrder.filter((decision) => named.has(decision));
}

export class HermesApprovalQueue {
  constructor(client, runs, { cwd = null } = {}) {
    Object.assign(this, { client, runs });
    this.cwd = typeof cwd === "string" && cwd ? cwd : null;
    this.pending = new Map();
    this.ended = [];
    client.subscribe((params) => this.observe(params || {}));
    // A closed connection answers nothing more; the new one asks again.
    client.once("disconnected", () => this.pending.clear());
  }

  observe({ type, session_id: sid, payload, admission_id: admission }) {
    if (type === "approval.request" && payload?.kind !== "clarify")
      this.requested(sid, payload, admission);
    else if (type === "approval.settled") this.settled(payload);
    else if (type === "approval.cancelled") this.cancelled(payload);
    else if (type === "clarify.request") this.skip(sid, payload);
  }

  /** The approvals a snapshot of session `sid` lists as still waiting. */
  reopened(sid, prompts) {
    for (const prompt of Array.isArray(prompts) ? prompts : [])
      if (prompt?.kind === "approval") this.requested(sid, prompt, null);
      else if (prompt?.kind === "clarify") this.skip(sid, prompt);
  }

  requested(sessionId, params, admission) {
    const id = text(params?.prompt_id, 200);
    if (!id || this.pending.has(id)) return;
    const sid = text(sessionId, 200);
    const sessionKey = this.runs.keyOf(sid);
    const runId = this.runs.runOfAdmission(sid, admission) ?? this.runs.runOf(sid);
    const createdAtMs = Date.now();
    const timeoutS = Number.isFinite(params.timeout_s)
      ? params.timeout_s
      : defaultTimeoutS;
    const generation = Number.isSafeInteger(params.execution_generation)
      ? params.execution_generation
      : this.runs.fences(sid).generation;
    // A plugin's question (AgentPier's guard on every-command approval) names a
    // synthetic target, "<terminal> (plugin approval rule)" (tools/approval.py
    // request_tool_approval); the guard's message is the command itself.
    const plugin = pluginTarget.test(params.command || "") && !!params.description;
    const item = {
      id,
      request: {
        command: text(plugin ? params.description : params.command, 32768),
        cwd: this.cwd,
        agentId: this.runs.agentId,
        sessionKey,
        runId,
        allowedDecisions: offered(params.choices),
        ...(params.description && !plugin
          ? { warningText: text(params.description, 2000) }
          : {}),
        hermes: {
          sessionId: sid,
          promptId: id,
          executionGeneration: generation,
          description: text(params.description, 2000),
          choices: Array.isArray(params.choices) ? params.choices.slice(0, 8) : [],
        },
      },
      createdAtMs,
      expiresAtMs: createdAtMs + timeoutS * 1000,
    };
    this.pending.set(id, item);
    this.publish("approval.requested", "exec.approval.requested", item, {
      ...structuredClone(item),
      sessionKey,
    });
    this.phase(item, "waiting-approval", "approval.request");
  }

  /** The pending requests, OpenClaw's exec.approval.list items. */
  list() {
    return [...this.pending.values()].map((item) => structuredClone(item));
  }

  async resolve({ id, decision }) {
    const item = this.pending.get(id);
    if (!item) throw refused("unknown or expired approval id");
    if (!item.request.allowedDecisions.includes(decision))
      throw refused("decision not offered");
    const { sessionId, executionGeneration } = item.request.hermes;
    // Hermes announces the answer (approval.settled) before it acknowledges it.
    item.answering = true;
    let answer;
    try {
      answer = await this.client.call("approval.respond", {
        session_id: sessionId,
        execution_generation: executionGeneration,
        prompt_id: id,
        choice: choices[decision],
      });
    } finally {
      item.answering = false;
    }
    if (!this.pending.has(id)) return { ok: true, id, decision };
    this.pending.delete(id);
    // Settled before this answer: by another viewer, or Hermes stopped waiting.
    if (answer?.status !== "resolved") {
      this.end(item, "cancelled", null, "hermes");
      throw refused("unknown or expired approval id");
    }
    this.end(item, statuses[decision], decision, "owner");
    return { ok: true, id, decision };
  }

  // Settled without this connection's answer: Hermes's timeout expired it, anything
  // else (another viewer, the turn's end) withdrew it.
  settled(payload) {
    const item = this.pending.get(text(payload?.prompt_id, 200));
    if (!item || item.answering) return;
    this.pending.delete(item.id);
    const expired = Date.now() >= item.expiresAtMs;
    this.end(
      item,
      expired ? "expired" : "cancelled",
      null,
      expired ? "timeout" : "hermes",
    );
  }

  cancelled(payload) {
    const reason = text(payload?.reason, 60) || "cancelled";
    for (const id of Array.isArray(payload?.request_ids) ? payload.request_ids : []) {
      const item = this.pending.get(text(id, 200));
      if (!item) continue;
      this.pending.delete(item.id);
      this.end(item, "cancelled", null, reason);
    }
  }

  // A clarify question this connection cannot ask the owner yet: skipped at once.
  skip(sid, prompt) {
    const promptId = text(prompt?.prompt_id, 200);
    if (!promptId || !Number.isSafeInteger(prompt.execution_generation)) return;
    this.client
      .call("clarify.respond", {
        session_id: text(sid, 200),
        execution_generation: prompt.execution_generation,
        prompt_id: promptId,
        answer: "",
      })
      .catch(() => {
        /* Answered elsewhere, or Hermes stopped waiting. */
      });
  }

  end(item, status, decision, resolvedBy) {
    const ts = Date.now();
    this.ended.push({ id: item.id, status, decision, resolvedBy, ts });
    if (this.ended.length > keptHistory) this.ended.shift();
    const { sessionKey, runId } = item.request;
    this.publish("approval.resolved", "exec.approval.resolved", item, {
      id: item.id,
      decision,
      resolvedBy,
      ts,
      sessionKey,
      runId,
      request: structuredClone(item.request),
    });
    this.phase(item, "approval-resolved", "approval.settled");
  }

  /** How requests of this connection ended: Hermes keeps no history to ask. */
  history() {
    return { items: this.ended.map((entry) => ({ ...entry })) };
  }

  publish(kind, event, item, payload) {
    const { sessionKey, runId } = item.request;
    this.runs.emit({
      kind,
      sessionKey,
      runId,
      reason: null,
      reply: null,
      step: null,
      event,
      payload,
    });
  }

  // The approval phase of the run a request belongs to, while that run is under way.
  phase(item, phase, event) {
    const { sessionKey, runId } = item.request;
    if (!sessionKey || !runId || this.runs.outcomes.has(runId)) return;
    this.runs.emit({
      kind: "progress",
      sessionKey,
      runId,
      reason: null,
      reply: null,
      step: { type: "lifecycle", phase },
      event,
      payload: { id: item.id, sessionKey, runId },
    });
  }
}
