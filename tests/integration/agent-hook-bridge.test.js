import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
} from "../helpers/agent-hook-fixture.js";
import { ExecApprovals } from "../../server/features/assistants/exec-approvals.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { workspaceId } from "../../server/features/assistants/team-plugin/tool-guard.js";

// The hook fixture with the agent's capabilities and shell level, its own workspace
// on disk and a started tool bridge. `run(hook, id)` delivers one event and returns
// it running with the cron session key of its run.
async function setup(t, { memory = false, shell } = {}) {
  const f = hookFixture(t);
  const revision = () => f.store.getAssistant(f.id).revision;
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory, reminders: true } },
    revision(),
  );
  if (shell) f.store.updateAssistant(f.id, { shell }, revision());
  const workspaces = path.join(f.dataDir, "workspaces");
  fs.mkdirSync(path.join(workspaces, workspaceId(f.runtimeAgentId)), {
    recursive: true,
  });
  f.assistants.runtime.paths = { workspaces };
  const invoked = [];
  f.assistants.workflows.invoke = async (invocation) => {
    invoked.push(invocation);
    return { ok: true };
  };
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: { store: { context: () => null } },
  });
  await bridge.start();
  t.after(() => bridge.close());
  const run = async (hook, id) => {
    await f.hooks.deliver(hook, body(JSON.stringify({ id })));
    const running = event(f, hook, id);
    assert.equal(running.status, "running");
    return {
      ...running,
      sessionKey: `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`,
    };
  };
  const prepare = (sessionKey, action) =>
    bridge.prepare({
      agentId: f.runtimeAgentId,
      sessionKey,
      toolCallId: `call-${action}`,
      action,
    });
  const policy = (sessionKey, toolName, extra = {}) =>
    bridge.toolPolicy({ agentId: f.runtimeAgentId, sessionKey, toolName, ...extra })
      .allow;
  const write = (sessionKey, file, toolName = "write") =>
    policy(sessionKey, toolName, { path: file });
  return { ...f, bridge, run, prepare, policy, write, invoked, revision };
}
const refused = { status: 403 };

test("a running hook event may prepare workspace and ssh calls only", async (t) => {
  const f = await setup(t);
  const running = await f.run(makeHook(f), "p1");
  for (const action of ["workspace", "ssh"]) {
    const { ticket } = f.prepare(running.sessionKey, action);
    assert.match(ticket, /^[a-f0-9]{64}$/);
    const record = f.bridge.tickets.get(ticket);
    assert.equal(record.attemptId, null);
    assert.equal(record.hook.event.id, running.id);
    assert.equal(record.routine, undefined);
  }
  // Scheduling, shares, goals and every team tool (a lead's ask, delegate and
  // members, a member's report) are refused.
  for (const action of [
    "routine",
    "reminder",
    "share_file",
    "goal",
    "ask",
    "delegate",
    "members",
    "report",
  ])
    assert.throws(() => f.prepare(running.sessionKey, action), refused, action);
  // The invocation carries the hook origin for the workspace bridge (Task 8).
  const { ticket } = f.prepare(running.sessionKey, "workspace");
  await f.bridge.invoke({ ticket, action: "workspace", input: { action: "catalog" } });
  assert.equal(f.invoked.length, 1);
  assert.equal(f.invoked[0].hook.event.id, running.id);
  assert.equal(f.invoked[0].hook.hook.id, running.hookId);
  assert.equal(f.invoked[0].routine, null);
  assert.equal(f.invoked[0].attemptId, null);
});

test("hook origin ends when the event settles", async (t) => {
  const f = await setup(t, { memory: true, shell: "full" });
  const hook = makeHook(f, { rights: { memory: true, shell: "full" } });
  const running = await f.run(hook, "p1");
  const { ticket } = f.prepare(running.sessionKey, "workspace");
  assert.equal(f.write(running.sessionKey, "MEMORY.md"), true);
  assert.equal(f.policy(running.sessionKey, "exec"), true);
  await f.hooks.runs.complete(running.id, done(running.jobId));
  assert.equal(event(f, hook, "p1").status, "done");
  // Its job is gone, the session stays a hook session: the ticket and every new
  // call of it are refused.
  assert.equal(f.jobs.has(running.jobId), false);
  assert.throws(
    () => f.bridge.invoke({ ticket, action: "workspace", input: { action: "catalog" } }),
    refused,
  );
  assert.equal(f.invoked.length, 0);
  for (const action of ["workspace", "ssh", "share_file"])
    assert.throws(() => f.prepare(running.sessionKey, action), refused, action);
  // An exec completion turn in that session (OpenClaw 2026.10.7) gets no hook
  // rights: no writes, no shell; session_status stays.
  assert.equal(f.write(running.sessionKey, "MEMORY.md"), false);
  assert.equal(f.write(running.sessionKey, "memory/2026-10-24.md", "edit"), false);
  assert.equal(f.policy(running.sessionKey, "exec"), false);
  assert.equal(f.policy(running.sessionKey, "process"), false);
  assert.equal(f.policy(running.sessionKey, "session_status"), true);
});

