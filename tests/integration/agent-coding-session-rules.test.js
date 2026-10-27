import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { sessionContext } from "../../server/features/assistants/coding-sessions/session-turns.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected the call to fail");
};

// A session the agent `assistantId` started, with its ownership record.
async function started(f, assistantId = f.id, sessionId = crypto.randomUUID()) {
  await f.services.launch({ tool: "codex", cwd: f.cwd }, false, {
    id: sessionId,
    startedBy: { kind: "agent", assistantId, name: "Agent" },
  });
  return f.workflows.sessions.store.insert({
    sessionId,
    assistantId,
    conversationId: f.channel.conversationId,
    projectId: f.project.id,
    actionId: null,
    requestId: null,
    origin: { class: "owner" },
    inherited: null,
    worktree: null,
    seen: { state: "idle", at: 0 },
    observed: null,
    lastSentAt: null,
    wakeSeq: 0,
    ended: false,
    createdAt: Date.now(),
  });
}

test("options lists launchable accounts, defaults and only enabled projects", async (t) => {
  const f = await agentSessionFixture(t);
  // A second granted project without the sessions switch stays out.
  const other = path.join(f.dataDir, "other");
  fs.mkdirSync(other);
  const second = await f.memory.register(other);
  const access = f.workflows.access;
  access.save(
    f.id,
    {
      ...f.policy,
      projectIds: [f.project.id, second.id],
      sessionProjectIds: [f.project.id],
    },
    access.get(f.id).revision,
  );
  const r = await f.call(await f.invocation(), { action: "options" });
  assert.deepEqual(
    r.projects.map((p) => p.id),
    [f.project.id],
  );
  assert.equal(r.projects[0].worktreeDefault, true);
  assert.deepEqual(r.defaults, {
    launchMode: { codex: "yolo", claude: "auto", opencode: "auto" },
    agentbus: true,
    agentpierTools: true,
  });
  assert.deepEqual(r.launchModes, {
    codex: ["default", "yolo"],
    claude: ["default", "auto", "bypass"],
    opencode: ["default", "auto"],
  });
  assert.equal(
    r.accounts.some((a) => a.tool === "shell"),
    false,
  );
  assert.ok(r.accounts.some((a) => a.id === "work-claude" && a.tool === "claude"));
  assert.deepEqual(
    r.connections.map((c) => c.id),
    ["router"],
  );
  assert.deepEqual(r.connections[0].models, ["local-model"]);
  assert.deepEqual(r.secrets, [{ id: "secret-1", name: "Token" }]);
  assert.deepEqual(r.sshAccesses, [{ id: "ssh-1", name: "Box" }]);
  assert.deepEqual(r.sandboxProfiles, []);
});

test("options leaves out a connection without tools instead of failing", async (t) => {
  const f = await agentSessionFixture(t);
  const list = f.services.providerConnections.list;
  f.services.providerConnections.list = () => [
    { id: "bare", name: "Bare", providerId: "endpoint", launchable: true },
    ...list(),
  ];
  const r = await f.call(await f.invocation(), { action: "options" });
  assert.deepEqual(
    r.connections.map((c) => c.id),
    ["router"],
  );
});

test("without enabled projects the tool answers SESSIONS_NOT_ENABLED", async (t) => {
  const f = await agentSessionFixture(t, { sessionProjects: false });
  assert.equal(
    await code(f.call(await f.invocation(), { action: "options" })),
    "SESSIONS_NOT_ENABLED",
  );
  assert.equal(
    await code(
      f.call(await f.invocation(), {
        action: "start",
        projectId: f.project.id,
        tool: "codex",
      }),
    ),
    "SESSIONS_NOT_ENABLED",
  );
  // Listing what it started stays possible.
  assert.deepEqual(await f.call(await f.invocation(), { action: "list" }), {
    sessions: [],
  });
});

test("forwarded, user and command-completion turns are refused", async (t) => {
  const f = await agentSessionFixture(t);
  for (const origin of [
    { kind: "telegram", forwarded: true },
    { kind: "owner", forwarded: true },
    { kind: "user", userId: "u1" },
  ]) {
    const error = await f
      .call(await f.invocation(undefined, origin), { action: "options" })
      .then(
        () => null,
        (e) => e,
      );
    assert.equal(error?.status, 403, JSON.stringify(origin));
    assert.equal(toolError(error).code, "FORBIDDEN");
  }
  const owner = await f.invocation();
  const continuation = {
    attemptId: null,
    toolCallId: "c",
    continuation: { attemptId: owner.attemptId },
    assertCurrent() {},
  };
  await assert.rejects(f.call(continuation, { action: "options" }), { status: 403 });
});

