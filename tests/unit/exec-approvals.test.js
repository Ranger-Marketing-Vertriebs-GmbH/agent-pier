import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { AssistantActionStore } from "../../server/features/assistants/assistant-action-store.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import {
  ExecApprovals,
  execOperationKey,
} from "../../server/features/assistants/exec-approvals.js";
import { decideExec } from "../../server/features/assistants/exec-decisions.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A fake Gateway client: events go through the hub, calls are recorded and answered
// from `answers`.
function gatewayClient(answers = {}) {
  const emitter = new EventEmitter();
  return {
    ready: true,
    calls: [],
    answers,
    async call(method, params) {
      this.calls.push({ method, params });
      const answer = this.answers[method];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(params) : answer;
    },
    subscribe(listener) {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    emit: (event, payload) => emitter.emit("event", { event, payload }),
  };
}

function fixture(t, { shell = "approval", answers, retryMs = 1, retries = 5 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-approvals-"));
  const store = new AssistantStore({ dataDir });
  t.after(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: "test", modelId: "test" },
    shell,
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "agent:home:main",
  });
  const ledger = new RequestLedger(store.db);
  const contexts = new Map();
  const client = gatewayClient(answers);
  const gatewayEvents = new GatewayEventHub();
  gatewayEvents.bind(client);
  let changes = 0;
  const queued = [];
  const w = {
    s: {
      assistantChannels: {
        outbox: { all: () => queued, enqueue: (entry) => queued.push(entry) },
        store: { get: () => ({ language: "en" }) },
      },
    },
    store: new AssistantActionStore(store.db),
    a: {
      store,
      ledger,
      gatewayEvents,
      runtime: { client },
      teams: { store: { context: (id) => contexts.get(id) || { kind: "owner" } } },
      changed: () => changes++,
    },
  };
  const logged = [];
  const exec = new ExecApprovals(w, {
    log: (line) => logged.push(line),
    retryMs,
    retries,
  });
  t.after(() => exec.close());
  return {
    w,
    exec,
    agent,
    chat,
    ledger,
    contexts,
    client,
    gatewayEvents,
    logged,
    queued,
    changes: () => changes,
  };
}

const request = (agent, overrides = {}) => ({
  id: "approval-1",
  request: {
    command: "touch /tmp/x",
    cwd: "/work",
    agentId: agent.runtimeAgentId,
    sessionKey: "agent:home:main",
    runId: "run-1",
    resolvedPath: "/usr/bin/touch",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    ...overrides,
  },
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 1800000,
});

test("a request becomes an action awaiting approval in the session's conversation", async (t) => {
  const f = fixture(t);
  const payload = request(f.agent);
  f.client.emit("exec.approval.requested", payload);
  await settle();
  const [action] = f.w.store.list();
  assert.equal(action.state, "awaiting_approval");
  assert.equal(action.key, execOperationKey("approval-1"));
  assert.equal(action.assistantId, f.agent.id);
  assert.equal(action.conversationId, f.chat.id);
  assert.equal(action.expiresAt, payload.expiresAtMs);
  assert.deepEqual(action.origin, { kind: "owner" });
  assert.deepEqual(action.payload, {
    action: "exec",
    approvalId: "approval-1",
    command: "touch /tmp/x",
    cwd: "/work",
    agentId: f.agent.runtimeAgentId,
    sessionKey: "agent:home:main",
    expiresAt: payload.expiresAtMs,
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    resolvedPath: "/usr/bin/touch",
  });
  assert.equal(f.changes(), 1);
  assert.deepEqual(f.client.calls, []);
  assert.deepEqual(f.logged, []);
  // An owner origin has no Telegram target.
  assert.equal(f.queued.length, 0);
});

test("a hook run's request offers no Always allow, also not on the server", async (t) => {
  const f = fixture(t);
  // attribute() marks a hook run's request once-only (agent-hooks runOrigin).
  const telegram = { kind: "telegram", channelId: "c", chatId: "1", userId: "2" };
  const attribute = f.exec.attribute.bind(f.exec);
  f.exec.attribute = (request) => ({
    ...attribute(request),
    origin: telegram,
    onceOnly: true,
  });
  f.client.emit("exec.approval.requested", request(f.agent));
  await settle();
  const [action] = f.w.store.list();
  assert.equal(action.state, "awaiting_approval");
  assert.equal(action.payload.onceOnly, true);
  assert.equal("onceOnly" in action, false);
  // The Telegram card offers Allow once and Deny only (the web card reads the same
  // payload flag, ExecApprovalCard.jsx).
  const [notice] = f.queued;
  assert.deepEqual(
    notice.actions.map((a) => a.decision),
    ["allow-once", "deny"],
  );
  await assert.rejects(decideExec(f.w, action, "allow-always"), { status: 400 });
  assert.equal(
    f.client.calls.some((c) => c.method === "exec.approval.resolve"),
    false,
  );
});

