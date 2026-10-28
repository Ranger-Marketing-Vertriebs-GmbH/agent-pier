import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { approvalRevision } from "../../server/features/assistants/assistant-access.js";
import {
  directoryProjectId,
  folderIdentity,
} from "../../server/features/memory/project-rebind.js";
import { initRepository } from "../../server/features/assistants/agent-projects.js";

// The agentpier_project service (agent-projects.js): an eligible agent creates an
// empty project in the owner's default folder in a direct owner turn, gets it granted
// narrowly and may switch coding sessions for it, and nothing else.

const hourMs = 3600000;
const revisionOf = (f) => approvalRevision(f.workflows.access.stored(f.id));
const entries = (dir) => fs.readdirSync(dir).sort();
// The agent's own audit records of a coding switch.
const agentUpdates = (f) =>
  f.audit.filter((e) => e.action === "assistant.updated" && e.source === "agent");

test("create makes an empty Git project in the default folder and grants it for writing", async (t) => {
  const f = await agentProjectFixture(t);
  const at = Date.parse("2026-10-28T09:00:00Z");
  f.workflows.projects.now = () => at;
  const approvalBefore = revisionOf(f);
  const r = await f.call({ action: "create", name: "Shop" });
  assert.deepEqual(Object.keys(r).sort(), ["coding", "name", "path", "projectId"]);
  assert.equal(r.name, "Shop");
  assert.equal(r.path, path.join(f.parent, "Shop"));
  assert.equal(r.coding, false);
  assert.ok(fs.existsSync(path.join(r.path, ".git")));
  assert.deepEqual(fs.readdirSync(r.path), [".git"]);
  const project = f.memory.project(r.projectId);
  assert.equal(project.cwd, r.path);
  assert.equal(project.kind, "git");
  const policy = f.workflows.access.get(f.id);
  assert.ok(policy.projectIds.includes(r.projectId));
  assert.equal(policy.projectFiles[r.projectId], "write");
  assert.ok(!policy.sessionProjectIds.includes(r.projectId));
  assert.equal(approvalRevision(policy), approvalBefore);
  assert.ok(f.workflows.projects.store.createdBy(f.id, r.projectId));
  const e = f.audit.find((x) => x.action === "project.created");
  assert.equal(e.source, "agent");
  assert.equal(e.resourceId, f.id);
  assert.equal(e.projectId, r.projectId);
  assert.deepEqual(e.details, {
    kind: "agent-project",
    change: "create",
    coding: false,
    git: true,
  });
  assert.ok(!JSON.stringify(f.audit).includes(f.parent));
  // One settled row in the agent's chat for the owner notice.
  const [row] = f.projectRows();
  assert.equal(row.key, `agent-project:${row.attemptId}:${row.key.split(":").at(-1)}`);
  assert.equal(row.conversationId, f.channel.conversationId);
  assert.equal(row.state, "completed");
  assert.equal(row.settled, true);
  assert.deepEqual(row.origin, { kind: "agent-project" });
  assert.deepEqual(row.chatNotes.result, { at, state: "completed" });
  assert.deepEqual(f.workflows.projects.store.list(f.id), [
    { projectId: r.projectId, createdAt: new Date(at).toISOString() },
  ]);
  assert.deepEqual(row.payload, {
    action: "agent_project",
    change: "create",
    projectId: r.projectId,
    projectName: "Shop",
    path: r.path,
    coding: false,
    result: r,
  });
});

