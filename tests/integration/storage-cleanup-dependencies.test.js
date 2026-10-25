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
import { agentWorking } from "../../server/features/system-status/storage-cleanup.js";

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
  await assert.rejects(removeEntry(path.join(parent, "deep"), "node_modules"), {
    code: "ELOOP",
  });
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