test("withheld allow-always is recorded, and a Telegram run targets its chat", async (t) => {
  const f = fixture(t);
  const req = f.ledger.accept(f.chat.id, { clientRequestId: "tg-1", text: "Run it" });
  const attempt = f.ledger.recordAttempt(req.id, {});
  f.ledger.transition(attempt.id, "accepted", { runtimeRunId: "gateway-run" });
  const telegram = { kind: "telegram", channelId: "c", chatId: "1", userId: "2" };
  f.contexts.set(req.id, { ...telegram, inputId: "in-1" });
  f.client.emit(
    "exec.approval.requested",
    request(f.agent, { runId: "gateway-run", allowedDecisions: ["allow-once", "deny"] }),
  );
  await settle();
  const [action] = f.w.store.list();
  assert.deepEqual(action.payload.allowedDecisions, ["allow-once", "deny"]);
  assert.deepEqual(action.origin, telegram);
  assert.equal(action.attemptId, attempt.id);
  assert.deepEqual(f.logged, []);
  assert.equal(f.changes(), 1);
  const [notice] = f.queued;
  assert.equal(notice.kind, "action-approval");
  assert.deepEqual(notice.source, { ...telegram, actionId: action.id });
  // allow-always stays offered; AgentPier writes the entry itself.
  assert.deepEqual(
    notice.actions.map((a) => a.decision),
    ["allow-once", "allow-always", "deny"],
  );
});

test("an unknown agent, session or shell-less agent is denied at once", async (t) => {
  const f = fixture(t);
  const other = f.w.a.store.createAssistant({
    name: "Other",
    instructions: "",
    model: { connectionId: "test", modelId: "test" },
    shell: "approval",
  });
  const cases = [
    ["a", { agentId: "ap-unknown" }],
    ["b", { sessionKey: "agent:home:other" }],
    // A known session of another agent is not this agent's conversation.
    ["c", { agentId: other.runtimeAgentId }],
    ["d", { agentId: undefined }],
  ];
  for (const [id, overrides] of cases)
    f.client.emit("exec.approval.requested", { ...request(f.agent, overrides), id });
  await settle();
  assert.deepEqual(f.w.store.list(), []);
  assert.deepEqual(
    f.client.calls.map((c) => [c.method, c.params]),
    cases.map(([id]) => ["exec.approval.resolve", { id, decision: "deny" }]),
  );
  assert.equal(f.logged.length, 4);
  assert.ok(
    f.logged.every((line) => !line.includes("touch")),
    "no command text in logs",
  );
  assert.match(f.logged[0], /UNKNOWN_AGENT/);
  assert.match(f.logged[1], /UNKNOWN_SESSION/);

  const off = fixture(t, { shell: "off" });
  off.client.emit("exec.approval.requested", request(off.agent));
  await settle();
  assert.deepEqual(off.w.store.list(), []);
  assert.equal(off.client.calls[0].params.decision, "deny");
  assert.match(off.logged[0], /SHELL_OFF/);
});

test("a resolved event ends the action with its decision", async (t) => {
  const f = fixture(t);
  const ids = ["once", "always", "denied", "lapsed", "restart", "timed"];
  f.client.answers["approval.history"] = { items: [{ id: "timed", status: "expired" }] };
  for (const id of ids)
    f.client.emit("exec.approval.requested", {
      ...request(f.agent),
      id,
      expiresAtMs: id === "lapsed" ? Date.now() - 1 : Date.now() + 60000,
    });
  await settle();
  const resolved = [
    ["once", "allow-once", "web"],
    ["always", "allow-always", "telegram"],
    ["denied", "deny", "owner"],
    // A deny event alone does not say who denied: history decides, and without
    // a record the resolver and the expiry time do.
    ["lapsed", "deny", null],
    ["restart", "deny", "approval-scope-closed"],
    ["timed", "deny", "system"],
    ["unknown", "allow-once", "web"],
  ];
  for (const [id, decision, resolvedBy] of resolved)
    f.client.emit("exec.approval.resolved", { id, decision, resolvedBy, ts: Date.now() });
  await settle();
  const outcome = Object.fromEntries(
    f.w.store.list().map((a) => [a.payload.approvalId, [a.state, a.result?.decision]]),
  );
  assert.deepEqual(outcome, {
    once: ["completed", "allow-once"],
    always: ["completed", "allow-always"],
    denied: ["declined", "deny"],
    lapsed: ["expired", "deny"],
    restart: ["cancelled", "deny"],
    timed: ["expired", "deny"],
  });
  // A late duplicate does not reopen or change a final action.
  f.client.emit("exec.approval.resolved", { id: "denied", decision: "allow-once" });
  f.client.emit("exec.approval.requested", { ...request(f.agent), id: "denied" });
  await settle();
  const denied = f.w.store.byKey(execOperationKey("denied"));
  assert.equal(denied.state, "declined");
  assert.equal(f.w.store.list().length, 6);
});

