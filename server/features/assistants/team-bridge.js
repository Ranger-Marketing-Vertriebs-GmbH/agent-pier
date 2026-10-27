import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { writeGuardRuntimes } from "./native-capabilities.js";
import { toolError } from "./tool-errors.js";
import { guardNeeded } from "./write-guard-wait.js";
import { writeTools } from "./team-plugin/tool-guard.js";
import { flushSessionAgent } from "./memory-flushes.js";
import { flushWrite, memoryStep, noteRefusal, turnWrite } from "./memory-write-policy.js";
import { codeModeControl, memoryStepSession, stepPolicy } from "./memory-step-tools.js";
import { isMemory } from "./lead-request-writes.js";
import { auditResultWrite, resultTurn } from "./member-result-writes.js";
import * as continuation from "./exec-continuation.js";
import { confirmFromCall } from "./run-confirmation.js";
import { routineRun, routineWrite } from "./routine-run-origin.js";
import { invokeHook } from "./agent-hook-proposals.js";
import { invokeSshAccess } from "./agent-ssh-proposals.js";
import * as hooks from "./agent-hook-bridge.js";
import { lockedCall, lockedTools } from "../users/user-agent-lock.js";
import { isShared } from "../users/user-access.js";
import { agentPerson } from "./reminder-audience.js";
import { attachmentsAllowed } from "./attachment-access.js";
import { browserUploadDone } from "./agent-browser-uploads.js";
import { toolPolicy, toolPolicyRoutes } from "./bridge-tool-policies.js";
import {
  actions,
  bridgeTool,
  inheritedAction,
  memberActions,
  peerActions,
  personalActions,
  routineActions,
} from "./team-bridge-actions.js";
const active = new Set(["pending", "accepted", "running"]);
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
    // A hook's run session stays current while its event runs (agent-hook-bridge.js).
    if (record.hook) return hooks.assertHookRecord(this, record);
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
    // A command's completion run continues the turn that started it
    // (exec-continuation.js).
    if (record.continuation) return continuation.assertContinuation(this, record);
    const a = this.assistants.ledger.getAttempt(record.attemptId);
    if (!active.has(a.state) || a.reviewedAt) throw assistantProblem("invalid", 403);
    const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      ),
      parent = this.assistants.store.getAssistant(c.assistantId);
    if (
      c.runtimeSessionKey !== record.sessionKey ||
      // A memory step calls no bridge tool (memory-step-tools.js).
      memoryStep(this.teams.store?.context(a.requestId)) ||
      parent.runtimeAgentId !== record.agentId ||
      // A member's own tools: never a lead's or a personal agent's.
      (!parent.teamMemberId && memberActions.has(record.action)) ||
      // Members reach the workspace bridge (temporary ones only for coding
      // requests, enforced there); personal tools stay with permanent members,
      // apart from what a temporary member inherits from its lead (inheritedAction).
      (parent.teamMemberId &&
        !(
          record.action === "workspace" ||
          record.action === "share_file" ||
          memberActions.has(record.action) ||
          (personalActions.has(record.action) && parent.lifetime === "permanent") ||
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
        (k) =>
          !["agentId", "sessionKey", "toolCallId", "action", "runId", "exec"].includes(k),
      ) ||
      !actions.has(input.action)
    )
      throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "toolCallId"]) textValue(input[k], 512);
    // A workspace call's run and the Gateway's record (team-plugin/exec-processes.js).
    if (input.runId !== undefined && input.runId !== null) textValue(input.runId, 512);
    for (const [key, value] of this.tickets)
      if (value.expires < this.now() && (!value.promise || value.settled))
        this.tickets.delete(key);
    if (this.tickets.size >= 1000) throw assistantProblem("active", 409);
    // A call of a turn whose send went unacknowledged proves that turn runs.
    if (input.runId) confirmFromCall(this.assistants, input.sessionKey, input.runId);
    const matches = this.assistants.ledger.pending().filter((a) => {
      const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      );
      return c.runtimeSessionKey === input.sessionKey && active.has(a.state);
    });
    const issue = (bound) => {
      const record = this.valid({
        ...input,
        ...bound,
        generation: this.generation(),
        expires: this.now() + 30000,
      });
      const ticket = randomBytes(32).toString("hex");
      this.tickets.set(ticket, record);
      return { ticket };
    };
    if (matches.length === 1) return issue({ attemptId: matches[0].id });
    // A hook's run session serves only its own actions while its event runs.
    if (!matches.length && hooks.hookSession(this, input)) {
      const hook = hooks.hookActions.has(input.action) && hooks.hookRun(this, input);
      if (hook) return issue({ attemptId: null, hook });
      throw assistantProblem("invalid", 403);
    }
    if (!matches.length && routineActions.has(input.action)) {
      // Only SSH (on hosts granted "incl. routines"), shared files, project folders,
      // the lead's ask, delegate and members, and a member's own tools serve a
      // routine's run.
      const routine = this.routineRun(input);
      if (routine) return issue({ attemptId: null, routine });
      // A command's completion run; 2026.10.7's is read from the transcript first.
      const resume = (resumed) => {
        if (!resumed) throw assistantProblem("invalid", 403);
        return issue({ attemptId: null, continuation: resumed });
      };
      const resumed = continuation.continuationBinding(this, input);
      return resumed instanceof Promise ? resumed.then(resume) : resume(resumed);
    }
    throw assistantProblem("invalid", 403);
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
  // own message (a work-goal continuation counts as one), a lead's follow-up on its
  // member's result (member-result-writes.js), a routine's run (routineWrite), a hook
  // run's own memory (agent-hook-bridge.js), a memory step's own memory
  // (memory-write-policy.js) or the completion run of a command one of the first two
  // started (exec-continuation.js); forwarded, other scheduled, internal and member
  // turns never write, apart from an owner-proven task.
  toolPolicy(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) =>
          ![
            "agentId",
            "sessionKey",
            "toolName",
            "path",
            "runId",
            "exec",
            "toolKind",
          ].includes(k),
      )
    )
      throw assistantProblem("invalid");
    // OpenClaw's host-set kind of the call (`code_mode_exec` for a Code Mode cell).
    if ("toolKind" in input) textValue(input.toolKind, 512);
    // A user agent never runs a locked tool, whatever its compiled entry says: the
    // plugin asks for every call of a locked core tool (tool-guard.js lockedToolCall).
    if (lockedTools.includes(input.toolName)) {
      textValue(input.agentId, 4096);
      // A memory step runs none of them but a Code Mode cell, whose own tool calls meet
      // the step hook and this guard one by one (memory-step-tools.js codeModeControl).
      const locked = lockedCall(this.agentOf(input.agentId), input.toolName);
      const hook = hooks.hookLockedTool(this, input);
      if (hook !== null) return { allow: hook && !locked };
      return {
        allow: !locked && (codeModeControl(input) || !memoryStepSession(this, input)),
      };
    }
    if (!writeTools.includes(input.toolName)) throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "path"]) textValue(input[k], 4096);
    // The hook's run id (OpenClaw 2026.10.3 reports it); only flushes rely on it.
    if ("runId" in input) textValue(input.runId, 512);
    if (this.closed || !this.assistants.runtime.client?.ready) return { allow: false };
    const settle = (allow) => {
      if (!allow && isMemory(input.path)) noteRefusal(this, input);
      return { allow };
    };
    const allow = this.writeAllowed(input);
    return allow instanceof Promise ? allow.then(settle) : settle(allow);
  }
  // Every browser call drives the calling agent's own profile (agent-browsers.js).
  async browserPolicy(input) {
    if (this.closed || !this.assistants.browsers)
      return { allow: false, reason: "unavailable" };
    // An upload's files are checked apart (agent-browser-uploads.js).
    const { paths, ...call } = input && typeof input === "object" ? input : {};
    const policy = await this.assistants.browsers.policy(paths ? call : input);
    const upload =
      String(call.action ?? "")
        .trim()
        .toLowerCase() === "upload";
    if (policy.allow && (upload || paths !== undefined)) {
      const uploads = this.assistants.workflows?.browserUploads;
      const reason = uploads
        ? uploads.admit({ agentId: call.agentId, paths: paths ?? [] })
        : "unavailable";
      if (reason) return { allow: false, reason };
    }
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
    const { attempt, conversation } = this.callingChat(input);
    const userId =
      conversation?.userId ?? (attempt || conversation ? null : agentPerson(agent));
    live.setDriver(agent.id, userId ?? null, conversation?.id ?? null);
  }
  // The chat a call of this session works for: its bound turn's, a routine run's
  // or the session's own chat.
  callingChat(input) {
    const store = this.assistants.store;
    const [attempt] = this.bound(input.sessionKey);
    const conversation = attempt
      ? store.getConversation(
          this.assistants.ledger.getRequest(attempt.requestId).conversationId,
        )
      : (this.routineRun(input)?.conversation ??
        store.conversationOfSession(input.sessionKey));
    return { attempt, conversation };
  }
  // A file tool call naming attachments/: on a shared agent only the calling chat's
  // own uploads (attachment-access.js).
  attachmentPolicy(input) {
    if (!input || typeof input !== "object" || !Array.isArray(input.files))
      throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey"]) textValue(input[k], 4096);
    if (input.files.length > 64) throw assistantProblem("invalid");
    for (const file of input.files) textValue(file, 4096, true);
    const agent = this.agentOf(input.agentId);
    if (this.closed || !agent) return { allow: false };
    if (this.bound(input.sessionKey).length > 1) return { allow: false };
    const { conversation } = this.callingChat(input);
    const own = conversation?.assistantId === agent.id ? conversation.id : null;
    return {
      allow: attachmentsAllowed(this.assistants.store, agent, own, input.files),
    };
  }
  writeAllowed(input) {
    if (flushSessionAgent(input.sessionKey)) return flushWrite(this, input);
    const matches = this.bound(input.sessionKey);
    // A routine's own run session has no attempt: its writes are its own origin. A
    // command's completion run may continue its owner turn (exec-continuation.js).
    if (!matches.length) {
      // A hook session writes only its own memory, never once its event settled.
      if (hooks.hookSession(this, input)) return hooks.hookWrite(this, input);
      const allowed = this.routineWrite(input);
      if (!allowed) return continuation.continuationWrite(this, input);
      if (isShared(this.agentOf(input.agentId)) && isMemory(input.path)) {
        const conversationId = this.routineRun(input)?.conversation?.id;
        if (conversationId)
          this.noteShared(`${input.sessionKey}:shared-write`, conversationId);
      }
      return allowed;
    }
    if (matches.length !== 1) return false;
    const { attempt, parent, origin, current } = this.turn(matches[0], input.agentId);
    // A lead's follow-up on its member's result writes like the lead's own work.
    if (current && origin?.kind === "member-result") {
      const r = resultTurn(this.assistants, origin.requestId, attempt.id);
      if (r) auditResultWrite(this.assistants, r, input);
      return !!r;
    }
    const allowed = turnWrite(this, { attempt, parent, origin, current }, input);
    // What a memory step saved (memory-step.js MemoryStepWrites).
    if (allowed && memoryStep(origin)) this.assistants.memoryStepWrites?.note(attempt.id);
    if (allowed && isShared(parent) && isMemory(input.path))
      this.noteShared(
        `${attempt.id}:shared-write`,
        this.assistants.ledger.getRequest(attempt.requestId).conversationId,
      );
    return !!allowed;
  }
  // A saved write to a shared agent's MEMORY.md or memory/ (USER.md is the owner's,
  // tool-guard.js) applies to all its users: the writer's
  // chat (a routine's: its chat) says so once per turn or run (memory-notes.js
  // "shared-write").
  noteShared(key, conversationId) {
    const added = this.assistants.memoryNotes?.record({
      key,
      conversationId,
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
  // A routine's own run session and its writes (routine-run-origin.js).
  routineWrite(input) {
    return routineWrite(this, input);
  }
  routineRun(input) {
    return routineRun(this, input);
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
      hook: record.hook || null,
      continuation: record.continuation || null,
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
      if (action === "hook")
        return invokeHook(this.assistants.routines?.hooks, invocation, input);
      if (action === "ssh_access")
        return invokeSshAccess(this.assistants.workflows, invocation, input);
      if (action === "coding_session")
        return this.assistants.workflows.sessions.invoke(invocation, input);
      if (action === "report") return this.teams.reports.report(invocation, input);
      if (peerActions.has(action)) return this.teams.peers[action](invocation, input);
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
          "/step-policy",
          "/browser-policy",
          "/browser-upload",
          "/attachment-policy",
          "/secrets-policy",
          "/guard",
          ...Object.keys(toolPolicyRoutes),
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
          : req.url === "/step-policy"
            ? stepPolicy(this, input)
            : req.url === "/browser-policy"
              ? this.browserPolicy(input)
              : req.url === "/browser-upload"
                ? this.closed || browserUploadDone(this, input)
                : Object.hasOwn(toolPolicyRoutes, req.url)
                  ? toolPolicy(this, req.url, input)
                  : req.url === "/attachment-policy"
                    ? this.attachmentPolicy(input)
                    : req.url === "/secrets-policy"
                      ? hooks.secretsPolicy(this, input)
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
