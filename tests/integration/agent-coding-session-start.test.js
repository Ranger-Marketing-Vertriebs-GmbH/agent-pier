import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { sessionContext } from "../../server/features/assistants/coding-sessions/session-turns.js";
import { startSession } from "../../server/features/assistants/coding-sessions/session-start.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { notifyAction } from "../../server/features/assistants/assistant-action-notifications.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { problem } from "../../server/lib/storage.js";

const code = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error).code;
  }
  assert.fail("expected the call to fail");
};
const start = (f, input = {}) => ({
  action: "start",
  requestId: crypto.randomUUID(),
  projectId: f.project.id,
  tool: "codex",
  ...input,
});
const action = (f, requestId) =>
  f.workflows.store.byKey(`session-start:${f.id}:${requestId}`);

// A second project folder with coding sessions on for the agent (no Git repository).
async function plainProject(f) {
  const folder = path.join(f.dataDir, "plain");
  fs.mkdirSync(folder);
  const project = await f.memory.register(folder);
  const access = f.workflows.access;
  access.save(
    f.id,
    {
      ...f.policy,
      projectIds: [f.project.id, project.id],
      sessionProjectIds: [f.project.id, project.id],
    },
    access.get(f.id).revision,
  );
  return project;
}

// Routine and hook runs as the tool bridge hands them over, with Coding on or off.
function runs(f, { coding = true } = {}) {
  const conversation = f.store.getConversation(f.channel.conversationId);
  f.assistants.routines = {
    runOrigin: () => ({
      binding: { id: "binding-1", definition: { name: "R" } },
      conversation,
    }),
    hooks: {
      runOrigin: () => ({
        hook: { id: "hook-1", name: "Zabbix" },
        event: { id: "event-1" },
        conversation,
        effective: { coding, folders: {} },
      }),
    },
  };
  const base = { toolCallId: crypto.randomUUID(), sessionKey: "run", assertCurrent() {} };
  return {
    routine: {
      ...base,
      attemptId: null,
      routine: { binding: { id: "binding-1" }, conversation: { assistantId: f.id } },
    },
    hook: {
      ...base,
      attemptId: null,
      hook: { event: { id: "event-1" }, conversation: { assistantId: f.id } },
    },
  };
}

test("an owner turn starts a session in a new worktree with the dialog defaults", async (t) => {
  const f = await agentSessionFixture(t);
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: "r1",
    projectId: f.project.id,
    tool: "codex",
  });
  assert.equal(r.state, "running");
  assert.equal(f.launches.length, 1);
  const { body, trusted } = f.launches[0];
  assert.equal(body.launchMode, "yolo");
  assert.equal(body.agentbus, true);
  assert.equal(body.agentpierTools, true);
  assert.equal(body.tool, "codex");
  assert.equal(body.name, `Codex · ${path.basename(f.project.cwd)}`);
  assert.equal("secretIds" in body, false);
  assert.equal("sshAccessIds" in body, false);
  assert.equal("nonoProfile" in body, false);
  assert.match(body.cwd, /\.agentpier-worktrees\/agent-/);
  assert.equal(trusted.id, r.sessionId);
  assert.equal(r.worktree.branch, `agentpier/agent-${r.sessionId}`);
  assert.equal(r.worktree.baseBranch, "main");
  assert.equal(r.worktree.path, body.cwd);
  assert.equal(r.cwd, body.cwd);
  assert.equal(r.tool, "codex");
  assert.deepEqual(trusted.startedBy, { kind: "agent", assistantId: f.id, name: "Home" });
  assert.equal(r.github.signedIn, false);
  // The ownership record, seen idle, and the settled action.
  const record = f.workflows.sessions.store.get(r.sessionId);
  assert.equal(record.assistantId, f.id);
  assert.equal(record.conversationId, f.channel.conversationId);
  assert.equal(record.requestId, "r1");
  assert.equal(record.actionId, r.actionId);
  assert.deepEqual(record.origin, { class: "owner" });
  assert.equal(record.worktree.branch, r.worktree.branch);
  assert.equal(record.seen.state, "idle");
  assert.equal(record.ended, false);
  const a = action(f, "r1");
  assert.equal(a.state, "running");
  assert.equal(a.sessionId, r.sessionId);
  assert.equal(a.projectName, f.project.name);
  assert.deepEqual(a.payload, {
    action: "session_start",
    projectId: f.project.id,
    requestId: "r1",
    options: { tool: "codex" },
  });
});

