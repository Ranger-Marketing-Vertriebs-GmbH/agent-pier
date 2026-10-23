import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { sshOrigin } from "../../server/features/assistants/agent-ssh-origin.js";
import { memoryStepWrite } from "../../server/features/assistants/memory-write-policy.js";
import { MemoryNotes } from "../../server/features/assistants/memory-notes.js";

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

test("a memory step's refused write names the memory step as the reason", async (t) => {
  const f = await setup(t);
  f.assistants.memoryNotes = new MemoryNotes(f.store.db);
  await f.invocation("step", step);
  assert.equal(await f.call("memory/lead/MEMORY.md"), false);
  assert.deepEqual(
    f.assistants.memoryNotes
      .forConversation(f.channel.conversationId)
      .map((n) => n.reason),
    ["memory-step"],
  );
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

// Every tool but the memory ones, a future tool included.
const refused = [
  "exec",
  "process",
  "sessions_send",
  "sessions_spawn",
  "browser",
  "image_generate",
  "web_fetch",
  "web_search",
  "pdf",
  "apply_patch",
  "agentpier_ssh",
  "agentpier_workspace",
  "agentpier_share_file",
  "agentpier_reminder",
  "agentpier_team_ask",
  "some_future_tool",
];
const memoryTools = ["memory_search", "memory_get", "read", "write", "edit"];

test("a memory step runs only memory tools: no shell, SSH, project folder or other tool", async (t) => {
  const f = await setup(t);
  const owner = await f.invocation("owner", { kind: "owner" });
  // The owner's own turn reaches them (control).
  assert.equal(await f.tool("exec"), true);
  assert.equal(typeof f.prepare("workspace").ticket, "string");
  for (const toolName of [...refused, ...memoryTools])
    assert.equal(await f.step(toolName), true, `owner ${toolName}`);
  f.assistants.ledger.transition(owner.attemptId, "completed");

  const inv = await f.invocation("step", step);
  for (const toolName of refused) assert.equal(await f.step(toolName), false, toolName);
  for (const toolName of memoryTools)
    assert.equal(await f.step(toolName), true, toolName);
  // The existing gates refuse too: OpenClaw's locked tools and apply_patch's write.
  for (const toolName of ["exec", "process", "sessions_send", "sessions_spawn"])
    assert.equal(await f.tool(toolName), false, toolName);
  assert.equal(await f.patch(["*** Add File: MEMORY.md", "+Saved"]), false);
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

test("a call without a session fails closed while the agent has a memory step", async (t) => {
  const f = await setup(t);
  const ctx = { agentId: f.agentId };
  const owner = await f.invocation("owner", { kind: "owner" });
  assert.equal(await f.tool("exec", ctx), true);
  assert.equal(await f.step("browser", ctx), true);
  f.assistants.ledger.transition(owner.attemptId, "completed");
  await f.invocation("step", step);
  assert.equal(await f.tool("exec", ctx), false);
  assert.equal(await f.step("browser", ctx), false);
  assert.equal(await f.step("memory_search", ctx), true);
});

test("a memory step queued behind an owner turn takes none of its tools", async (t) => {
  const f = await setup(t);
  const owner = await f.invocation("owner", { kind: "owner" });
  // The step waits behind the running owner turn in the same session.
  const request = f.assistants.ledger.accept(f.channel.conversationId, {
    clientRequestId: "queued-step",
    text: "Save what you must keep.",
  });
  const context = f.assistants.teams.store.context;
  f.assistants.teams.store.context = (id) => (id === request.id ? step : context(id));
  const queued = f.assistants.ledger.recordAttempt(request.id);
  const session = { agentId: f.agentId, sessionKey: "session" };
  assert.equal(await f.tool("exec"), true);
  assert.equal(await f.step("browser"), true);
  assert.equal(await f.step("browser", { ...session, runId: owner.attemptId }), true);
  // The step's own run is refused.
  assert.equal(await f.step("browser", { ...session, runId: queued.id }), false);
  // Once the owner turn ended, the step is the session's running turn.
  f.assistants.ledger.transition(owner.attemptId, "completed");
  assert.equal(await f.step("browser"), false);
  assert.equal(await f.tool("exec"), false);
});

test("the step hook passes a call of no agent and still refuses a step's call", async (t) => {
  const f = await setup(t);
  await f.invocation("step", step);
  for (const ctx of [
    { sessionKey: "session" },
    { sessionKey: "session", agentId: "" },
    {},
  ])
    assert.equal(await f.step("browser", ctx), true, JSON.stringify(ctx));
  assert.equal(
    await f.step("browser", { agentId: f.agentId, sessionKey: "session" }),
    false,
  );
  assert.equal(await f.step("browser", { agentId: f.agentId }), false);
});

test("an orphaned pending attempt never breaks a call without a session", async (t) => {
  const f = await setup(t);
  const pending = f.assistants.ledger.pending.bind(f.assistants.ledger);
  f.assistants.ledger.pending = () => [
    { id: "ghost", requestId: "missing", state: "pending" },
    ...pending(),
  ];
  const ctx = { agentId: f.agentId };
  assert.equal(await f.step("browser", ctx), true);
  assert.equal(await f.tool("exec", ctx), true);
  await f.invocation("step", step);
  assert.equal(await f.step("browser", ctx), false);
  assert.equal(await f.tool("exec", ctx), false);
});
