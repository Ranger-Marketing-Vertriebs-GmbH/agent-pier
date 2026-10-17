import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  inheritsFromLead,
  personalCapabilities,
  writeGuardRuntimes,
} from "./native-capabilities.js";
import { toolError } from "./tool-errors.js";
import { guardNeeded } from "./write-guard-wait.js";
import { writeTools } from "./team-plugin/tool-guard.js";
import { flushSessionAgent } from "./memory-flushes.js";
import { flushWrite, noteRefusal } from "./memory-write-policy.js";
import { isMemory, ownMemoryTarget } from "./lead-request-writes.js";
const actions = new Set([
  "propose",
  "status",
  "stop",
  // A lead's questions and tasks for its own members; members never reach these.
  "members",
  "ask",
  "delegate",
  "cancel",
  "archive",
  "grant",
  "member_update",
  "promote",
  "reminder",
  "routine",
  "workspace",
  "ssh",
]);
const active = new Set(["pending", "accepted", "running"]);
// What a temporary member reaches through its lead: reminders (created on the lead)
// and SSH on the lead's grants, each only while it inherits them right now.
const inheritedAction = (a, action) =>
  inheritsFromLead(a) &&
  ((action === "reminder" && personalCapabilities(a).reminders) ||
    (action === "ssh" && a.inherited.ssh === true));