test("worktree: false starts in the project folder", async (t) => {
  const f = await agentSessionFixture(t);
  const r = await f.call(await f.invocation(), start(f, { worktree: false }));
  assert.equal(r.state, "running");
  assert.equal(f.launches[0].body.cwd, f.project.cwd);
  assert.equal(r.worktree, null);
  assert.equal(f.workflows.sessions.store.get(r.sessionId).worktree, null);
  assert.equal(fs.existsSync(path.join(f.project.cwd, ".agentpier-worktrees")), false);
});

test("a base branch only goes with a worktree", async (t) => {
  const f = await agentSessionFixture(t);
  assert.equal(
    await code(
      f.call(await f.invocation(), start(f, { worktree: false, baseBranch: "main" })),
    ),
    "INVALID_INPUT",
  );
  const r = await f.call(await f.invocation(), start(f, { baseBranch: "main" }));
  assert.equal(r.worktree.baseBranch, "main");
});

test("every dialog option passes through unchanged", async (t) => {
  const f = await agentSessionFixture(t);
  // A nono binary that lists one sandbox profile.
  const nono = path.join(f.dataDir, "nono");
  fs.writeFileSync(
    nono,
    "#!/bin/sh\nprintf '  Built-in:\\n    strict  Strict profile\\n'\n",
  );
  fs.chmodSync(nono, 0o755);
  f.services.nonoSandbox = { executable: () => nono };
  const options = {
    tool: "claude",
    accountId: "work-claude",
    providerConnectionId: "router",
    providerModelId: "local-model",
    name: "Fix login",
    launchMode: "default",
    worktree: false,
    secretIds: ["secret-1"],
    sshAccessIds: ["ssh-1"],
    nonoProfile: "strict",
    agentpierTools: false,
    agentbus: false,
  };
  const r = await f.call(await f.invocation(), start(f, options));
  assert.equal(r.state, "running");
  const { worktree: _w, ...passed } = options;
  assert.deepEqual(f.launches[0].body, { ...passed, cwd: f.project.cwd });
  assert.equal(r.name, "Fix login");
  assert.equal(r.accountId, "work-claude");
  // Ids the options do not list, and launch modes of another CLI, are refused.
  for (const bad of [
    { secretIds: ["secret-x"] },
    { sshAccessIds: ["ssh-x"] },
    { nonoProfile: "other" },
    { accountId: "local-codex" },
    { accountId: "local-shell" },
    { providerConnectionId: "keyless" },
    { providerModelId: "local-model" },
    { launchMode: "yolo" },
  ])
    assert.equal(
      await code(f.call(await f.invocation(), start(f, { tool: "claude", ...bad }))),
      "INVALID_INPUT",
      JSON.stringify(bad),
    );
  assert.equal(f.launches.length, 1);
});

test("the same requestId never starts a second session", async (t) => {
  const f = await agentSessionFixture(t);
  const input = start(f, { requestId: "same" });
  const first = await f.invocation(),
    second = await f.invocation();
  const [one, two] = await Promise.all([f.call(first, input), f.call(second, input)]);
  const three = await f.call(await f.invocation(), input);
  assert.equal(f.launches.length, 1);
  assert.equal(one.state, "running");
  assert.equal(two.state, "running");
  assert.equal(three.state, "running");
  assert.equal(two.sessionId, one.sessionId);
  assert.equal(three.sessionId, one.sessionId);
  assert.equal(three.actionId, one.actionId);
  assert.deepEqual(three.worktree, one.worktree);
  assert.equal(f.workflows.sessions.store.forAgent(f.id).length, 1);
});

test("the same requestId with other options conflicts", async (t) => {
  const f = await agentSessionFixture(t);
  await f.call(await f.invocation(), start(f, { requestId: "r" }));
  assert.equal(
    await code(
      f.call(await f.invocation(), start(f, { requestId: "r", launchMode: "default" })),
    ),
    "CONFLICT",
  );
  assert.equal(f.launches.length, 1);
});

test("a refused launch at 30 sessions answers SESSION_LIMIT", async (t) => {
  const f = await agentSessionFixture(t);
  f.services.launch = async () => {
    throw problem(serverMessages.sessions.sessionLimitReached, 409);
  };
  assert.equal(
    await code(f.call(await f.invocation(), start(f, { requestId: "full" }))),
    "SESSION_LIMIT",
  );
  const a = action(f, "full");
  assert.equal(a.state, "failed");
  assert.equal(a.diagnostic, "SESSION_LIMIT");
  assert.equal(a.settled, true);
  assert.deepEqual(f.workflows.sessions.store.forAgent(f.id), []);
  // A retry reads the stored outcome; the worktree made before it stays.
  const again = await f.call(await f.invocation(), start(f, { requestId: "full" }));
  assert.equal(again.state, "failed");
  assert.equal(again.diagnostic, "SESSION_LIMIT");
  assert.ok(
    fs.existsSync(
      path.join(f.project.cwd, ".agentpier-worktrees", `agent-${a.sessionId}`),
    ),
  );
});

