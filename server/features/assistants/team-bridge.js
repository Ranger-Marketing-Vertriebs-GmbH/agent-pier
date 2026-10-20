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
import { directTurn, flushWrite, noteRefusal } from "./memory-write-policy.js";
import { isMemory, ownMemoryTarget } from "./lead-request-writes.js";
import { auditResultWrite, resultTurn } from "./member-result-writes.js";
import { isLeadRoutine } from "./lead-routines.js";
import { lockedCall, lockedTools } from "../users/user-agent-lock.js";
import { isShared } from "../users/user-access.js";
import { agentPerson } from "./reminder-audience.js";
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
  // Routines a lead sets up on its own permanent members (lead-routines.js).
  "member_routine",
  "promote",
  // Agency agents as member templates (team-templates.js).
  "templates",
  "reminder",
  "routine",
  "workspace",
  "ssh",
  // Every agent, members too, hands the owner files (agent-shares.js).
  "share_file",
]);
// The tool name behind a bridge action: agentpier_ssh, agentpier_team_<action>, ...
const bridgeTool = (action) =>
  ["reminder", "routine", "workspace", "ssh", "share_file"].includes(action)
    ? `agentpier_${action}`
    : `agentpier_team_${action}`;
const active = new Set(["pending", "accepted", "running"]);
// What a routine's own run session (no attempt) may call: SSH, shared files, project
// folders, and a lead's questions and tasks for its own members (routine origin,
// lead-request-store.js).
const routineActions = new Set([
  "ssh",
  "share_file",
  "members",
  "ask",
  "delegate",
  // Project folders and coding requests (workspace-calls.js routineContext).
  "workspace",
]);
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
    // Team tools and SSH are locked for user agents (user-agent-lock.js).
    if (lockedCall(this.agentOf(record.agentId), bridgeTool(record.action)))
      throw assistantProblem("invalid", 403);
    // A routine's own run session (no attempt) stays current while its routine does.
    if (record.routine) {
      const run = this.routineRun(record);
      if (
        !routineActions.has(record.action) ||
        run?.binding.id !== record.routine.binding.id
      )
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
          record.action === "share_file" ||
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
    else if (!matches.length && routineActions.has(input.action)) {
      // Only SSH (on hosts granted "incl. routines"), shared files, project folders
      // and the lead's ask, delegate and members serve a routine's run.
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
  // own message, a lead's follow-up on its member's result (member-result-writes.js)
  // or a routine's run (routineWrite); forwarded, other scheduled, internal and
  // member turns never write, apart from an owner-proven task.
  toolPolicy(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["agentId", "sessionKey", "toolName", "path", "runId"].includes(k),
      )
    )
      throw assistantProblem("invalid");
    // A user agent never runs a locked tool, whatever its compiled entry says: the
    // plugin asks for every call of a locked core tool (tool-guard.js lockedToolCall).
    if (lockedTools.includes(input.toolName)) {
      textValue(input.agentId, 4096);
      return { allow: !lockedCall(this.agentOf(input.agentId), input.toolName) };
    }
    if (!writeTools.includes(input.toolName)) throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "path"]) textValue(input[k], 4096);
    // The hook's run id (OpenClaw 2026.10.3 reports it); only flushes rely on it.
    if ("runId" in input) textValue(input.runId, 512);
    if (this.closed || !this.assistants.runtime.client?.ready) return { allow: false };
    const allow = this.writeAllowed(input);
    if (!allow && isMemory(input.path)) noteRefusal(this, input);
    return { allow };
  }
  // Every image_generate call is checked and audited (image-policy.js).
  imagePolicy(input) {
    if (this.closed || !this.assistants.imagePolicy)
      return { allow: false, reason: "unavailable" };
    return this.assistants.imagePolicy.check(input);
  }
  // Every browser call drives the calling agent's own profile (agent-browsers.js).
  async browserPolicy(input) {
    if (this.closed || !this.assistants.browsers)
      return { allow: false, reason: "unavailable" };
    const policy = await this.assistants.browsers.policy(input);
    if (policy.allow) this.noteDriver(input);
    return policy;
  }
  // The person whose work uses the browser now (browser-live-view.js): the user of
  // the calling chat or of the routine that runs, the user of her own agent for its
  // other runs, and the owner for his chats, routines and everything else.
  noteDriver(input) {
    const live = this.assistants.liveView;
    const agent = live && this.agentOf(input.agentId);
    if (!agent) return;
    const store = this.assistants.store;
    const [attempt] = this.bound(input.sessionKey);
    const conversation = attempt
      ? store.getConversation(
          this.assistants.ledger.getRequest(attempt.requestId).conversationId,
        )
      : (this.routineRun(input)?.conversation ??
        store.conversationOfSession(input.sessionKey));
    const userId =
      conversation?.userId ?? (attempt || conversation ? null : agentPerson(agent));
    live.setDriver(agent.id, userId ?? null, conversation?.id ?? null);
  }
  writeAllowed(input) {
    if (flushSessionAgent(input.sessionKey)) return flushWrite(this, input);
    const matches = this.bound(input.sessionKey);
    // A routine's own run session has no attempt: its writes are its own origin.
    if (!matches.length) return this.routineWrite(input);
    if (matches.length !== 1) return false;
    const { attempt, parent, origin, current } = this.turn(matches[0], input.agentId);
    // A lead's follow-up on its member's result writes like the lead's own work.
    if (current && origin?.kind === "member-result") {
      const r = resultTurn(this.assistants, origin.requestId, attempt.id);
      if (r) auditResultWrite(this.assistants, r, input);
      return !!r;
    }
    const allowed =
      current &&
      (directTurn(origin, parent) ||
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
          )));
    if (allowed && isShared(parent) && isMemory(input.path)) this.noteShared(attempt);
    return !!allowed;
  }
  // A saved write to a shared agent's MEMORY.md or memory/ (USER.md is the owner's,
  // tool-guard.js) applies to all its users: the writer's
  // chat says so once per turn (memory-notes.js "shared-write").
  noteShared(attempt) {
    const added = this.assistants.memoryNotes?.record({
      key: `${attempt.id}:shared-write`,
      conversationId: this.assistants.ledger.getRequest(attempt.requestId).conversationId,
      reason: "shared-write",
    });
    if (added) this.assistants.changed?.();
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
  // The agent with this runtime id, or null.
  agentOf(runtimeAgentId) {
    return (
      this.assistants.store
        .listAssistants()
        .find((a) => a.runtimeAgentId === runtimeAgentId) || null
    );
  }
  // A routine is standing work its owner configured for this agent: its run may
  // change the agent's own workspace like an owner turn. This origin is only the
  // run session of a bound, enabled routine of the calling agent with memory and
  // routines on; reminders, check-ins and every other session never match, and it
  // grants nothing to delegated tasks by itself: only a routine the owner marked
  // "May write" starts tasks that may write (lead-request-store.js).
  routineWrite(input) {
    const agent = this.assistants.store
      .listAssistants()
      .find((a) => a.runtimeAgentId === input.agentId);
    if (!agent || agent.archivedAt) return false;
    const capabilities = personalCapabilities(agent);
    if (!capabilities.memory || !capabilities.reminders) return false;
    const run = this.assistants.routines?.runOrigin(agent, input.sessionKey);
    // A lead's routine on its member writes only with the owner's "May write" or the
    // lead's autonomous team usage (lead-routines.js); the owner's own always may.
    if (run && isLeadRoutine(run.binding))
      return this.assistants.routines.writable(run.binding);
    return !!run;
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
      if (action === "share_file")
        return this.assistants.shares.invoke(invocation, input);
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
        ![
          "/prepare",
          "/invoke",
          "/tool-policy",
          "/browser-policy",
          "/image-policy",
          "/guard",
        ].includes(req.url)
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
            : req.url === "/image-policy"
              ? this.imagePolicy(input)
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