test("duplicate requests create one action", async (t) => {
  const f = fixture(t);
  const payload = request(f.agent);
  f.client.emit("exec.approval.requested", payload);
  f.client.emit("exec.approval.requested", payload);
  await settle();
  f.client.emit("exec.approval.requested", structuredClone(payload));
  await settle();
  assert.equal(f.w.store.list().length, 1);
});

test("ready reconciles: missing requests end, unseen ones are imported", async (t) => {
  const f = fixture(t);
  for (const id of ["kept", "allowed-away", "gone"])
    f.client.emit("exec.approval.requested", { ...request(f.agent), id });
  await settle();
  const fresh = { ...request(f.agent), id: "fresh", approvalKind: "exec" };
  const stranger = {
    ...request(f.agent, { agentId: "ap-unknown" }),
    id: "stranger",
    approvalKind: "exec",
  };
  f.client.answers["exec.approval.list"] = [
    { ...request(f.agent), id: "kept", approvalKind: "exec" },
    fresh,
    fresh,
    stranger,
    { id: "plugin-1", approvalKind: "plugin", request: {} },
  ];
  f.client.answers["approval.history"] = {
    items: [{ id: "allowed-away", status: "allowed", decision: "allow-once" }],
  };
  f.gatewayEvents.ready();
  await settle();
  await f.exec.syncing;
  const states = Object.fromEntries(
    f.w.store.list().map((a) => [a.payload.approvalId, a.state]),
  );
  assert.deepEqual(states, {
    kept: "awaiting_approval",
    "allowed-away": "completed",
    gone: "expired",
    fresh: "awaiting_approval",
  });
  assert.deepEqual(
    f.client.calls
      .filter((c) => c.method === "exec.approval.resolve")
      .map((c) => c.params),
    [{ id: "stranger", decision: "deny" }],
  );
  // A second ready finds everything in place.
  f.gatewayEvents.ready();
  await settle();
  await f.exec.syncing;
  assert.equal(f.w.store.list().length, 4);
});

test("failures are logged and never reach the hub", async (t) => {
  const f = fixture(t, {
    answers: { "exec.approval.list": new Error("down") },
    retries: 0,
  });
  f.client.answers["exec.approval.resolve"] = Object.assign(Error("gone"), {
    code: "INVALID_REQUEST",
  });
  f.gatewayEvents.ready();
  await settle();
  await f.exec.syncing.catch(() => {});
  f.client.emit("exec.approval.requested", request(f.agent, { agentId: "ap-x" }));
  f.client.emit("exec.approval.requested", { id: 5 });
  f.client.emit("exec.approval.resolved", null);
  await settle();
  assert.match(f.logged[0], /RESYNC failed/);
  assert.match(f.logged.at(-1), /deny failed \(INVALID_REQUEST\)/);
  // Without a ready client the resync does nothing.
  f.client.ready = false;
  await f.exec.resync();
  assert.equal(f.logged.length, 3);
});

test("a failure before the action exists still answers the Gateway", async (t) => {
  const f = fixture(t);
  const denies = () =>
    f.client.calls
      .filter((c) => c.method === "exec.approval.resolve")
      .map((c) => c.params);
  // Attribution fails.
  const listConversations = f.w.a.store.listConversations;
  f.w.a.store.listConversations = () => {
    throw Object.assign(Error("db"), { code: "SQLITE_BUSY" });
  };
  f.client.emit("exec.approval.requested", { ...request(f.agent), id: "a" });
  await settle();
  f.w.a.store.listConversations = listConversations;
  // Storing fails.
  const reserve = f.w.store.reserve.bind(f.w.store);
  f.w.store.reserve = () => {
    throw Object.assign(Error("disk"), { status: 500 });
  };
  f.client.emit("exec.approval.requested", { ...request(f.agent), id: "b" });
  await settle();
  // Storing fails after the action exists (a concurrent duplicate): no deny.
  f.w.store.reserve = (record) => {
    reserve(record);
    throw Object.assign(Error("conflict"), { status: 409 });
  };
  f.client.emit("exec.approval.requested", { ...request(f.agent), id: "c" });
  await settle();
  assert.deepEqual(denies(), [
    { id: "a", decision: "deny" },
    { id: "b", decision: "deny" },
  ]);
  assert.deepEqual(
    f.w.store.list().map((a) => [a.payload.approvalId, a.state]),
    [["c", "awaiting_approval"]],
  );
  assert.match(f.logged[0], /a: intake failed \(SQLITE_BUSY\)/);
  assert.match(f.logged[1], /a denied: INTERNAL/);
  assert.match(f.logged[2], /b: intake failed \(500\)/);
  assert.ok(f.logged.every((line) => !line.includes("touch")));
});

