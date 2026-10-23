import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { sshOrigin } from "../../server/features/assistants/agent-ssh-origin.js";
import { memoryStepWrite } from "../../server/features/assistants/memory-write-policy.js";

const step = { kind: "memory-step" };

// The fixture's agent with memory, the plugin's write guard live and the runtime's
// workspaces where the guard sees them.
async function setup(t, { userAccess } = {}) {
  const f = await workflowFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    capabilities: { memory: true, reminders: false },
    ...(userAccess ? { userAccess } : {}),
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  const guard = await nativeWriteGuard(t, f);
  f.assistants.runtime.paths = { workspaces: guard.root };
  const prepare = (action) =>
    guard.bridge.prepare({
      agentId: guard.agentId,
      sessionKey: "session",
      toolCallId: `call-${action}`,
      action,
    });
  return { ...f, ...guard, prepare };
}

test("a memory step writes the agent's own memory and nothing else", async (t) => {
  const f = await setup(t);
  await f.invocation("step", step);
  for (const target of ["MEMORY.md", "memory/2026-10-23.md", "memory/topics/atlas.md"])
    for (const toolName of ["write", "edit"])
      assert.equal(await f.call(target, { toolName }), true, `${toolName} ${target}`);
  assert.equal(await f.call(`${f.workspace}/memory/2026-10-23.md`), true);
  for (const target of [
    "notes.md",
    "src/app.js",
    "USER.md",
    "AGENTS.md",
    "memory/notes.txt",
    "memory",
    "MEMORY.md/x.md",
    "memory/lead/MEMORY.md",
    "../other/MEMORY.md",
    `${f.dataDir}/project/README.md`,
    `${f.dataDir}/project/MEMORY.md`,
  ])
    assert.equal(await f.call(target), false, target);
  // A linked memory folder never lets the step write elsewhere.
  fs.mkdirSync(path.join(f.dataDir, "elsewhere"));
  fs.symlinkSync(path.join(f.dataDir, "elsewhere"), path.join(f.workspace, "memory"));
  assert.equal(await f.call("memory/2026-10-23.md"), false);
});

test("a memory step on a shared agent writes nothing", async (t) => {
  const f = await setup(t, {
    userAccess: {
      mode: "shared",
      members: [{ userId: "anna", level: "chat" }],
      released: [],
    },
  });
  await f.invocation("step", step);
  for (const target of ["MEMORY.md", "memory/2026-10-23.md"])
    assert.equal(await f.call(target), false, target);
  assert.equal(
    memoryStepWrite(step, {
      agent: f.store.getAssistant(f.id),
      root: f.root,
      path: "MEMORY.md",
    }),
    false,
  );
});

test("memoryStepWrite admits only the memory-step kind", async (t) => {
  const f = await setup(t);
  const target = { agent: f.store.getAssistant(f.id), root: f.root, path: "MEMORY.md" };
  assert.equal(memoryStepWrite(step, target), true);
  for (const context of [
    { kind: "memory-result" },
    { kind: "team-result" },
    { kind: "routine" },
    { kind: "Memory-Step" },
    null,
  ])
    assert.equal(memoryStepWrite(context, target), false, context?.kind);
});

test("a memory step runs no shell, session tools, SSH or project folder calls", async (t) => {
  const f = await setup(t);
  const owner = await f.invocation("owner", { kind: "owner" });
  // The owner's own turn reaches them (control).
  assert.equal(await f.tool("exec"), true);
  assert.equal(typeof f.prepare("workspace").ticket, "string");
  f.assistants.ledger.transition(owner.attemptId, "completed");

  const inv = await f.invocation("step", step);
  for (const toolName of ["exec", "process", "sessions_send", "sessions_spawn"])
    assert.equal(await f.tool(toolName), false, toolName);
  for (const action of ["workspace", "ssh", "share_file", "reminder", "routine", "ask"])
    assert.throws(() => f.prepare(action), { status: 403 }, action);
  assert.equal(sshOrigin({ context: step }).class, "refused");
  // Project memory and coding stay refused in the project folder calls themselves.
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  for (const input of [
    { action: "memory_write", projectId: f.project.id, title: "T", content: "C" },
    {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Build",
    },
  ])
    await assert.rejects(f.workflows.invoke(inv, input), { status: 403 });
  assert.equal(f.memory.list(f.project.id).total, 0);
  assert.equal(f.starts.length, 0);
});

test("a memory step shows compactly in the chat's history", async (t) => {
  const f = teamFixture(t),
    { attempt, chat } = await f.proposal({ count: 1 });
  f.assistants.ledger.transition(attempt.id, "completed");
  const sent = await f.assistants.send(
    chat.id,
    { clientRequestId: "memory-step:1", text: "Save what you must keep." },
    step,
  );
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) =>
    method === "chat.history" && input.sessionKey === chat.runtimeSessionKey
      ? {
          messages: [
            {
              role: "user",
              content: "Save what you must keep.",
              timestamp: 1,
              __openclaw: { id: "u1" },
            },
            {
              role: "assistant",
              content: "Saved.",
              timestamp: 2,
              __openclaw: { id: "a1", runId: sent.request.id },
            },
          ],
        }
      : call(method, input);
  const history = await f.assistants.history(chat.id);
  assert.deepEqual(
    history.messages.map((m) => [m.role, m.event || m.text]),
    [
      ["event", "memory-step"],
      ["assistant", "Saved."],
    ],
  );
  const visible = history.requests.find((r) => r.id === sent.request.id);
  assert.equal(visible.internal, "memory-step");
  assert.equal(visible.text, undefined);
});
