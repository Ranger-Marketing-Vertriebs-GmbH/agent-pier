import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { MemoryStepWrites } from "../../server/features/assistants/memory-step.js";

// AGENTPIER-250: in OpenClaw Code Mode the model sees only `exec` (a JavaScript cell,
// hook `toolKind: "code_mode_exec"`) and `wait`; every other tool, the memory step's
// write and edit included, is called from the cell. The memory step must admit the
// cell through every hook the team plugin registers, not only the step hook.

const step = { kind: "memory-step" };

// The fixture's agent with memory, every plugin hook registered against a real
// TeamBridge, and the runtime's workspaces where the guard sees them.
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
  f.assistants.memoryStepWrites = new MemoryStepWrites();
  const guard = await nativeWriteGuard(t, f);
  f.assistants.runtime.paths = { workspaces: guard.root };
  const ctx = { agentId: guard.agentId, sessionKey: "session" };
  // Every before_tool_call hook the Gateway would run for the call: true when none
  // blocks it.
  const passes = async (event, context = ctx) =>
    !(await guard.emit("before_tool_call", { params: {}, ...event }, context)).some(
      (result) => result?.block,
    );
  return { ...f, ...guard, ctx, passes };
}

const cell = { toolName: "exec", toolKind: "code_mode_exec", params: { code: "1" } };

test("a memory step admits a Code Mode cell through every plugin hook, and no shell", async (t) => {
  const f = await setup(t);
  await f.invocation("step", step);
  assert.equal(await f.passes(cell), true, "the Code Mode cell");
  assert.equal(await f.passes({ toolName: "wait" }), true, "wait resumes a cell");
  for (const event of [
    { toolName: "exec", params: { command: "ls" } },
    { toolName: "exec", toolKind: "shell", params: { command: "ls" } },
    { toolName: "exec", toolKind: "Code_Mode_Exec", params: { command: "ls" } },
    { toolName: "process" },
    { toolName: "browser" },
  ])
    assert.equal(await f.passes(event), false, JSON.stringify(event));
  // The cell's own tool calls meet the hooks one by one: its memory writes pass,
  // anything else stays refused.
  for (const toolName of ["write", "edit"])
    assert.equal(
      await f.passes({ toolName, params: { path: "MEMORY.md", content: "Fact" } }),
      true,
      toolName,
    );
  assert.equal(
    await f.passes({
      toolName: "write",
      params: { path: "memory/2026-10-26.md", content: "Note" },
    }),
    true,
  );
  assert.equal(
    await f.passes({ toolName: "write", params: { path: "notes.md", content: "X" } }),
    false,
  );
  assert.equal(await f.passes({ toolName: "read", params: { path: "MEMORY.md" } }), true);
});

test("outside a memory step a Code Mode cell and a shell exec pass as before", async (t) => {
  const f = await setup(t);
  await f.invocation("owner", { kind: "owner" });
  assert.equal(await f.passes(cell), true);
  assert.equal(await f.passes({ toolName: "exec", params: { command: "ls" } }), true);
});

test("an agent of restricted users runs no Code Mode cell, in a memory step neither", async (t) => {
  const f = await setup(t, { userAccess: { mode: "own", members: [] } });
  const owner = await f.invocation("owner", { kind: "owner" });
  assert.equal(await f.passes(cell), false);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  await f.invocation("step", step);
  assert.equal(await f.passes(cell), false);
});

test("/tool-policy admits only a Code Mode cell of OpenClaw's locked tools in a memory step", async (t) => {
  const f = await setup(t);
  await f.invocation("step", step);
  const policy = (input) => f.bridge.toolPolicy({ ...f.ctx, ...input });
  assert.deepEqual(policy({ toolName: "exec", toolKind: "code_mode_exec" }), {
    allow: true,
  });
  for (const input of [
    { toolName: "exec" },
    { toolName: "exec", toolKind: "shell" },
    { toolName: "process", toolKind: "code_mode_exec" },
    { toolName: "sessions_send", toolKind: "code_mode_exec" },
  ])
    assert.deepEqual(policy(input), { allow: false }, JSON.stringify(input));
  for (const toolKind of [7, "", "x".repeat(513)])
    assert.throws(() => policy({ toolName: "exec", toolKind }), { status: 400 });
});

test("a memory step's admitted memory writes are counted, refused ones are not", async (t) => {
  const f = await setup(t);
  const owner = await f.invocation("owner", { kind: "owner" });
  // An owner turn's memory write is no step's.
  assert.equal(await f.call("MEMORY.md"), true);
  assert.equal(f.assistants.memoryStepWrites.written(owner.attemptId), false);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  const inv = await f.invocation("step", step);
  assert.equal(await f.call("notes.md"), false);
  assert.equal(await f.call("memory/lead/MEMORY.md"), false);
  assert.equal(f.assistants.memoryStepWrites.written(inv.attemptId), false);
  assert.equal(await f.call("memory/2026-10-26.md"), true);
  assert.equal(f.assistants.memoryStepWrites.written(inv.attemptId), true);
});