test("create with coding switches coding sessions on; git: false leaves a plain folder", async (t) => {
  const f = await agentProjectFixture(t);
  const coded = await f.call({ action: "create", name: "Coded", coding: true });
  assert.equal(coded.coding, true);
  assert.equal(f.workflows.access.sessionsEnabled(f.id, coded.projectId), true);
  const plain = await f.call({ action: "create", name: "Plain", git: false });
  assert.deepEqual(fs.readdirSync(plain.path), []);
  assert.equal(f.memory.project(plain.projectId).kind, "directory");
  assert.equal(f.workflows.access.sessionsEnabled(f.id, plain.projectId), false);
  assert.equal(f.audit.find((e) => e.projectId === plain.projectId).details.git, false);
  for (const input of [
    { action: "create", name: "X", git: "yes" },
    { action: "create", name: "X", coding: 1 },
    { action: "create", name: "X", extra: true },
    { action: "coding", projectId: coded.projectId, enabled: "on" },
    { action: "list", extra: 1 },
    { action: "delete", projectId: coded.projectId },
    null,
  ])
    assert.equal(await f.code(f.call(input)), "INVALID_INPUT", JSON.stringify(input));
  assert.ok(!fs.existsSync(path.join(f.parent, "X")));
});

test("a pending approval stays valid when the agent creates a project", async (t) => {
  const f = await agentProjectFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const pending = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Build the feature.",
  });
  assert.equal(pending.state, "awaiting_approval");
  const before = revisionOf(f);
  const definitions = f.workflows.access.stored(f.id).definitions;
  const r = await f.call({ action: "create", name: "Shop", coding: true });
  assert.equal(revisionOf(f), before);
  assert.deepEqual(f.workflows.access.stored(f.id).definitions, definitions);
  const action = f.workflows.store.get(pending.id);
  assert.equal(action.state, "awaiting_approval");
  f.workflows.access.authorize(f.id, f.project.id, f.pipeline.id, action.accessRevision);
  // The owner's earlier grants stay as they were.
  assert.deepEqual(
    f.workflows.access.get(f.id).projectIds,
    [f.project.id, r.projectId].sort(),
  );
});

test("invalid names are refused before anything is created", async (t) => {
  const f = await agentProjectFixture(t);
  for (const name of [
    "../x",
    ".hidden",
    "a/b",
    "..",
    ".",
    "",
    " x",
    "a\\b",
    "a\x00b",
    7,
    "a\uff0fb",
    "a\u2215b",
    "\u202e",
    "a\u200bb",
  ])
    assert.equal(
      await f.code(f.call({ action: "create", name })),
      "PROJECT_NAME_INVALID",
      String(name),
    );
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
});

test("an existing folder, file or link of that name is never adopted", async (t) => {
  const f = await agentProjectFixture(t);
  fs.mkdirSync(path.join(f.parent, "Taken"));
  fs.writeFileSync(path.join(f.parent, "Taken", "keep.txt"), "mine");
  fs.writeFileSync(path.join(f.parent, "File"), "data");
  fs.symlinkSync("/nonexistent", path.join(f.parent, "Link"));
  // A link to a folder elsewhere is refused as well, and the folder stays untouched.
  const outside = fs.mkdtempSync(path.join(f.dataDir, "outside-"));
  fs.symlinkSync(outside, path.join(f.parent, "Away"));
  const known = f.projectIds();
  for (const name of ["Taken", "File", "Link", "Away"])
    assert.equal(
      await f.code(f.call({ action: "create", name })),
      "PROJECT_EXISTS",
      name,
    );
  assert.deepEqual(fs.readdirSync(path.join(f.parent, "Taken")), ["keep.txt"]);
  assert.equal(fs.readFileSync(path.join(f.parent, "File"), "utf8"), "data");
  assert.equal(fs.readlinkSync(path.join(f.parent, "Link")), "/nonexistent");
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(f.projectIds(), known);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
});

