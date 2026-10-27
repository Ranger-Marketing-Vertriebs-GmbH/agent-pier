import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { OperationsEvents } from "../../server/application/operations-events.js";

const start = async (f, input = {}) => {
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "codex",
    worktree: false,
    ...input,
  });
  assert.equal(r.state, "running");
  return r.sessionId;
};

// The operations events of the fixture's sessions, wired to the real agent sessions
// (AgentCodingSessions.controls), with one device and hook-reported activity.
function operations(t, f) {
  const sent = [];
  const states = new Map();
  const notifications = {
    status: () => ({ subscriptions: [{}] }),
    observations: new Map(),
    observation(key) {
      return this.observations.get(key);
    },
    observe(key, value) {
      this.observations.set(key, value);
    },
    notify: async (value) => sent.push(value),
  };
  const ctx = { sent, clock: 0 };
  ctx.events = new OperationsEvents({
    requests: f.services.requests,
    assistants: { workflows: f.workflows },
    audit: { append() {} },
    notifications,
    sessions: f.services.sessions,
    activity: {
      read: async (session) => ({
        state: states.get(session.id) ?? "idle",
        source: "hook",
      }),
    },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
    now: () => ctx.clock,
  });
  ctx.poll = async (sessionId, state) => {
    if (state) states.set(sessionId, state);
    ctx.clock += 2500;
    await ctx.events.poll();
  };
  ctx.request = (sessionId, id) => {
    f.addRequest(sessionId, { id, kind: "permission" });
    ctx.events.emit({
      action: "request.created",
      resourceType: "request",
      resourceId: id,
      sessionId,
      kind: "permission",
      source: "system",
      outcome: "success",
      details: { kind: "permission" },
    });
  };
  ctx.kinds = () => ctx.sent.map((n) => [n.kind, n.eventId]);
  t.after(() => ctx.events.close());
  return ctx;
}
const flush = () => new Promise(setImmediate);

// Archives the agent as the store keeps it (team-store.js, user-release.js).
function archive(f) {
  const body = { ...f.store.storedAssistant(f.id), archivedAt: new Date().toISOString() };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
}
const revocations = {
  "switching coding sessions off": (f) => {
    const access = f.workflows.access;
    access.save(f.id, { ...f.policy, sessionProjectIds: [] }, access.get(f.id).revision);
  },
  "removing the project grant": (f) => {
    const access = f.workflows.access;
    access.save(f.id, { ...f.policy, projectIds: [] }, access.get(f.id).revision);
  },
  "archiving the agent": archive,
};

for (const [name, revoke] of Object.entries(revocations))
  test(`${name} hands the session's pushes back to the owner`, async (t) => {
    const f = await agentSessionFixture(t);
    const sessionId = await start(f);
    const ops = operations(t, f);
    // Under control: the request is held, completion and waits wake the agent.
    await ops.poll(sessionId, "working");
    ops.request(sessionId, "held");
    await flush();
    await ops.poll(sessionId, "idle");
    assert.deepEqual(ops.kinds(), []);
    assert.equal(ops.events.held.has("held"), true);
    assert.equal(f.workflows.sessions.controls(sessionId), true);

    revoke(f);
    assert.equal(f.workflows.sessions.controls(sessionId), false);
    // The record stays and never ends by itself.
    assert.equal(f.workflows.sessions.store.get(sessionId).ended, false);
    await ops.poll(sessionId);
    assert.deepEqual(ops.kinds(), [["permission", "held"]]);
    f.removeRequest("held");
    // A new request notifies at once; completion and waits notify again.
    ops.request(sessionId, "fresh");
    await flush();
    assert.deepEqual(ops.kinds().at(-1), ["permission", "fresh"]);
    f.removeRequest("fresh");
    await ops.poll(sessionId, "working");
    await ops.poll(sessionId, "idle");
    assert.equal(ops.kinds().at(-1)[0], "session-completed");
    await ops.poll(sessionId, "working");
    await ops.poll(sessionId, "waiting");
    await ops.poll(sessionId);
    await ops.poll(sessionId);
    assert.equal(ops.kinds().at(-1)[0], "session-waiting");
  });

test("a startup prompt during launch is held: the record exists while the session launches", async (t) => {
  const f = await agentSessionFixture(t);
  const sessions = f.workflows.sessions;
  const ops = operations(t, f);
  const launch = f.services.launch;
  let during = null;
  f.services.launch = async (body, login, trusted) => {
    during = {
      controls: sessions.controls(trusted.id),
      record: sessions.store.get(trusted.id),
    };
    // The wake watcher must not end the record of a session that does not exist yet.
    await sessions.tick();
    const session = await launch(body, login, trusted);
    // Claude's trust prompt arrives before the launch returns.
    ops.request(trusted.id, "trust");
    await flush();
    return session;
  };
  const sessionId = await start(f);
  assert.equal(during.controls, true);
  assert.equal(during.record.pending, true);
  assert.equal(during.record.ended, false);
  assert.deepEqual(ops.kinds(), []);
  assert.equal(ops.events.held.has("trust"), true);
  const record = sessions.store.get(sessionId);
  assert.equal(record.pending, undefined);
  assert.equal(record.ended, false);
  assert.equal(record.seen.state, "idle");
  const listed = await f.call(await f.invocation(), { action: "list" });
  assert.deepEqual(
    listed.sessions.map((s) => s.sessionId),
    [sessionId],
  );
});

test("a failed launch removes its pending record", async (t) => {
  const f = await agentSessionFixture(t);
  const sessions = f.workflows.sessions;
  let id = null,
    pending = null;
  f.services.launch = async (_body, _login, trusted) => {
    id = trusted.id;
    pending = sessions.store.get(id)?.pending;
    throw Object.assign(Error("launch failed"), { status: 500 });
  };
  await assert.rejects(
    f.call(await f.invocation(), {
      action: "start",
      requestId: "broken",
      projectId: f.project.id,
      tool: "codex",
      worktree: false,
    }),
  );
  assert.equal(pending, true);
  assert.equal(sessions.store.get(id), null);
  assert.equal(sessions.controls(id), false);
  assert.deepEqual(sessions.store.forAgent(f.id), []);
});

test("projects() answers none when the shares or the project list fail", async (t) => {
  const f = await agentSessionFixture(t);
  const sessions = f.workflows.sessions;
  assert.equal(sessions.projects(f.id).length, 1);
  const shares = f.workflows.shares.codingProjects;
  f.workflows.shares.codingProjects = () => {
    throw Error("shares unreadable");
  };
  assert.deepEqual(sessions.projects(f.id), []);
  f.workflows.shares.codingProjects = shares;
  const projects = f.services.memory.projects;
  f.services.memory.projects = () => {
    throw Error("projects unreadable");
  };
  assert.deepEqual(sessions.projects(f.id), []);
  f.services.memory.projects = projects;
  assert.equal(sessions.projects(f.id).length, 1);
});
