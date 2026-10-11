import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import {
  mcpSections,
  readMcpInputs,
} from "../../server/features/assistants/openclaw-config/mcp-servers.js";

const model = { connectionId: "c", modelId: "m" };

function setup(t) {
  const f = teamFixture(t);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-team-mcp-"));
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file === "/abs/files",
  });
  t.after(() => {
    servers.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const log = [];
  let failApply = false;
  f.assistants.mcp = {
    servers,
    async apply() {
      log.push("mcp");
      if (failApply) throw Object.assign(Error("conflict"), { status: 409 });
      return true;
    },
  };
  const apply = f.assistants.config.apply;
  f.assistants.config.apply = async (id) => {
    log.push(`profile:${id}`);
    return apply(id);
  };
  const github = servers.create({
    name: "github",
    transport: "http",
    url: "https://mcp.example.test/v1",
  });
  const files = servers.create({
    name: "files",
    transport: "stdio",
    command: "/abs/files",
  });
  const lead = f.store.createAssistant({ name: "Lead", instructions: "Original", model });
  servers.setBindings("agent", lead.id, [github.id, files.id]);
  const members = [
    { name: "A", role: "R", assignment: "Task A", mcpServers: ["github", "files"] },
    { name: "B", role: "R", assignment: "Task B" },
  ];
  const bound = (id) => servers.bindings("agent", id);
  return {
    ...f,
    servers,
    log,
    lead,
    github,
    files,
    bound,
    failApply: (value) => (failApply = value),
    propose: (options = {}) => f.proposal({ parent: lead, members, ...options }),
    memberOf: (team, name) =>
      f.service.store.members(team.id).find((m) => m.name === name),
  };
}

test("approved members get exactly their servers, applied before provisioning", async (t) => {
  const f = setup(t),
    { team } = await f.propose();
  const a = f.memberOf(team, "A"),
    b = f.memberOf(team, "B");
  // Saved with the reservation; nothing is applied outside the admission lock.
  assert.deepEqual(f.bound(a.assistantId), [f.files.id, f.github.id]);
  assert.deepEqual(f.bound(b.assistantId), []);
  assert.deepEqual(f.log, []);
  await f.service.reconcile();
  assert.equal(f.log[0], "mcp");
  assert.ok(f.log.includes(`profile:${a.assistantId}`));
  const tools = mcpSections({
    profiles: f.store.listAssistants(),
    ...readMcpInputs(f.servers),
  }).agentTools;
  const runtimeId = (id) => f.store.getAssistant(id).runtimeAgentId;
  assert.deepEqual(
    Object.keys(tools).sort(),
    [runtimeId(f.lead.id), runtimeId(a.id)].sort(),
  );
  assert.deepEqual(tools[runtimeId(a.id)], ["files__*", "github__*"]);
  // A settled store applies nothing further.
  await f.service.reconcile();
  assert.equal(f.log.filter((e) => e === "mcp").length, 1);
});

test("a member's servers are removed and applied when it ends", async (t) => {
  const f = setup(t),
    { team } = await f.propose();
  await f.service.reconcile();
  const a = f.memberOf(team, "A");
  f.complete(a.attemptId);
  f.failApply(true);
  await f.service.reconcile();
  assert.equal(f.service.store.member(a.id).phase, "completed");
  assert.deepEqual(f.bound(a.assistantId), []);
  // A failed patch is retried at the next tick.
  f.failApply(false);
  await f.service.reconcile();
  assert.deepEqual(f.log.filter((e) => e === "mcp").length, 3);
  await f.service.reconcile();
  assert.deepEqual(f.log.filter((e) => e === "mcp").length, 3);
});

test("stopping queued members removes their servers at once", async (t) => {
  const f = setup(t),
    { team } = await f.propose();
  const a = f.memberOf(team, "A");
  assert.equal(f.bound(a.assistantId).length, 2);
  await f.service.stop(team.id);
  assert.equal(f.service.store.member(a.id).phase, "cancelled");
  assert.deepEqual(f.bound(a.assistantId), []);
});

test("reconciliation removes servers of members that ended without a sync", async (t) => {
  const f = setup(t),
    { team } = await f.propose();
  await f.service.reconcile();
  const a = f.memberOf(team, "A");
  // An end persisted before a crash: the bindings are still in the store.
  f.service.store.write(f.service.store.member(a.id), { phase: "failed" });
  assert.equal(f.bound(a.assistantId).length, 2);
  // The Gateway start (teamConfiguration) and every tick run the same sync.
  assert.equal(f.service.mcp.sync(), true);
  assert.deepEqual(f.bound(a.assistantId), []);
  assert.equal(f.service.mcp.sync(), false);
});

test("a server the lead loses is taken from its running members", async (t) => {
  const f = setup(t),
    { team } = await f.propose();
  await f.service.reconcile();
  const a = f.memberOf(team, "A");
  f.servers.setBindings("agent", f.lead.id, [f.github.id]);
  await f.service.reconcile();
  assert.deepEqual(f.bound(a.assistantId), [f.github.id]);
});

test("members approved as permanent keep their servers for the owner to manage", async (t) => {
  const f = setup(t),
    { team } = await f.propose({ allowed: false });
  const a0 = f.service.store.get(team.id);
  assert.equal(a0.phase, "awaiting_approval");
  await f.service.decide(
    team.id,
    { revision: a0.revision, decision: "approve", lifetime: "permanent" },
    { kind: "owner" },
  );
  const a = f.memberOf(team, "A");
  assert.deepEqual(f.bound(a.assistantId), [f.files.id, f.github.id]);
  await f.service.reconcile();
  f.servers.setBindings("agent", a.assistantId, [f.github.id]);
  f.complete(f.service.store.member(a.id).attemptId);
  await f.service.reconcile();
  assert.equal(f.service.store.member(a.id).phase, "completed");
  assert.deepEqual(f.bound(a.assistantId), [f.github.id]);
});

test("the team list shows each member's servers by name with the stdio marker", async (t) => {
  const f = setup(t),
    { team } = await f.propose({ allowed: false });
  const listed = f.service.list().teams.find((x) => x.id === team.id);
  assert.deepEqual(
    listed.members.map((m) => m.mcpServers),
    [
      [
        { name: "github", stdio: false },
        { name: "files", stdio: true },
      ],
      undefined,
    ],
  );
  const text = JSON.stringify(f.service.list());
  for (const hidden of [f.github.id, f.files.id, "example.test", "/abs/files"])
    assert.ok(!text.includes(hidden), hidden);
});

test("a proposal naming another agent's server is refused and stores nothing", async (t) => {
  const f = setup(t);
  f.servers.setBindings("agent", f.lead.id, [f.github.id]);
  await assert.rejects(f.propose(), { status: 400, key: "teamMcpServerNotBound" });
  assert.deepEqual(f.service.store.list(), []);
});