test("a missing or unwritable default folder answers PROJECT_FOLDER_UNAVAILABLE", async (t) => {
  const f = await agentProjectFixture(t);
  f.preferences.defaultCwd = path.join(f.parent, "missing");
  assert.equal(
    await f.code(f.call({ action: "create", name: "Shop" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.ok(!fs.existsSync(path.join(f.parent, "missing")));
  // A file is no folder either.
  fs.writeFileSync(path.join(f.parent, "plain"), "");
  f.preferences.defaultCwd = path.join(f.parent, "plain");
  assert.equal(
    await f.code(f.call({ action: "create", name: "Shop" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  if (process.getuid?.() !== 0) {
    f.preferences.defaultCwd = f.parent;
    fs.chmodSync(f.parent, 0o500);
    assert.equal(
      await f.code(f.call({ action: "create", name: "Shop" })),
      "PROJECT_FOLDER_UNAVAILABLE",
    );
    fs.chmodSync(f.parent, 0o700);
    assert.deepEqual(fs.readdirSync(f.parent), ["plain"]);
  }
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
});

test("inside a repository without git the folder is refused, removed and nothing is registered", async (t) => {
  const f = await agentProjectFixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: f.parent });
  const known = f.projectIds();
  assert.equal(
    await f.code(f.call({ action: "create", name: "Sub", git: false })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.ok(!fs.existsSync(path.join(f.parent, "Sub")));
  assert.deepEqual(f.projectIds(), known);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
  assert.deepEqual(f.projectRows(), []);
});

test("inside a repository with git the new folder is its own project", async (t) => {
  const f = await agentProjectFixture(t);
  execFileSync("git", ["init", "--quiet"], { cwd: f.parent });
  const r = await f.call({ action: "create", name: "Sub2" });
  assert.equal(r.path, path.join(f.parent, "Sub2"));
  assert.equal(f.memory.project(r.projectId).kind, "git");
  assert.equal(f.memory.project(r.projectId).cwd, r.path);
  // The enclosing repository is never registered.
  assert.ok(!f.memory.projectNames().some((p) => p.name === path.basename(f.parent)));
});

test("a registration that lands on an existing project is refused and cleaned up", async (t) => {
  const f = await agentProjectFixture(t);
  const register = f.memory.register.bind(f.memory);
  for (const stand of [async () => f.memory.project(f.project.id), async () => null]) {
    f.memory.register = stand;
    assert.equal(
      await f.code(f.call({ action: "create", name: "Shop" })),
      "PROJECT_FOLDER_UNAVAILABLE",
    );
    assert.ok(!fs.existsSync(path.join(f.parent, "Shop")));
  }
  // A known project that claims this very folder is not adopted either.
  f.memory.register = async (cwd) => ({ ...f.memory.project(f.project.id), cwd });
  const target = path.join(f.parent, "Again");
  assert.equal(
    await f.code(f.call({ action: "create", name: "Again", git: false })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.ok(!fs.existsSync(target));
  f.memory.register = register;
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
  assert.deepEqual(f.projectRows(), []);
});

test("a failed git init fails the call and removes the folder", async (t) => {
  const f = await agentProjectFixture(t);
  const known = f.projectIds();
  f.workflows.projects.gitInit = async () => {
    throw Error("boom");
  };
  assert.equal(
    await f.code(f.call({ action: "create", name: "Shop" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.deepEqual(f.projectIds(), known);
});

test("a failure after the grant removes the folder, the record, the grant and the project", async (t) => {
  const f = await agentProjectFixture(t);
  const known = f.projectIds();
  let notices = 0;
  f.assistants.changed = () => notices++;
  const reserve = f.workflows.store.reserve.bind(f.workflows.store);
  f.workflows.store.reserve = () => {
    throw Error("disk full");
  };
  assert.equal(await f.code(f.call({ action: "create", name: "Shop" })), "UNAVAILABLE");
  assert.deepEqual(fs.readdirSync(f.parent), []);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
  const policy = f.workflows.access.get(f.id);
  assert.deepEqual(policy.projectIds, []);
  assert.deepEqual(policy.projectFiles, {});
  assert.deepEqual(f.projectIds(), known, "no orphan project stays registered");
  assert.equal(notices, 2, "the grant and its removal both reach the agent");
  assert.ok(!f.audit.some((e) => e.action === "project.created"));
  f.workflows.store.reserve = reserve;
  // The name is free again.
  assert.equal((await f.call({ action: "create", name: "Shop" })).name, "Shop");
});

test("an older project row naming the new folder is never rebound into it", async (t) => {
  const f = await agentProjectFixture(t);
  let oldId;
  // The owner's earlier plain project whose deleted folder had this inode (inode reuse).
  f.workflows.projects.gitInit = async (target) => {
    const id = folderIdentity(target);
    oldId = directoryProjectId(id);
    f.memory.db
      .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
      .run(
        oldId,
        "Notes",
        id.path,
        "directory",
        JSON.stringify(["directory", id.path, id.dev, id.ino]),
        new Date().toISOString(),
      );
    f.memory.write(oldId, { title: "Owner note", content: "owner data" });
    await initRepository(target);
  };
  const known = f.projectIds();
  assert.equal(
    await f.code(f.call({ action: "create", name: "Notes" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.ok(!fs.existsSync(path.join(f.parent, "Notes")));
  assert.deepEqual(f.projectIds(), [...known, oldId].sort(), "nothing new is registered");
  assert.equal(f.memory.reboundTo(oldId), null);
  assert.match(JSON.stringify(f.memory.list(oldId)), /Owner note/);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
  assert.deepEqual(f.workflows.projects.store.list(f.id), []);
});

test("a folder swapped for a link or another folder is refused and the replacement stays", async (t) => {
  const f = await agentProjectFixture(t);
  const logged = t.mock.method(console, "error", () => {});
  const outside = fs.mkdtempSync(path.join(f.dataDir, "outside-"));
  fs.writeFileSync(path.join(outside, "keep"), "x");
  const known = f.projectIds();
  const swaps = {
    link: (target) => fs.symlinkSync(outside, target),
    folder: (target) => {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, "theirs"), "y");
    },
  };
  // Swapped after git init: refused before registering.
  for (const [kind, swap] of Object.entries(swaps)) {
    f.workflows.projects.gitInit = async (target) => {
      fs.rmdirSync(target);
      swap(target);
    };
    assert.equal(
      await f.code(f.call({ action: "create", name: `After-${kind}` })),
      "PROJECT_FOLDER_UNAVAILABLE",
      kind,
    );
  }
  // Swapped before git init: git never runs.
  let inits = 0;
  f.workflows.projects.gitInit = async () => inits++;
  const unchanged = f.workflows.projects.unchanged.bind(f.workflows.projects);
  f.workflows.projects.unchanged = async (target, made) => {
    f.workflows.projects.unchanged = unchanged;
    fs.rmdirSync(target);
    swaps.link(target);
    return unchanged(target, made);
  };
  assert.equal(
    await f.code(f.call({ action: "create", name: "Before" })),
    "PROJECT_FOLDER_UNAVAILABLE",
  );
  assert.equal(inits, 0);
  assert.deepEqual(fs.readdirSync(outside), ["keep"]);
  // The rollback removes only the folder the call made, never what replaced it.
  assert.deepEqual(entries(f.parent), ["After-folder", "After-link", "Before"]);
  assert.deepEqual(fs.readdirSync(path.join(f.parent, "After-folder")), ["theirs"]);
  for (const link of ["After-link", "Before"])
    assert.equal(fs.readlinkSync(path.join(f.parent, link)), outside);
  assert.equal(logged.mock.callCount(), 3);
  assert.deepEqual(f.projectIds(), known);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
});

test("the eleventh project within 24 hours is refused", async (t) => {
  const f = await agentProjectFixture(t);
  f.addRows(9, hourMs);
  f.addRows(1, 25 * hourMs);
  const tenth = await f.call({ action: "create", name: "Tenth" });
  assert.ok(tenth.projectId);
  assert.equal(
    await f.code(f.call({ action: "create", name: "Eleventh" })),
    "PROJECT_CREATE_LIMIT",
  );
  assert.ok(!fs.existsSync(path.join(f.parent, "Eleventh")));
});

test("parallel creates are serialized per agent", async (t) => {
  const f = await agentProjectFixture(t);
  const same = await Promise.all([
    f.code(f.call({ action: "create", name: "Same" })),
    f.code(f.call({ action: "create", name: "Same" })),
  ]);
  assert.deepEqual(same.filter(Boolean), ["PROJECT_EXISTS"]);
  assert.equal(same.filter((c) => c === null).length, 1);
  // With "Same", nine projects of the last 24 hours exist.
  f.addRows(8, hourMs);
  const limited = await Promise.all([
    f.code(f.call({ action: "create", name: "One" })),
    f.code(f.call({ action: "create", name: "Two" })),
  ]);
  assert.deepEqual(limited.filter(Boolean), ["PROJECT_CREATE_LIMIT"]);
  assert.equal(
    ["One", "Two"].filter((n) => fs.existsSync(path.join(f.parent, n))).length,
    1,
  );
});

test("only direct owner turns may use the tool", async (t) => {
  const f = await agentProjectFixture(t);
  const goal = { id: "g", anchorRequestId: "r", title: "Goal" };
  for (const origin of [
    { kind: "routine" },
    { kind: "owner", forwarded: true },
    { kind: "member-result" },
    { kind: "lead-request" },
    { kind: "owner", goal },
  ])
    for (const input of [{ action: "create", name: "Shop" }, { action: "list" }])
      assert.equal(
        await f.code(f.call(input, origin)),
        "PROJECT_OWNER_ONLY",
        JSON.stringify(origin),
      );
  for (const field of ["hook", "routine", "continuation"]) {
    const inv = await f.invocation(randomUUID());
    inv[field] = { id: "x" };
    assert.equal(
      await f.code(f.workflows.projects.invoke(inv, { action: "create", name: "Shop" })),
      "PROJECT_OWNER_ONLY",
      field,
    );
  }
  const noAttempt = { ...(await f.invocation(randomUUID())), attemptId: null };
  assert.equal(
    await f.code(f.workflows.projects.invoke(noAttempt, { action: "list" })),
    "PROJECT_OWNER_ONLY",
  );
  assert.deepEqual(fs.readdirSync(f.parent), []);
  const r = await f.call(
    { action: "create", name: "Shop" },
    { kind: "telegram", channelId: f.channel.id },
  );
  assert.equal(r.path, path.join(f.parent, "Shop"));
});

test("members, user agents and sender-facing agents are not eligible", async (t) => {
  const f = await agentProjectFixture(t);
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.equal(
    await f.code(f.call({ action: "create", name: "Shop" })),
    "PROJECT_NOT_ELIGIBLE",
  );
  delete f.services.assistantTelegramSenders;
  f.setAgent("userAccess", { mode: "shared", userIds: ["u"] });
  assert.equal(await f.code(f.call({ action: "list" })), "PROJECT_NOT_ELIGIBLE");
  f.setAgent("userAccess", null);
  f.setAgent("teamMemberId", "member");
  f.setAgent("lifetime", "permanent");
  assert.equal(
    await f.code(f.call({ action: "create", name: "Shop" })),
    "PROJECT_NOT_ELIGIBLE",
  );
  assert.deepEqual(fs.readdirSync(f.parent), []);
});

test("coding switches only projects the agent created", async (t) => {
  const f = await agentProjectFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  assert.equal(
    await f.code(f.call({ action: "coding", projectId: f.project.id, enabled: true })),
    "PROJECT_NOT_CREATED_BY_YOU",
  );
  assert.equal(f.workflows.access.sessionsEnabled(f.id, f.project.id), false);
  const r = await f.call({ action: "create", name: "Shop" });
  const rowsBefore = f.projectRows().length;
  assert.deepEqual(
    await f.call({ action: "coding", projectId: r.projectId, enabled: true }),
    { projectId: r.projectId, coding: true },
  );
  assert.equal(f.workflows.access.sessionsEnabled(f.id, r.projectId), true);
  const on = agentUpdates(f);
  assert.equal(on.length, 1);
  assert.equal(on[0].source, "agent");
  assert.equal(on[0].projectId, r.projectId);
  assert.deepEqual(on[0].details, {
    kind: "agent-project",
    change: "coding",
    coding: true,
  });
  const row = f.projectRows().at(-1);
  assert.equal(f.projectRows().length, rowsBefore + 1);
  assert.deepEqual(row.payload, {
    action: "agent_project",
    change: "coding",
    projectId: r.projectId,
    projectName: "Shop",
    path: r.path,
    coding: true,
    result: { projectId: r.projectId, coding: true },
  });
  // Switching on again changes nothing: no audit record, no new row.
  await f.call({ action: "coding", projectId: r.projectId, enabled: true });
  assert.equal(agentUpdates(f).length, 1);
  assert.equal(f.projectRows().length, rowsBefore + 1);
  assert.deepEqual(
    await f.call({ action: "coding", projectId: r.projectId, enabled: false }),
    { projectId: r.projectId, coding: false },
  );
  assert.equal(f.workflows.access.sessionsEnabled(f.id, r.projectId), false);
  assert.equal(agentUpdates(f).length, 2);
});

test("coding never re-grants a project the owner took away", async (t) => {
  const f = await agentProjectFixture(t);
  const r = await f.call({ action: "create", name: "Shop" });
  // A folder the owner downgraded to reading counts as taken away.
  const granted = f.workflows.access.stored(f.id);
  f.workflows.access.write(f.id, {
    ...granted,
    projectFiles: { ...granted.projectFiles, [r.projectId]: "read" },
    revision: granted.revision + 1,
  });
  assert.equal(
    await f.code(f.call({ action: "coding", projectId: r.projectId, enabled: true })),
    "PROJECT_NOT_GRANTED",
  );
  assert.equal(f.workflows.access.sessionsEnabled(f.id, r.projectId), false);
  f.workflows.access.revokeProject(r.projectId);
  const before = f.workflows.access.stored(f.id);
  assert.equal(
    await f.code(f.call({ action: "coding", projectId: r.projectId, enabled: true })),
    "PROJECT_NOT_GRANTED",
  );
  assert.deepEqual(f.workflows.access.stored(f.id), before);
  // The list tells the agent the folder is no longer granted.
  const [listed] = (await f.call({ action: "list" })).projects;
  assert.deepEqual([listed.folder, listed.coding], ["none", false]);
  // A project the owner removed from AgentPier drops out of the list.
  assert.ok(f.memory.removeEmpty(r.projectId));
  assert.deepEqual((await f.call({ action: "list" })).projects, []);
});

test("list returns the agent's own projects and their state", async (t) => {
  const f = await agentProjectFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  assert.deepEqual(await f.call({ action: "list" }), { projects: [] });
  const shop = await f.call({ action: "create", name: "Shop", coding: true });
  const notes = await f.call({ action: "create", name: "Notes", git: false });
  const { projects } = await f.call({ action: "list" });
  assert.deepEqual(
    projects.map(({ createdAt, ...p }) => (assert.ok(Date.parse(createdAt)), p)),
    [
      {
        projectId: shop.projectId,
        name: "Shop",
        path: shop.path,
        folder: "write",
        coding: true,
      },
      {
        projectId: notes.projectId,
        name: "Notes",
        path: notes.path,
        folder: "write",
        coding: false,
      },
    ],
  );
  // The owner's own project is never listed; listing writes nothing.
  assert.ok(!projects.some((p) => p.projectId === f.project.id));
  assert.equal(f.projectRows().length, 2);
});

test("a retried call returns the first result", async (t) => {
  const f = await agentProjectFixture(t);
  const inv = await f.invocation(randomUUID());
  const input = { action: "create", name: "Shop" };
  const [first, second] = await Promise.all([
    f.workflows.projects.invoke(inv, input),
    f.workflows.projects.invoke(inv, input),
  ]);
  const third = await f.workflows.projects.invoke(inv, input);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(entries(f.parent), ["Shop"]);
  assert.equal(f.workflows.projects.store.list(f.id).length, 1);
  const rows = f.projectRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.action, "agent_project");
  assert.equal(f.audit.filter((e) => e.action === "project.created").length, 1);
});
