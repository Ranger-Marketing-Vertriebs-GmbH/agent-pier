import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { personalCapabilities, writeGuardRuntimes } from "./native-capabilities.js";
import { toolError } from "./tool-errors.js";
const actions = new Set([
  "propose",
  "status",
  "stop",
  "reminder",
  "routine",
  "workspace",
]);
const active = new Set(["pending", "accepted", "running"]);
const leavingReady = new Set([
  "reconnecting",
  "stopping",
  "starting",
  "installing",
  "failed",
  "disabled",
]);
// Memory agents on a ready Gateway without a reported write guard stay read-only;
// the runtime status says so instead of failing silently.
export function runtimeStatus(runtime, assistants, bridge) {
  const state = runtime.status();
  const needed = assistants.store
    .listAssistants()
    .some((a) => personalCapabilities(a).memory);
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
    assistants.runtime?.on?.("status", (state) => {
      if (previous === "ready" && leavingReady.has(state.availability)) this.guard = null;
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
      // requests, enforced there); personal tools stay with permanent members.
      (parent.teamMemberId &&
        !(
          record.action === "workspace" ||
          (["reminder", "routine"].includes(record.action) &&
            parent.lifetime === "permanent")
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
    if (matches.length !== 1) throw assistantProblem("invalid", 403);
    const record = this.valid({
      ...input,
      attemptId: matches[0].id,
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
  // own message; forwarded, scheduled, internal and member turns never write.
  toolPolicy(input) {
    if (
      !input ||
      Object.keys(input).some(
        (k) => !["agentId", "sessionKey", "toolName", "path"].includes(k),
      ) ||
      !["write", "edit"].includes(input.toolName)
    )
      throw assistantProblem("invalid");
    for (const k of ["agentId", "sessionKey", "path"]) textValue(input[k], 4096);
    const matches = this.assistants.ledger.pending().filter((a) => {
      const c = this.assistants.store.getConversation(
        this.assistants.ledger.getRequest(a.requestId).conversationId,
      );
      return c.runtimeSessionKey === input.sessionKey && active.has(a.state);
    });
    if (matches.length !== 1 || this.closed || !this.assistants.runtime.client?.ready)
      return { allow: false };
    const attempt = matches[0],
      request = this.assistants.ledger.getRequest(attempt.requestId),
      parent = this.assistants.store.getAssistant(
        this.assistants.store.getConversation(request.conversationId).assistantId,
      ),
      origin = this.teams.store?.context(request.id);
    return {
      allow:
        !attempt.reviewedAt &&
        parent.runtimeAgentId === input.agentId &&
        !parent.archivedAt &&
        ["owner", "telegram"].includes(origin?.kind) &&
        !origin.forwarded,
    };
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
      assertCurrent: () => this.valid(record),
    };
    record.promise = Promise.resolve().then(() => {
      invocation.assertCurrent();
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
    try {
      if (req.headers.origin || req.headers["sec-fetch-site"])
        throw assistantProblem("invalid", 403);
      const supplied = Buffer.from(req.headers.authorization || ""),
        expected = Buffer.from(`Bearer ${this.token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
        throw assistantProblem("invalid", 401);
      if (
        req.method !== "POST" ||
        !["/prepare", "/invoke", "/tool-policy", "/guard"].includes(req.url)
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
      const result = await (req.url === "/prepare"
        ? this.prepare(input)
        : req.url === "/tool-policy"
          ? this.toolPolicy(input)
          : req.url === "/guard"
            ? this.registerGuard(input)
            : this.invoke(input));
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
