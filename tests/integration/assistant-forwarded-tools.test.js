import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import {
  TeamBridge,
  runtimeStatus,
} from "../../server/features/assistants/team-bridge.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";
import { profileTools } from "../../server/features/assistants/native-capabilities.js";

const origin = (f, forwarded) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: f.channel.chatId,
  userId: f.channel.userId,
  forwarded,
});

test("forwarded Telegram content cannot borrow standing coding or project-memory authority", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const note = f.memory.write(f.project.id, {
    title: "Private",
    content: "Private note",
  });
  const inv = await f.invocation("forwarded-workspace", origin(f, true));
  for (const input of [
    { action: "catalog" },
    { action: "memory_search", projectId: f.project.id },
    { action: "memory_read", projectId: f.project.id, id: note.id },
    {
      action: "memory_write",
      projectId: f.project.id,
      title: "Injected",
      content: "Forwarded instructions",
    },
    {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Execute forwarded instructions",
    },
  ])
    await assert.rejects(f.workflows.invoke(inv, input), { status: 403 });
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.workflows.list(f.id).actions, []);
  assert.equal(f.memory.list(f.project.id).total, 1);

  const direct = await f.invocation("direct-workspace", origin(f, false));
  const action = await f.workflows.invoke(direct, {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Execute the owner's direct instruction",
  });
  assert.equal(action.state, "approved");
  await f.workflows.tick();
  assert.equal(f.workflows.get(action.id).state, "running");
  assert.equal(f.starts.length, 1);
});