const leavingReady = new Set([
  "reconnecting",
  "stopping",
  "starting",
  "installing",
  "failed",
  "disabled",
]);
// Memory and browser agents on a ready Gateway without a reported guard stay
// read-only and without the browser; the runtime status says so.
export function runtimeStatus(runtime, assistants, bridge) {
  const state = runtime.status();
  const needed = assistants.store.listAssistants().some(guardNeeded);
  return bridge?.guardPending(needed) && !state.diagnostic
    ? { ...state, diagnostic: "WRITE_GUARD_PENDING" }
    : state;
}
export class TeamBridge {
  constructor({ assistants, teams, generation = () => 1, now = Date.now }) {
    Object.assign(this, { assistants, teams, generation, now });
    // Leaving ready (disconnect, restart, failure) may reload the Gateway's plugins;
    // writes wait for the guard's next periodic report.
    let previous = assistants.runtime?.status?.().availability;
    // When the Gateway last became ready: owner turns wait for the guard only
    // within a window after it (write-guard-wait.js).
    this.readyAt = previous === "ready" ? now() : null;
    assistants.runtime?.on?.("status", (state) => {
      if (previous === "ready" && leavingReady.has(state.availability)) {
        this.guard = null;
        // Applies made meanwhile compile without the guarded tools (write-guard-reapply.js).
        this.onGuardLost?.();
      }
      if (state.availability === "ready" && previous !== "ready")
        this.readyAt = this.now();
      previous = state.availability;
    });
    this.tickets = new Map();
    this.jobs = new Set();
    this.closed = true;
  }
  status() {
    return { ready: !!this.server?.listening && !this.closed };
  }
  async start() {
    if (this.server?.listening) return this.connection;
    this.closed = false;
    this.token = randomBytes(32).toString("hex");
    this.server = http.createServer((req, res) => {
      const job = this.handle(req, res);
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job));
    });
    this.server.requestTimeout = 10000;
    this.server.headersTimeout = 10000;
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    return (this.connection = {
      url: `http://127.0.0.1:${this.server.address().port}`,
      token: this.token,
    });
  }
  valid(record) {
    if (
      this.closed ||
      record.generation !== this.generation() ||
      !this.assistants.runtime.client?.ready
    )
      throw assistantProblem("unavailable", 403);
    // A routine's own run session (no attempt) stays current while its routine does.
    if (record.routine) {
      const run = this.routineRun(record);
      if (record.action !== "ssh" || run?.binding.id !== record.routine.binding.id)
        throw assistantProblem("invalid", 403);
      return record;
    }
    const a = this.assistants.ledger.getAttempt(record.attemptId);
    if (!active.has(a.state) || a.reviewedAt) throw assistantProblem("invalid", 403);
    const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      ),
      parent = this.assistants.store.getAssistant(c.assistantId);
    if (
      c.runtimeSessionKey !== record.sessionKey ||
      parent.runtimeAgentId !== record.agentId ||
      // Members reach the workspace bridge (temporary ones only for coding
      // requests, enforced there); personal tools stay with permanent members,
      // apart from what a temporary member inherits from its lead (inheritedAction).
      (parent.teamMemberId &&
        !(
          record.action === "workspace" ||
          (["reminder", "routine", "ssh"].includes(record.action) &&
            parent.lifetime === "permanent") ||
          inheritedAction(parent, record.action)
        )) ||
      parent.archivedAt
    )
      throw assistantProblem("invalid", 403);
    return record;
  }
  prepare(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["agentId", "sessionKey", "toolCallId", "action"].includes(k),
      ) ||
      !actions.has(input.action)
    )
      throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "toolCallId"]) textValue(input[k], 512);
    for (const [key, value] of this.tickets)
      if (value.expires < this.now() && (!value.promise || value.settled))
        this.tickets.delete(key);
    if (this.tickets.size >= 1000) throw assistantProblem("active", 409);
    const matches = this.assistants.ledger.pending().filter((a) => {
      const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      );
      return c.runtimeSessionKey === input.sessionKey && active.has(a.state);
    });
    let bound;
    if (matches.length === 1) bound = { attemptId: matches[0].id };
    else if (!matches.length && input.action === "ssh") {
      // Only SSH serves a routine's run: its owner granted the host "incl. routines".
      const routine = this.routineRun(input);
      if (!routine) throw assistantProblem("invalid", 403);
      bound = { attemptId: null, routine };
    } else throw assistantProblem("invalid", 403);
    const record = this.valid({
      ...input,
      ...bound,
      generation: this.generation(),
      expires: this.now() + 30000,
    });
    const ticket = randomBytes(32).toString("hex");
    this.tickets.set(ticket, record);
    return { ticket };
  }
  // The Gateway's own plugin reports its write guard once the hook is registered;
  // write/edit stay withheld until then and after every runtime restart.
  registerGuard(input) {
    if (
      !input ||
      Object.keys(input).some((k) => !["pid", "ppid", "instance"].includes(k)) ||
      ("instance" in input && !/^[a-f0-9-]{36}$/.test(input.instance)) ||
      !Number.isSafeInteger(input.pid) ||
      !Number.isSafeInteger(input.ppid)
    )
      throw assistantProblem("invalid");
    // The launcher AgentPier spawns runs the Gateway as its direct child; a CLI
    // process loading the same plugin (for example a memory re-index) never counts.
    const pid = this.assistants.runtime.child?.pid;
    if (
      this.closed ||
      !Number.isSafeInteger(pid) ||
      ![input.pid, input.ppid].includes(pid)
    )
      throw assistantProblem("invalid", 403);
    this.guard = { generation: this.generation(), instance: input.instance };
    this.assistants.changed?.();
    // The start compiled every agent without writes; the hook restores them once
    // per generation (write-guard-reapply.js), so scheduled runs can write too.
    this.onGuard?.();
    return { ok: true };
  }
  // A ready, verified runtime whose memory agents still lack a reported guard.
  guardPending(needed) {
    const state = this.assistants.runtime.status?.() || {};
    return (
      !!needed &&
      state.availability === "ready" &&
      writeGuardRuntimes.includes(state.version) &&
      !this.guardLive()
    );
  }
  guardLive() {
    return (
      !this.closed &&
      this.guard?.generation === this.generation() &&
      writeGuardRuntimes.includes(this.assistants.runtime.status?.().version)
    );
  }
  // Native write/edit calls are permitted only while the current turn is the owner's
  // own message or a routine's run (routineWrite); forwarded, other scheduled,
  // internal and member turns never write, apart from an owner-proven task.
  toolPolicy(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["agentId", "sessionKey", "toolName", "path", "runId"].includes(k),
      ) ||
      !writeTools.includes(input.toolName)
    )
      throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "path"]) textValue(input[k], 4096);
    // The hook's run id (OpenClaw 2026.10.3 reports it); only flushes rely on it.
    if ("runId" in input) textValue(input.runId, 512);
    if (this.closed || !this.assistants.runtime.client?.ready) return { allow: false };
    const allow = this.writeAllowed(input);
    if (!allow && isMemory(input.path)) noteRefusal(this, input);
    return { allow };
  }
  // Every browser call drives the calling agent's own profile (agent-browsers.js).
  browserPolicy(input) {
    if (this.closed || !this.assistants.browsers)
      return { allow: false, reason: "unavailable" };
    return this.assistants.browsers.policy(input);
  }
  writeAllowed(input) {
    if (flushSessionAgent(input.sessionKey)) return flushWrite(this, input);
    const matches = this.bound(input.sessionKey);
    // A routine's own run session has no attempt: its writes are its own origin.
    if (!matches.length) return this.routineWrite(input);
    if (matches.length !== 1) return false;
    const { attempt, parent, origin, current } = this.turn(matches[0], input.agentId);
    return (
      current &&
      (this.ownerOrigin(origin) ||
        // A task member writes its own memory in any turn it works, never the copy
        // of its lead's memory or anything else (member-memory.js).
        (inheritsFromLead(parent) &&
          ownMemoryTarget(
            this.assistants.runtime?.paths?.workspaces,
            input.agentId,
            input.path,
          )) ||
        // A task the owner asked for or approved, in exactly its own member turn.
        (origin?.kind === "lead-request" &&
          !!this.teams.requests?.mayWrite(
            origin.requestId,
            attempt.id,
            parent.id,
            input.path,
          )))
    );
  }
  // The active attempts bound to a runtime session.
  bound(sessionKey) {
    return this.assistants.ledger.pending().filter((a) => {
      const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      );
      return c.runtimeSessionKey === sessionKey && active.has(a.state);
    });
  }
  turn(attempt, agentId) {
    const request = this.assistants.ledger.getRequest(attempt.requestId),
      parent = this.assistants.store.getAssistant(
        this.assistants.store.getConversation(request.conversationId).assistantId,
      ),
      origin = this.teams.store?.context(request.id);
    const current =
      !attempt.reviewedAt && parent.runtimeAgentId === agentId && !parent.archivedAt;
    return { attempt, parent, origin, current };
  }
  ownerOrigin(origin) {
    return ["owner", "telegram"].includes(origin?.kind) && !origin.forwarded;
  }
  // A routine is standing work its owner configured for this agent: its run may
  // change the agent's own workspace like an owner turn. This origin is only the
  // run session of a bound, enabled routine of the calling agent with memory and
  // routines on; reminders, check-ins and every other session never match, and it
  // grants nothing to delegated tasks (their writes stay owner-text only).
  routineWrite(input) {
    const agent = this.assistants.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === input.agentId);
    if (!agent || agent.archivedAt) return false;
    const capabilities = personalCapabilities(agent);
    if (!capabilities.memory || !capabilities.reminders) return false;
    return !!this.assistants.routines?.runOrigin(agent, input.sessionKey);
  }
  // The run session of a bound, enabled routine of a personal agent with routines on.
  routineRun(input) {
    const agent = this.assistants.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === input.agentId);
    if (
      !agent ||
      agent.archivedAt ||
      (agent.teamMemberId && agent.lifetime !== "permanent") ||
      !personalCapabilities(agent).reminders
    )
      return null;
    return this.assistants.routines?.runOrigin(agent, input.sessionKey) || null;
  }
  invoke({ ticket, action, input, ...extra }) {
    if (Object.keys(extra).length) throw assistantProblem("invalid");
    const record = this.tickets.get(ticket);
    if (!record || record.action !== action || record.expires < this.now())
      throw assistantProblem("invalid", 403);
    const hash = createHash("sha256")
      .update(JSON.stringify({ action, input }))
      .digest("hex");
    if (record.hash && record.hash !== hash) throw assistantProblem("conflict", 409);
    if (record.promise) return record.promise;
    this.valid(record);
    record.hash = hash;
    const invocation = {
      attemptId: record.attemptId,
      toolCallId: record.toolCallId,
      // Waits (an ask) count from here, the moment the call reached AgentPier.
      startedAt: Date.now(),
      assertCurrent: () => this.valid(record),
      routine: record.routine || null,
      sessionKey: record.sessionKey,
    };
    record.invocation = invocation;
    record.promise = Promise.resolve().then(() => {
      invocation.assertCurrent();
      if (action === "ssh")
        return this.assistants.workflows.ssh.invoke(invocation, input);
      if (action === "workspace")
        return this.assistants.workflows.invoke(invocation, input);
      if (action === "routine") return this.assistants.routines.invoke(invocation, input);
      return action === "reminder"
        ? this.assistants.reminders.invoke(invocation, input)
        : this.teams[action](invocation, input);
    });
    record.promise
      .finally(() => {
        record.settled = true;
      })
      .catch(() => {});
    return record.promise;
  }
  async handle(req, res) {
    let lost = false,
      invocation = null;
    try {
      if (req.headers.origin || req.headers["sec-fetch-site"])
        throw assistantProblem("invalid", 403);
      const supplied = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${this.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw assistantProblem("invalid", 401);
      if (
        req.method !== "POST" ||
        !["/prepare", "/invoke", "/tool-policy", "/browser-policy", "/guard"].includes(
          req.url,
        )
      )
        throw assistantProblem("invalid", 404);
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 131072) throw assistantProblem("invalid", 413);
        chunks.push(chunk);
      }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw assistantProblem("invalid");
      }
      // A result the caller can no longer receive is handed back (lead-requests.js).
      res.on("close", () => {
        if (!res.writableFinished) {
          lost = true;
          invocation?.undelivered?.();
        }
      });
      const result = await (req.url === "/prepare"
        ? this.prepare(input)
        : req.url === "/tool-policy"
          ? this.toolPolicy(input)
          : req.url === "/browser-policy"
            ? this.browserPolicy(input)
            : req.url === "/guard"
              ? this.registerGuard(input)
              : this.invoke(input));
      if (req.url === "/invoke") invocation = this.tickets.get(input.ticket)?.invocation;
      if (lost) invocation?.undelivered?.();
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(result));
    } catch (error) {
      const { status, code, reason } = toolError(error);
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: code, reason }));
    }
  }
  async close() {
    this.closed = true;
    const server = this.server;
    this.server = null;
    server?.closeAllConnections();
    if (server) await new Promise((r) => server.close(r));
    await Promise.allSettled([...this.jobs]);
    this.tickets.clear();
    this.guard = null;
    this.connection = null;
  }
}