test("memory writes need the Write memory tick and stay inside memory", async (t) => {
  const f = await setup(t, { memory: true });
  const plain = await f.run(makeHook(f, { name: "Plain" }), "p1");
  assert.equal(f.write(plain.sessionKey, "MEMORY.md"), false);
  assert.equal(f.write(plain.sessionKey, "memory/2026-10-24.md"), false);
  const hook = makeHook(f, { name: "Writer", rights: { memory: true } });
  const writer = await f.run(hook, "p2");
  assert.equal(f.write(writer.sessionKey, "MEMORY.md"), true);
  assert.equal(f.write(writer.sessionKey, "memory/2026-10-24.md"), true);
  assert.equal(f.write(writer.sessionKey, "memory/2026-10-24.md", "edit"), true);
  for (const file of [
    "notes.md",
    "../x",
    "memory/../notes.md",
    "USER.md",
    "memory/lead/MEMORY.md",
    "memory/notes.txt",
  ])
    assert.equal(f.write(writer.sessionKey, file), false, file);
  // Allowed writes are audited as the hook's, with path and tool, never content.
  const writes = f.audits.filter((a) => a.details.kind === "native-write");
  assert.equal(writes.length, 3);
  assert.deepEqual(writes[0].details, {
    kind: "native-write",
    tool: "write",
    filePath: "MEMORY.md",
    via: "hook",
    hookId: hook.id,
    hookEventId: writer.id,
  });
  assert.equal(writes[0].action, "assistant.updated");
  assert.equal(writes[0].resourceId, f.id);
  // The agent's memory switched off caps the tick live.
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: false, reminders: true } },
    f.revision(),
  );
  assert.equal(f.write(writer.sessionKey, "MEMORY.md"), false);
});

test("exec in a hook run follows the hook's shell level", async (t) => {
  const f = await setup(t, { shell: "full" });
  const off = await f.run(makeHook(f, { name: "Off" }), "p1");
  const full = await f.run(
    makeHook(f, { name: "Full", rights: { shell: "full" } }),
    "p2",
  );
  for (const tool of ["exec", "process"]) {
    assert.equal(f.policy(off.sessionKey, tool), false, tool);
    assert.equal(f.policy(full.sessionKey, tool), true, tool);
  }
  // Session tools other than session_status never serve a hook run.
  for (const tool of ["sessions_list", "sessions_history", "sessions_send"])
    assert.equal(f.policy(full.sessionKey, tool), false, tool);
  assert.equal(f.policy(off.sessionKey, "session_status"), true);
  // The agent lowered to Off: the running hook loses its shell at once.
  f.store.updateAssistant(f.id, { shell: "off" }, f.revision());
  assert.equal(f.policy(full.sessionKey, "exec"), false);
  // The owner's own chat session is untouched by hooks.
  f.store.updateAssistant(f.id, { shell: "full" }, f.revision());
  assert.equal(f.policy("session", "exec"), true);
});

test("a hook run's exec approval asks in the agent's main chat", async (t) => {
  const f = await setup(t, { shell: "approval" });
  const approvals = new ExecApprovals({ a: f.assistants });
  const main = f.reminders.mainConversation(f.id);
  const plain = await f.run(
    makeHook(f, { name: "Plain", rights: { shell: "approval" } }),
    "p1",
  );
  const request = (sessionKey) => ({ agentId: f.runtimeAgentId, sessionKey });
  assert.deepEqual(approvals.attribute(request(plain.sessionKey)), {
    assistantId: f.id,
    conversationId: main.id,
    origin: { kind: "owner" },
  });
  const hook = makeHook(f, {
    name: "Telegram",
    rights: { shell: "approval", telegram: true },
  });
  const telegram = await f.run(hook, "p2");
  assert.deepEqual(approvals.attribute(request(telegram.sessionKey)), {
    assistantId: f.id,
    conversationId: main.id,
    origin: {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: f.channel.chatId,
      userId: f.channel.userId,
    },
  });
  // The pairing gone: the live telegram right is gone, the approval asks in the web.
  f.service.store.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  assert.deepEqual(approvals.attribute(request(telegram.sessionKey)).origin, {
    kind: "owner",
  });
  // A settled event's session is no longer attributed.
  await f.hooks.runs.complete(plain.id, done(plain.jobId));
  assert.deepEqual(approvals.attribute(request(plain.sessionKey)), {
    reason: "UNKNOWN_SESSION",
  });
});

test("a routine run is unaffected", async (t) => {
  const f = await setup(t, { memory: true, shell: "full" });
  const routine = await f.routines.create(f.id, f.input);
  const binding = f.reminders.bindings.get(routine.id);
  const sessionKey = `agent:${f.runtimeAgentId}:cron:${binding.nativeId}:run:r1`;
  const { ticket } = f.prepare(sessionKey, "workspace");
  const record = f.bridge.tickets.get(ticket);
  assert.equal(record.routine.binding.id, binding.id);
  assert.equal(record.hook, undefined);
  await f.bridge.invoke({ ticket, action: "workspace", input: { action: "catalog" } });
  assert.equal(f.invoked[0].routine.binding.id, binding.id);
  assert.equal(f.invoked[0].hook, null);
  // A routine writes its workspace and runs the agent's shell as before.
  assert.equal(f.write(sessionKey, "notes.md"), true);
  assert.equal(f.write(sessionKey, "memory/2026-10-24.md"), true);
  assert.equal(f.policy(sessionKey, "exec"), true);
  assert.equal(f.policy(sessionKey, "sessions_list"), true);
});
