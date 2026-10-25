import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deleteDependencies,
  dependencyFolders,
  measureDependencies,
} from "../../server/features/system-status/cleanup-dependencies.js";
import { removeEntry } from "../../server/features/system-status/safe-tree.js";
import { anyInside } from "../../server/features/system-status/workspace-processes.js";
import {
  agentWorking,
  StorageCleanup,
} from "../../server/features/system-status/storage-cleanup.js";
import { sweepDependencies } from "../../server/features/system-status/cleanup-dependencies.js";

function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-deps-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, bytes = 4096) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}
const idle = { busy: async () => false, cwds: async () => [] };

function workspace(t) {
  const root = temporary(t);
  const dataDir = path.join(root, "data");
  const agent = path.join(dataDir, "assistants", "workspaces", "agent-1");
  const outside = path.join(root, "outside");
  write(path.join(outside, "keep.txt"));
  write(path.join(outside, "node_modules", "pkg", "index.js"));
  write(path.join(agent, "app", "node_modules", "left-pad", "index.js"), 64 * 1024);
  write(path.join(agent, "app", "node_modules", "left-pad", "node_modules", "x.js"));
  write(path.join(agent, "tools", "deep", "node_modules", "a", "b.js"), 16 * 1024);
  write(path.join(agent, "app", "src", "main.js"));
  // The agent's secrets: never walked into, not even for a node_modules there.
  write(path.join(agent, ".agentpier", "secrets.json"));
  write(path.join(agent, ".agentpier", "node_modules", "x.js"));
  // A link named node_modules points outside: it is no folder of the workspace.
  fs.symlinkSync(path.join(outside, "node_modules"), path.join(agent, "node_modules"));
  // A link inside a real node_modules folder points outside: only the link goes.
  fs.symlinkSync(outside, path.join(agent, "app", "node_modules", "escape"));
  // A linked folder on the way is never walked into.
  fs.symlinkSync(outside, path.join(agent, "linked"));
  return { root, dataDir, agent, outside };
}

test("dependency folders are found at any depth, never through or as a link", async (t) => {
  const { dataDir, agent } = workspace(t);
  const folders = await dependencyFolders(agent);
  assert.deepEqual(
    folders.map((f) => path.relative(agent, path.join(f.parent, f.name))).sort(),
    ["app/node_modules", "tools/deep/node_modules"],
  );
  const measured = await measureDependencies(dataDir, "agent-1");
  assert.ok(measured.bytes >= 80 * 1024, `measured ${measured.bytes}`);
  assert.equal(measured.partial, false);
});