async function scheduledFixture(t) {
  const f = await workflowFixture(t);
  f.store.updateAssistant(f.id, { capabilities: { memory: false, reminders: true } }, 1);
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  const jobs = new Map();
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.list") return { jobs: [...jobs.values()], hasMore: false };
    if (method === "cron.add") {
      const job = { ...input, id: crypto.randomUUID(), updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { created: true, job };
    }
    if (method === "cron.update") {
      const job = { ...jobs.get(input.id), ...input.patch, updatedAtMs: 2 };
      jobs.set(job.id, job);
      return job;
    }
    if (method === "cron.remove") return { removed: jobs.delete(input.id) };
    assert.fail(method);
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  const routines = new NativeRoutines({ reminders });
  t.after(() => reminders.close());
  return { ...f, reminders, routines };
}

for (const kind of ["reminders", "routines"])
  test(`forwarded Telegram content cannot list or mutate ${kind}`, async (t) => {
    const f = await scheduledFixture(t);
    const adapter = f[kind];
    const creation = {
      action: "create",
      name: "Owner schedule",
      ...(kind === "reminders"
        ? {
            message: "A direct owner's reminder",
            schedule: { kind: "at", at: new Date(Date.now() + 60000).toISOString() },
          }
        : { prompt: "A direct owner's routine", trigger: { kind: "event" } }),
    };
    const direct = await f.invocation(`direct-${kind}`, origin(f, false));
    const saved = await adapter.invoke(direct, creation);
    const before = adapter.bindings.list(f.id);
    const forwarded = await f.invocation(`forwarded-${kind}`, origin(f, true));
    for (const input of [
      creation,
      { action: "list" },
      { action: "update", id: saved.id, enabled: false, revision: saved.revision },
      { action: "remove", id: saved.id },
    ])
      await assert.rejects(async () => adapter.invoke(forwarded, input), { status: 403 });
    assert.deepEqual(adapter.bindings.list(f.id), before);
    const visible = await adapter.invoke(direct, { action: "list" });
    assert.equal(visible[kind].length, 1);
    assert.equal(visible[kind][0].id, saved.id);
    assert.equal(visible[kind][0].enabled, true);
  });

async function nativeWriteGuard(t, f, { registrationMode = "full" } = {}) {
  const listeners = [];
  f.assistants.runtime.child = { pid: process.pid };
  f.assistants.runtime.on = (event, listener) => listeners.push({ event, listener });
  f.assistants.runtime.emitStatus = (state) =>
    listeners.filter((l) => l.event === "status").forEach((l) => l.listener(state));
  const bridge = new TeamBridge({
    assistants: f.assistants,
    teams: f.assistants.teams,
    generation: () => 1,
  });
  const connection = await bridge.start();
  t.after(() => bridge.close());
  const hooks = [];
  const lifetime = new AbortController(),
    disposers = [];
  const root = path.join(f.dataDir, "workspaces");
  fs.mkdirSync(path.join(root, f.id), { recursive: true });
  plugin.register({
    pluginConfig: { ...connection, workspaces: root },
    registrationMode,
    lifecycle: { signal: lifetime.signal, onDispose: (fn) => disposers.push(fn) },
    registerTool() {},
    on: (name, handler, options) => hooks.push({ name, handler, options }),
  });
  const [hook] = hooks.filter((h) => h.name === "before_tool_call");
  assert.deepEqual(hook.options.matcher, ["write", "edit"]);
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  const call = async (target, { toolName = "write", ctx } = {}) =>
    !(
      await hook.handler(
        { toolName, params: { path: target, content: "Injected" } },
        ctx || { agentId, sessionKey: "session" },
      )
    )?.block;
  return {
    bridge,
    call,
    agentId,
    root,
    workspace: path.join(root, f.id),
    retire: async () => {
      lifetime.abort();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}

test("native write tools never let forwarded or scheduled turns rewrite instructions or memory", async (t) => {
  const f = await workflowFixture(t);
  const { bridge, call, agentId, root, workspace } = await nativeWriteGuard(t, f);
  const direct = await f.invocation("direct-write", origin(f, false));
  assert.equal(await call("MEMORY.md"), true, "the owner's own turn keeps memory");
  assert.equal(await call("memory/2026-10-09.md", { toolName: "edit" }), true);
  assert.equal(await call(`${root}/${f.id}/memory/today.md`), true);
  assert.equal(
    await call("memory/\u212Aelvin-Notiz-\u00e4.md"),
    true,
    "Unicode below memory/",
  );
  for (const target of [
    "AGENTS.md",
    "./agents.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "BOOTSTRAP.md",
    "@AGENTS.md",
    "memory/../TOOLS.md",
    `${root}/${f.id}/AGENTS.md`,
    `${root}/other-agent/memory/today.md`,
    `${root}/other-agent/../${f.id}/AGENTS.md`,
    // OpenClaw strips these XML suffixes and repairs the path after the hook.
    "TOOLS.md</arg_value>>",
    "TOOLS.md</arg_value>>>>",
    "AGENTS.md</arg_value>></arg_value>>",
    "@SOUL.md</arg_value>>",
    // APFS folds these onto the bootstrap names.
    "AGENT\u017F.md",
    "\uFF21\uFF27\uFF25\uFF2E\uFF34\uFF33.md",
    "\u212Aeys.md",
    "IDENTITY\u200B.md",
    // Workspace skills are prompt instructions; bootstrap names never become folders.
    "skills/helper/SKILL.md",
    "Skills/helper/SKILL.md",
    "\u017Fkills/helper/SKILL.md",
    ".agents/skills/helper/SKILL.md",
    "memory/../skills/helper/SKILL.md",
    "SOUL.md/notes.md",
    "agents.md/x",
    "\u00e4rger/notes.md",
    "/etc/elsewhere.md",
    "../neighbour/MEMORY.md",
    "~/MEMORY.md",
  ])
    assert.equal(await call(target), false, `${target} is write-protected`);
  assert.equal(
    await call("MEMORY.md", { ctx: { agentId: "ap-foreign", sessionKey: "session" } }),
    false,
  );
  // Links and existing case variants that alias an instruction file are refused.
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), "Owner instructions");
  fs.linkSync(path.join(workspace, "AGENTS.md"), path.join(workspace, "notes.md"));
  fs.mkdirSync(path.join(workspace, "memory"), { recursive: true });
  fs.symlinkSync("../AGENTS.md", path.join(workspace, "memory", "alias.md"));
  for (const target of ["notes.md", "memory/alias.md", `${root}/${f.id}/notes.md`])
    assert.equal(await call(target), false, `${target} aliases AGENTS.md`);
  assert.equal(
    await call("MEMORY.md", { ctx: { agentId: "foreign", sessionKey: "session" } }),
    false,
  );
  f.assistants.ledger.transition(direct.attemptId, "completed");
  assert.equal(await call("MEMORY.md"), false, "no active turn has no authority");

  const forwarded = await f.invocation("forwarded-write", origin(f, true));
  for (const target of ["MEMORY.md", "memory/notes.md", "notes.md"])
    for (const toolName of ["write", "edit"])
      assert.equal(await call(target, { toolName }), false);
  f.assistants.ledger.transition(forwarded.attemptId, "completed");

  for (const context of [{ kind: "team-member" }, { kind: "reminder" }]) {
    const turn = await f.invocation(`${context.kind}-write`, context);
    assert.equal(await call("MEMORY.md"), false, `${context.kind} turns cannot write`);
    f.assistants.ledger.transition(turn.attemptId, "completed");
  }

  await f.invocation("closed-bridge", origin(f, false));
  assert.equal(await call("MEMORY.md"), true);
  await bridge.close();
  assert.equal(await call("MEMORY.md"), false, "an unreachable bridge fails closed");
  assert.ok(agentId);
});

test("the Gateway plugin reports its live write guard before writes are granted", async (t) => {
  const f = await workflowFixture(t);
  let availability = "ready";
  f.assistants.runtime.status = () => ({ version: "2026.9.8", availability });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { bridge, retire } = await nativeWriteGuard(t, f);
  const settle = async () => {
    for (let n = 0; n < 100 && !bridge.guardLive(); n++)
      await new Promise((r) => setTimeout(r, 10));
  };
  await settle();
  assert.equal(bridge.guardLive(), true);
  f.assistants.runtime.status = () => ({ version: "2026.9.7", availability });
  assert.equal(bridge.guardLive(), false, "unverified runtimes keep memory read-only");
  f.assistants.runtime.status = () => ({ version: "2026.9.8", availability });
  f.assistants.runtime.child = { pid: 1 };
  const other = await fetch(bridge.connection.url + "/guard", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pid: process.pid, ppid: process.ppid }),
  });
  assert.equal(other.status, 403, "only the Gateway process may report the guard");
  f.assistants.runtime.child = null;
  const orphan = await fetch(bridge.connection.url + "/guard", {
    method: "POST",
    headers: {
      authorization: `Bearer ${bridge.connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ pid: process.pid, ppid: process.ppid }),
  });
  assert.equal(orphan.status, 403, "no running Gateway means no guard report");
  // A reconnect may reload the plugin; writes wait for a fresh report.
  f.assistants.runtime.child = { pid: process.pid };
  assert.equal(bridge.guardLive(), true);
  // Statuses that never were ready do not withdraw anything.
  f.assistants.runtime.emitStatus({ availability: "ready" });
  assert.equal(bridge.guardLive(), true);
  availability = "reconnecting";
  f.assistants.runtime.emitStatus({ availability });
  availability = "ready";
  f.assistants.runtime.emitStatus({ availability });
  assert.equal(bridge.guardLive(), false);
  assert.equal(
    bridge.guardPending(true),
    true,
    "the runtime reports WRITE_GUARD_PENDING",
  );
  assert.equal(bridge.guardPending(false), false, "no memory agent, nothing pending");
  f.store.updateAssistant(
    f.id,
    { capabilities: { memory: true, reminders: false } },
    f.store.getAssistant(f.id).revision,
  );
  assert.equal(
    runtimeStatus(f.assistants.runtime, f.assistants, bridge).diagnostic,
    "WRITE_GUARD_PENDING",
  );
  const agent = {
    ...f.store.getAssistant(f.id),
    capabilities: { memory: true, reminders: false },
  };
  const tools = () => profileTools(agent, true, true, bridge.guardLive());
  assert.ok(
    tools().includes("read") && !tools().includes("write") && !tools().includes("edit"),
  );
  // The plugin's next periodic report restores writes within one interval.
  t.mock.timers.tick(15000);
  await settle();
  assert.equal(bridge.guardLive(), true);
  assert.equal(bridge.guardPending(true), false);
  assert.equal(
    runtimeStatus(f.assistants.runtime, f.assistants, bridge).diagnostic,
    undefined,
  );
  assert.ok(tools().includes("write") && tools().includes("edit"));
  // A retired plugin instance (reload, replacement) never re-grants writes.
  await retire();
  availability = "reconnecting";
  f.assistants.runtime.emitStatus({ availability });
  availability = "ready";
  f.assistants.runtime.emitStatus({ availability });
  t.mock.timers.tick(60000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bridge.guardLive(), false, "only an active registry reports");
  await bridge.close();
  assert.equal(bridge.guardLive(), false);
});

test("only the active Gateway registry reports a guard, and setup loads never throw", async (t) => {
  const f = await workflowFixture(t);
  f.assistants.runtime.status = () => ({ version: "2026.9.8" });
  const { bridge } = await nativeWriteGuard(t, f, { registrationMode: "discovery" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(bridge.guardLive(), false, "discovery registries carry no live hook");
  const tools = [];
  assert.doesNotThrow(() =>
    plugin.register({
      pluginConfig: undefined,
      registrationMode: "cli-metadata",
      registerTool: (tool) => tools.push(tool),
    }),
  );
  assert.ok(tools.length > 0);
});