test("a project without a git repository answers NO_REPOSITORY when a worktree is asked", async (t) => {
  const f = await agentSessionFixture(t);
  const plain = await plainProject(f);
  assert.equal(
    await code(f.call(await f.invocation(), start(f, { projectId: plain.id }))),
    "NO_REPOSITORY",
  );
  assert.equal(f.launches.length, 0);
  const r = await f.call(
    await f.invocation(),
    start(f, { projectId: plain.id, worktree: false }),
  );
  assert.equal(r.state, "running");
  assert.equal(f.launches[0].body.cwd, plain.cwd);
});

test("routine and hook runs start without approval; a lead task waits for the owner", async (t) => {
  const f = await agentSessionFixture(t);
  const inv = runs(f);
  const routine = await f.call(inv.routine, start(f));
  assert.equal(routine.state, "running");
  assert.deepEqual(f.workflows.sessions.store.get(routine.sessionId).origin, {
    class: "routine",
    bindingId: "binding-1",
  });
  const hook = await f.call(inv.hook, start(f));
  assert.equal(hook.state, "running");
  assert.deepEqual(f.workflows.sessions.store.get(hook.sessionId).origin, {
    class: "hook",
    hookId: "hook-1",
  });
  // Without its Coding tick a hook run cannot start one.
  const off = runs(f, { coding: false });
  assert.equal(await code(f.call(off.hook, start(f))), "FORBIDDEN");
  assert.equal(f.launches.length, 2);

  // A lead's task for this member: the owner approves, then the tick starts it.
  const lead = f.store.createAssistant({
    name: "Lead",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const ctx = {
    ...sessionContext(f.workflows, await f.invocation()),
    sessionClass: "team",
    leadRequest: { id: "task-1", leadId: lead.id },
  };
  const waiting = await startSession(f.workflows, ctx, start(f, { requestId: "team" }));
  assert.equal(waiting.state, "awaiting_approval");
  assert.equal(waiting.sessionId, undefined);
  assert.equal(f.launches.length, 2);
  const a = action(f, "team");
  assert.equal(a.leadAssistantId, lead.id);
  assert.equal(
    f.workflows.pending(f.id).some((p) => p.id === a.id),
    true,
  );
  await f.workflows.decide(
    a.id,
    { decision: "approve", revision: a.revision },
    {
      kind: "owner",
    },
  );
  await f.workflows.tick();
  const done = action(f, "team");
  assert.equal(done.state, "running");
  assert.equal(f.launches.length, 3);
  assert.equal(f.launches[2].trusted.id, done.sessionId);
  assert.deepEqual(f.workflows.sessions.store.get(done.sessionId).origin, {
    class: "team",
  });
  // The retry after the approval reads the running session.
  const retry = await startSession(f.workflows, ctx, start(f, { requestId: "team" }));
  assert.equal(retry.state, "running");
  assert.equal(retry.sessionId, done.sessionId);
});

test("a start on a lead's share waits for the owner", async (t) => {
  const f = await agentSessionFixture(t, { sessionProjects: false });
  const lead = f.store.createAssistant({
    name: "Lead",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const w = f.workflows;
  w.access.save(lead.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  w.shares.coding = () => ({ leadId: lead.id, shareId: "share-1", requestId: null });
  w.shares.codingProjects = () => [{ leadId: lead.id, projectId: f.project.id }];
  const r = await f.call(await f.invocation(), start(f, { requestId: "shared" }));
  assert.equal(r.state, "awaiting_approval");
  assert.equal(f.launches.length, 0);
  assert.deepEqual(action(f, "shared").inherited, {
    leadId: lead.id,
    shareId: "share-1",
  });
});

// The agent's project list (options, its instructions) names a share's project only
// where a start could rest on it: never in a turn that uses its own grant only.
test("a lead's share lists its project except in turns on the agent's own grant", async (t) => {
  const f = await agentSessionFixture(t, { sessionProjects: false });
  const lead = f.store.createAssistant({
    name: "Lead",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const w = f.workflows;
  w.access.save(lead.id, { ...f.policy, sessionProjectIds: [f.project.id] }, 0);
  w.shares.coding = () => ({ leadId: lead.id, shareId: "share-1", requestId: null });
  w.shares.codingProjects = () => [{ leadId: lead.id, projectId: f.project.id }];
  const listed = [{ projectId: f.project.id, name: f.project.name }];
  assert.deepEqual(w.sessions.projects(f.id), listed);
  const owner = sessionContext(w, await f.invocation());
  assert.deepEqual(w.sessions.projects(f.id, owner), listed);
  assert.deepEqual(
    (await w.sessions.actions.options(owner)).projects.map((p) => p.id),
    [f.project.id],
  );
  for (const turn of [{ requestedBy: { leadId: lead.id } }, { memberResult: {} }]) {
    const ctx = { ...owner, sessionClass: "team", ...turn };
    assert.deepEqual(w.sessions.projects(f.id, ctx), []);
    assert.deepEqual((await w.sessions.actions.options(ctx)).projects, []);
  }
});

test("an executing start found after a restart becomes running when its session exists", async (t) => {
  const f = await agentSessionFixture(t);
  const ctx = {
    ...sessionContext(f.workflows, await f.invocation()),
    sessionClass: "team",
  };
  await startSession(f.workflows, ctx, start(f, { requestId: "crash", worktree: false }));
  await startSession(f.workflows, ctx, start(f, { requestId: "lost", worktree: false }));
  const store = f.workflows.store;
  // The process died after launching "crash" and before launching "lost".
  const crash = store.patch(action(f, "crash").id, { state: "executing" });
  const lost = store.patch(action(f, "lost").id, { state: "unknown" });
  await f.services.launch({ tool: "codex", cwd: f.project.cwd }, false, {
    id: crash.sessionId,
  });
  await f.workflows.sessions.advanceStart(store.get(crash.id));
  const running = store.get(crash.id);
  assert.equal(running.state, "running");
  assert.equal(running.settled, true);
  const record = f.workflows.sessions.store.get(crash.sessionId);
  assert.equal(record.actionId, crash.id);
  assert.equal(record.requestId, "crash");
  // The tick settles the other one: no session, so it failed.
  await f.workflows.tick();
  const failed = store.get(lost.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.diagnostic, "START_INTERRUPTED");
  assert.equal(f.workflows.sessions.store.get(lost.sessionId), null);
  assert.equal(f.launches.length, 1);
});

test("the start is audited without the task or options text", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const r = await f.call(
    await f.invocation(),
    start(f, { requestId: "audited", name: "Secret plan for the login page" }),
  );
  const started = events.filter((e) => e.action === "session.started");
  assert.equal(started.length, 1);
  const [event] = started;
  assert.equal(event.resourceType, "session");
  assert.equal(event.source, "system");
  assert.equal(event.outcome, "success");
  assert.equal(event.sessionId, r.sessionId);
  assert.equal(event.projectId, f.project.id);
  assert.equal(event.details.tool, "codex");
  assert.deepEqual(event.details.agentSession, {
    assistantId: f.id,
    op: "start",
    requestId: "audited",
    worktree: true,
  });
  assert.equal(JSON.stringify(events).includes("Secret plan"), false);
  // Only ids and enums survive; free text and unknown operations are dropped.
  const raw = auditEvent({
    action: "session.started",
    resourceType: "session",
    source: "system",
    outcome: "success",
    details: {
      agentSession: {
        assistantId: f.id,
        op: "start",
        requestId: "has spaces and text",
        worktree: "yes",
        text: "a prompt",
      },
    },
  });
  assert.deepEqual(raw.details.agentSession, { assistantId: f.id, op: "start" });
  const unknown = auditEvent({
    action: "session.started",
    resourceType: "session",
    source: "system",
    outcome: "success",
    details: { agentSession: { assistantId: f.id, op: "launch" } },
  });
  assert.equal(unknown.details.agentSession, undefined);
});

test("the Telegram approval names the project, the CLI and the base branch", () => {
  const sent = [];
  const w = {
    s: {
      assistantChannels: {
        outbox: { all: () => [], enqueue: (entry) => sent.push(entry) },
        store: { get: () => ({ language: "en" }) },
      },
    },
  };
  notifyAction(
    w,
    {
      id: "a1",
      assistantId: "x",
      revision: 1,
      origin: { kind: "telegram", channelId: "c", chatId: "1", userId: "2" },
      projectName: "Shop",
      payload: {
        action: "session_start",
        projectId: "p",
        requestId: "r",
        options: { tool: "codex", baseBranch: "develop", name: "Hidden" },
      },
      state: "awaiting_approval",
    },
    "approval",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Shop · Codex\ndevelop$/);
  assert.equal(sent[0].text.includes("Hidden"), false);
  assert.deepEqual(
    sent[0].actions.map((a) => a.decision),
    ["approve", "decline"],
  );
});