test("one failing item does not stop the reconcile", async (t) => {
  const f = fixture(t);
  for (const id of ["gone-1", "gone-2"])
    f.client.emit("exec.approval.requested", { ...request(f.agent), id });
  await settle();
  const first = f.w.store.byKey(execOperationKey("gone-1"));
  const patch = f.w.store.patch.bind(f.w.store);
  f.w.store.patch = (id, values) => {
    if (id === first.id) throw Object.assign(Error("db"), { code: "SQLITE_BUSY" });
    return patch(id, values);
  };
  // The first import fails after storing; the next one still runs.
  const changed = f.w.a.changed;
  f.w.a.changed = () => {
    f.w.a.changed = changed;
    throw Error("listener");
  };
  f.client.answers["exec.approval.list"] = ["new-1", "new-2"].map((id) => ({
    ...request(f.agent),
    id,
    approvalKind: "exec",
  }));
  await f.exec.resync();
  const states = Object.fromEntries(
    f.w.store.list().map((a) => [a.payload.approvalId, a.state]),
  );
  assert.deepEqual(states, {
    "gone-1": "awaiting_approval",
    "gone-2": "expired",
    "new-1": "awaiting_approval",
    "new-2": "awaiting_approval",
  });
  assert.equal(f.logged.filter((line) => /RESYNC failed/.test(line)).length, 2);
});

test("a request ended while a resync runs is not imported again", async (t) => {
  const f = fixture(t);
  f.client.emit("exec.approval.requested", { ...request(f.agent), id: "stale" });
  await settle();
  const ended = { ...request(f.agent), id: "ended", approvalKind: "exec" };
  f.client.answers["exec.approval.list"] = () => [ended];
  // The Gateway ends the request between its list answer and the import.
  f.client.answers["approval.history"] = () => {
    f.client.emit("exec.approval.resolved", {
      id: "ended",
      decision: "deny",
      resolvedBy: "approval-scope-closed",
    });
    return { items: [] };
  };
  await f.exec.resync();
  assert.deepEqual(
    f.w.store.list().map((a) => [a.payload.approvalId, a.state]),
    [["stale", "expired"]],
  );
  assert.equal(
    f.client.calls.some((c) => c.method === "exec.approval.resolve"),
    false,
  );
});

test("a failed list is retried with backoff, a bounded number of times", async (t) => {
  const f = fixture(t, { retries: 2 });
  let failures = 1;
  f.client.answers["exec.approval.list"] = () => {
    if (failures-- > 0) throw Object.assign(Error("busy"), { code: "UNAVAILABLE" });
    return [{ ...request(f.agent), approvalKind: "exec" }];
  };
  f.gatewayEvents.ready();
  const lists = () => f.client.calls.filter((c) => c.method === "exec.approval.list");
  for (let i = 0; i < 50 && !f.w.store.list().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.w.store.list().length, 1);
  assert.equal(lists().length, 2);

  const down = fixture(t, {
    retries: 2,
    answers: { "exec.approval.list": Object.assign(Error("down"), { code: "DOWN" }) },
  });
  down.gatewayEvents.ready();
  await new Promise((resolve) => setTimeout(resolve, 100));
  // The first pass and two retries, then it waits for the next ready.
  assert.equal(
    down.client.calls.filter((c) => c.method === "exec.approval.list").length,
    3,
  );
});

test("a resync resends the deny of a request that ended here unsent", async (t) => {
  const f = fixture(t);
  for (const id of ["off", "allowed", "open"])
    f.client.emit("exec.approval.requested", { ...request(f.agent), id });
  await settle();
  const byId = (id) => f.w.store.byKey(execOperationKey(id));
  // Shell went off while the Gateway was unreachable: declined here only.
  f.w.store.patch(byId("off").id, { state: "declined", diagnostic: "SHELL_OFF" });
  f.w.store.patch(byId("allowed").id, { state: "completed" });
  f.client.answers["exec.approval.list"] = ["off", "allowed", "open"].map((id) => ({
    ...request(f.agent),
    id,
    approvalKind: "exec",
  }));
  f.gatewayEvents.ready();
  await settle();
  await f.exec.syncing;
  assert.deepEqual(
    f.client.calls
      .filter((c) => c.method === "exec.approval.resolve")
      .map((c) => c.params),
    [{ id: "off", decision: "deny" }],
  );
  assert.equal(byId("open").state, "awaiting_approval");
  assert.equal(byId("off").state, "declined");
});