test("deleting dependencies removes node_modules folders and nothing outside", async (t) => {
  const { dataDir, agent, outside } = workspace(t);
  const result = await deleteDependencies(dataDir, "agent-1", idle);
  assert.equal(result.removed, 2);
  assert.equal(result.skipped, 0);
  assert.ok(result.bytes >= 80 * 1024);
  assert.equal(fs.existsSync(path.join(agent, "app", "node_modules")), false);
  assert.equal(fs.existsSync(path.join(agent, "tools", "deep", "node_modules")), false);
  assert.ok(fs.existsSync(path.join(agent, "app", "src", "main.js")), "source stays");
  assert.ok(fs.existsSync(path.join(agent, ".agentpier", "secrets.json")));
  assert.ok(fs.existsSync(path.join(agent, ".agentpier", "node_modules", "x.js")));
  assert.ok(fs.lstatSync(path.join(agent, "node_modules")).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  assert.ok(fs.existsSync(path.join(outside, "node_modules", "pkg", "index.js")));
});

test("a busy agent or a process in its workspace refuses the deletion", async (t) => {
  const { dataDir, agent } = workspace(t);
  await assert.rejects(
    deleteDependencies(dataDir, "agent-1", { ...idle, busy: async () => true }),
    { status: 409 },
  );
  await assert.rejects(
    deleteDependencies(dataDir, "agent-1", {
      ...idle,
      cwds: async () => [path.join(agent, "app")],
    }),
    { status: 409 },
  );
  await assert.rejects(
    deleteDependencies(dataDir, "agent-1", {
      ...idle,
      cwds: async () => {
        throw Error("lsof failed");
      },
    }),
    { status: 503 },
  );
  await assert.rejects(deleteDependencies(dataDir, "../agent-1", idle), { status: 404 });
  await assert.rejects(deleteDependencies(dataDir, "missing", idle), { status: 404 });
  assert.ok(fs.existsSync(path.join(agent, "app", "node_modules")), "nothing went");
  assert.equal(anyInside([`${agent}-other`], agent), false, "a sibling is not inside");
  assert.equal(anyInside([agent], agent), true);
});

test("a workspace that is itself a link is refused", async (t) => {
  const { dataDir, outside } = workspace(t);
  fs.symlinkSync(outside, path.join(dataDir, "assistants", "workspaces", "agent-2"));
  await assert.rejects(deleteDependencies(dataDir, "agent-2", idle), { status: 404 });
  assert.ok(fs.existsSync(path.join(outside, "node_modules", "pkg", "index.js")));
});

test("a folder swapped for a link is never deleted through", async (t) => {
  const { agent, outside } = workspace(t);
  const parent = path.join(agent, "tools");
  fs.renameSync(path.join(parent, "deep"), path.join(parent, "moved"));
  fs.symlinkSync(outside, path.join(parent, "deep"));
  // The linked folder holds nothing of the workspace: nothing is deleted through it.
  assert.equal(await removeEntry(path.join(parent, "deep"), "node_modules"), false);
  assert.ok(fs.existsSync(path.join(outside, "node_modules", "pkg", "index.js")));
  // An entry refused by its check stays.
  assert.equal(await removeEntry(parent, "moved", () => false), false);
  assert.ok(fs.existsSync(path.join(parent, "moved")));
});

test("an agent with a pending turn, team task or running action counts as working", () => {
  const conversation = (assistantId) => ({ assistantId });
  const services = (overrides = {}) => ({
    assistants: {
      ledger: { pending: () => [], getRequest: () => ({ conversationId: "c1" }) },
      store: { getConversation: () => conversation("agent-1") },
      longChats: { runningFor: () => false },
      workflows: { store: { list: () => [] } },
      ...overrides,
    },
    assistantTeams: { store: { members: () => [] } },
  });
  assert.equal(agentWorking({}, "agent-1"), false, "no agents, nothing works");
  assert.equal(agentWorking(services(), "agent-1"), false);
  assert.equal(agentWorking(services({ maintenance: true }), "agent-1"), true);
  const pending = services({
    ledger: {
      pending: () => [{ requestId: "r1" }],
      getRequest: () => ({ conversationId: "c1" }),
    },
  });
  assert.equal(agentWorking(pending, "agent-1"), true);
  assert.equal(agentWorking(pending, "agent-2"), false);
  const team = services();
  team.assistantTeams.store.members = () => [
    { assistantId: "agent-1", phase: "running" },
  ];
  assert.equal(agentWorking(team, "agent-1"), true);
  const action = services({
    workflows: { store: { list: () => [{ state: "executing" }] } },
  });
  assert.equal(agentWorking(action, "agent-1"), true);
  const broken = services({ longChats: { runningFor: () => assert.fail("x") } });
  assert.equal(agentWorking(broken, "agent-1"), true, "doubt counts as working");
});

test("each folder is set aside atomically and a busy agent stops the rest", async (t) => {
  const { dataDir, agent } = workspace(t);
  let checks = 0;
  const result = await deleteDependencies(dataDir, "agent-1", {
    busy: async () => ++checks > 1,
    cwds: async () => [],
  });
  assert.equal(result.removed, 1);
  assert.equal(result.skipped, 1, "the agent started working before the second");
  const left = (await dependencyFolders(agent)).length;
  assert.equal(left, 1);
  const names = fs
    .readdirSync(path.join(agent, "app"))
    .concat(fs.readdirSync(path.join(agent, "tools", "deep")));
  assert.ok(!names.some((name) => name.startsWith(".node_modules-deleting-")));
});

test("the startup sweep finishes deletions a restart interrupted", async (t) => {
  const { dataDir, agent, outside } = workspace(t);
  const aside = path.join(agent, "app", ".node_modules-deleting-0123456789abcdef");
  fs.renameSync(path.join(agent, "app", "node_modules"), aside);
  fs.symlinkSync(outside, path.join(agent, ".node_modules-deleting-link"));
  await sweepDependencies(dataDir);
  assert.equal(fs.existsSync(aside), false);
  assert.ok(
    fs.lstatSync(path.join(agent, ".node_modules-deleting-link")).isSymbolicLink(),
  );
  assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
  assert.ok(fs.existsSync(path.join(agent, "tools", "deep", "node_modules")));
});

test("the owner never sees or changes the dependencies of a user's agent", async (t) => {
  const { dataDir, agent } = workspace(t);
  const events = [];
  const agents = {
    "agent-1": { id: "agent-1", name: "Anna's agent", userAccess: { mode: "own" } },
  };
  const services = {
    assistants: {
      store: {
        getAssistant: (id) => {
          if (agents[id]) return agents[id];
          throw Object.assign(Error("gone"), { status: 404 });
        },
      },
    },
  };
  const cleanup = new StorageCleanup({
    dataDir,
    services,
    audit: { append: (event) => events.push(event) },
    cwds: async () => [],
  });
  assert.deepEqual((await cleanup.dependencies()).agents, []);
  await assert.rejects(cleanup.deleteDependencies("agent-1"), { status: 404 });
  assert.ok(fs.existsSync(path.join(agent, "app", "node_modules")));
  assert.deepEqual(
    events.map((e) => [e.outcome, e.resourceId, e.details.area, e.details.code]),
    [["failure", "agent-1", "dependencies", "notFound"]],
  );
  // Agents off: whose workspace it is cannot be told, so none is offered.
  const off = new StorageCleanup({ dataDir, services: {}, cwds: async () => [] });
  assert.deepEqual((await off.dependencies()).agents, []);
  // A removed agent's leftover workspace is the owner's to clean.
  delete agents["agent-1"];
  const listed = (await cleanup.dependencies()).agents;
  assert.deepEqual(
    listed.map((a) => [a.id, a.name]),
    [["agent-1", ""]],
  );
});