test("turn classes: owner, Telegram owner and wake turns", async (t) => {
  const f = await agentSessionFixture(t);
  const w = f.workflows;
  assert.equal(sessionContext(w, await f.invocation()).sessionClass, "owner");
  assert.equal(
    sessionContext(w, await f.invocation(undefined, { kind: "telegram" })).sessionClass,
    "owner",
  );
  const record = await started(f);
  w.sessions.store.patch(record.sessionId, { origin: { class: "routine" } });
  const wake = sessionContext(
    w,
    await f.invocation(undefined, {
      kind: "coding-session",
      sessionId: record.sessionId,
    }),
  );
  assert.equal(wake.sessionClass, "routine");
  assert.deepEqual(wake.wake, { sessionId: record.sessionId });
  assert.equal(wake.assistantId, f.id);
});

test("a wake turn for another agent's session is refused", async (t) => {
  const f = await agentSessionFixture(t);
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const record = await started(f, other.id);
  const inv = await f.invocation(undefined, {
    kind: "coding-session",
    sessionId: record.sessionId,
  });
  assert.throws(() => sessionContext(f.workflows, inv), { status: 403 });
});

test("list shows only the agent's own sessions", async (t) => {
  const f = await agentSessionFixture(t);
  const own = await started(f);
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const foreign = await started(f, other.id);
  // The owner's own session, without any record.
  await f.services.launch({ tool: "claude", cwd: f.cwd }, false, { id: "owner-session" });
  const r = await f.call(await f.invocation(), { action: "list" });
  assert.deepEqual(
    r.sessions.map((s) => s.sessionId),
    [own.sessionId],
  );
  assert.equal(r.sessions[0].projectId, f.project.id);
  assert.equal(r.sessions[0].status, "running");
  assert.ok(!JSON.stringify(r).includes(foreign.sessionId));
  assert.ok(!JSON.stringify(r).includes("owner-session"));
});

test("control answers NOT_FOUND for a session the agent did not start", async (t) => {
  const f = await agentSessionFixture(t);
  const { control } =
    await import("../../server/features/assistants/coding-sessions/session-control.js");
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const foreign = await started(f, other.id);
  await f.services.launch({ tool: "claude", cwd: f.cwd }, false, { id: "owner-session" });
  for (const id of [foreign.sessionId, "owner-session", "missing"])
    assert.equal(await code(control(f.workflows, f.id, id)), "NOT_FOUND", id);
  // Its own session resolves while it exists.
  const own = await started(f);
  const { record, session } = await control(f.workflows, f.id, own.sessionId);
  assert.equal(record.sessionId, own.sessionId);
  assert.equal(session.id, own.sessionId);
  // A session that is gone answers NOT_FOUND as well.
  f.sessions.delete(own.sessionId);
  assert.equal(await code(control(f.workflows, f.id, own.sessionId)), "NOT_FOUND");
});

test("control answers GRANT_REVOKED once the sessions switch is gone", async (t) => {
  const f = await agentSessionFixture(t);
  const { control } =
    await import("../../server/features/assistants/coding-sessions/session-control.js");
  const own = await started(f);
  const access = f.workflows.access;
  access.save(f.id, { ...f.policy, sessionProjectIds: [] }, access.get(f.id).revision);
  assert.equal(await code(control(f.workflows, f.id, own.sessionId)), "GRANT_REVOKED");
});

test("the ownership store keeps records per agent", async (t) => {
  const f = await agentSessionFixture(t);
  const store = f.workflows.sessions.store;
  const record = await started(f);
  assert.deepEqual(store.get(record.sessionId), record);
  assert.equal(store.get("missing"), null);
  assert.deepEqual(
    store.forAgent(f.id).map((r) => r.sessionId),
    [record.sessionId],
  );
  assert.equal(store.all().length, 1);
  const patched = store.patch(record.sessionId, { ended: true, wakeSeq: 2 });
  assert.equal(patched.ended, true);
  assert.equal(store.get(record.sessionId).wakeSeq, 2);
  assert.equal(f.workflows.sessions.controls(record.sessionId), false);
  const live = await started(f);
  assert.equal(f.workflows.sessions.controls(live.sessionId), true);
  assert.equal(f.workflows.sessions.controls("missing"), false);
});

test("a user agent is refused with USER_AGENT_LOCKED", async (t) => {
  const f = await agentSessionFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  for (const action of ["options", "list"])
    assert.equal(
      await code(f.call(await f.invocation(), { action })),
      "USER_AGENT_LOCKED",
      action,
    );
});
