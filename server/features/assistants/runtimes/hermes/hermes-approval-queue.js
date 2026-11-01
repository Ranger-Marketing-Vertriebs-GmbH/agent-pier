import { hermesError } from "./hermes-rpc-client.js";

// Hermes asks before a dangerous command (and, with AgentPier's guard plugin, before
// every command) with a request to the client, not an event:
// `approval { session_id, command, pattern_key(s), description, allow_permanent,
// allow_session, request_id, timeout_s, choices: [once, session, always, deny] }`,
// answered `{ choice }`. It withdraws one it stopped waiting for with the event
// `request.cancel { id, method, reason }` (timeout, interrupt, session close).
//
// The queue turns each into the exec approval OpenClaw's adapter produces (frame
// `exec.approval.requested`, payload `{ id, request, createdAtMs, expiresAtMs }`), so
// exec-approvals.js, its actions and the UI take it unchanged; Hermes's own fields
// ride along as `request.hermes`. Decisions: allow-once → once, deny → deny, and
// allow-session → session (Hermes allows the pattern for the rest of the session;
// OpenClaw has no such answer, so the UI decides later whether to offer it).
// Hermes's `always` is never offered: it would allow the whole pattern class (every
// "recursive delete") for good, and its allowlist lives in config.yaml, which
// AgentPier compiles. "Always allow" therefore stays AgentPier's own (allow once and
// remember the exact command, exec-decisions.js).

const defaultTimeoutS = 300;
// How many ended requests a connection remembers for history().
const keptHistory = 200;
const choices = { "allow-once": "once", "allow-session": "session", deny: "deny" };
const decisionOf = { once: "allow-once", session: "allow-session", deny: "deny" };
const statuses = { "allow-once": "allowed", "allow-session": "allowed", deny: "denied" };
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** A refusal of a call Hermes would refuse too: answered, as OpenClaw's would be. */
export const refused = (message) =>
  Object.assign(hermesError("INVALID_REQUEST"), {
    answered: true,
    remoteMessage: message,
  });

// The decisions a request offers, in OpenClaw's names.
function offered(params) {
  const listed = Array.isArray(params.choices) ? params.choices : ["once", "deny"];
  return listed
    .filter((choice) => choice !== "session" || params.allow_session !== false)
    .map((choice) => decisionOf[choice])
    .filter(Boolean);
}

export class HermesApprovalQueue {
  constructor(client, runs) {
    Object.assign(this, { client, runs });
    this.pending = new Map();
    this.ended = [];
    client.handle("approval", (params, { id }) => this.requested(String(id), params));
    client.subscribe((params) => {
      if (params?.type === "request.cancel") this.withdrawn(params.payload);
    });
    // A closed connection answers nothing more; the new one asks again.
    client.once("disconnected", () => this.pending.clear());
  }

  // Answers later: resolve() sends the owner's decision. Returns undefined so the
  // client leaves the request open.
  requested(id, params) {
    if (!id || this.pending.has(id)) return undefined;
    const sid = text(params.session_id, 200);
    const sessionKey = this.runs.keyOf(sid);
    const runId = this.runs.runOf(sid);
    const createdAtMs = Date.now();
    const timeoutS = Number.isFinite(params.timeout_s)
      ? params.timeout_s
      : defaultTimeoutS;
    const patternKeys = Array.isArray(params.pattern_keys)
      ? params.pattern_keys
          .filter((k) => typeof k === "string")
          .map((k) => k.slice(0, 120))
      : [];
    const item = {
      id,
      request: {
        command: text(params.command, 32768),
        cwd: null,
        agentId: this.runs.agentId,
        sessionKey,
        runId,
        allowedDecisions: offered(params),
        ...(params.description ? { warningText: text(params.description, 2000) } : {}),
        hermes: {
          sessionId: sid,
          requestId: text(params.request_id, 200) || null,
          patternKeys,
          description: text(params.description, 2000),
          choices: Array.isArray(params.choices) ? params.choices.slice(0, 8) : [],
          allowSession: params.allow_session === true,
          allowPermanent: params.allow_permanent === true,
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
    return undefined;
  }

  /** The pending requests, OpenClaw's exec.approval.list items. */
  list() {
    return [...this.pending.values()].map((item) => structuredClone(item));
  }

  resolve({ id, decision }) {
    const item = this.pending.get(id);
    if (!item) throw refused("unknown or expired approval id");
    if (!item.request.allowedDecisions.includes(decision))
      throw refused("decision not offered");
    if (!this.client.respond(id, { result: { choice: choices[decision] } }))
      throw hermesError();
    this.pending.delete(id);
    this.end(item, statuses[decision], decision, "owner");
    return { ok: true, id, decision };
  }

  // Hermes stopped waiting: a timeout expired it, anything else cancelled it.
  withdrawn(payload) {
    if (payload?.method !== "approval") return;
    const item = this.pending.get(String(payload.id));
    if (!item) return;
    this.pending.delete(item.id);
    const reason = text(payload.reason, 60) || "cancelled";
    this.end(item, reason === "timeout" ? "expired" : "cancelled", null, reason);
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
  }

  /** How requests of this connection ended: Hermes keeps no history to ask. */
  history() {
    return { items: this.ended.map((entry) => ({ ...entry })) };
  }

  publish(kind, event, item, payload) {
    const { sessionKey, runId } = item.request;
    this.runs.emit({ kind, sessionKey, runId, reason: null, event, payload });
  }
}
