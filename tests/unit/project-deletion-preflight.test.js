import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  deletionScope,
  deletionToken,
} from "../../server/application/project-deletion-scope.js";
import {
  deletionBlockers,
  preflight,
  refusalMessage,
} from "../../server/application/project-deletion-preflight.js";

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const bus = (n) => String(n).repeat(64).slice(0, 64);
const noGit = async () => ({
  status: "none",
  worktrees: [],
  unpushedBranches: null,
  worktreesChecked: true,
});
const noProcesses = async () => ({ status: "ok", processes: [] });
const quiet = { scan: noProcesses, git: noGit };

/** A real temp folder with the stores the scope reads, faked in memory. */
function setup(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-preflight-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "work", "app");
  fs.mkdirSync(app, { recursive: true });
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "sessions"), { recursive: true });
  const rows = [],
    repositories = [],
    runs = new Map(),
    queue = new Map(),
    rebuilds = new Map(),
    live = new Map();
  const services = {
    config: { dataDir, home: path.join(root, "home") },
    memory: { projects: () => ({ projects: rows.map((row) => ({ ...row })) }) },
    repositories: { listProjects: () => repositories.map((item) => ({ ...item })) },
    agentbus: { root: path.join(dataDir, "agentbus") },
    sessions: {
      get: async (id) => {
        if (!live.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
        return live.get(id);
      },
    },
    pipelines: {
      store: {
        all: () => [...runs.values()],
        get: (id) => {
          if (!runs.has(id)) throw Object.assign(new Error("gone"), { status: 404 });
          return runs.get(id);
        },
      },
    },
    pipelineQueue: { store: { list: (projectId) => queue.get(projectId) ?? [] } },
    craftRebuilds: {
      list: () => [...rebuilds.values()],
      get: (id) => rebuilds.get(id) ?? null,
    },
  };
  const session = (id, data, state = { status: "stopped" }) => {
    fs.writeFileSync(
      path.join(dataDir, "sessions", `${id}.json`),
      JSON.stringify({ id, name: `Session ${id}`, tool: "codex", ...data }),
    );
    live.set(id, { id, name: `Session ${id}`, tool: "codex", ...data, ...state });
  };
  const row = (id, cwd, extra = {}) =>
    rows.push({
      id,
      name: path.basename(cwd),
      cwd,
      kind: "git",
      createdAt: "2026-01-01",
      ...extra,
    });
  return {
    root,
    app,
    dataDir,
    services,
    rows,
    repositories,
    runs,
    queue,
    rebuilds,
    session,
    row,
  };
}

test("scope joins every source of one folder", async (t) => {
  const f = setup(t);
  f.row("p-old", f.app, { name: "app (old)", createdAt: "2025-01-01" });
  f.row("p-new", f.app, { name: "App", createdAt: "2026-02-01" });
  f.row("p-other", path.join(f.root, "work", "app-two"));
  f.repositories.push(
    { id: "r1", name: "app-repo", path: `${f.app}/` },
    { id: "r2", name: "elsewhere", path: path.join(f.root, "elsewhere") },
  );
  f.session("s1", { cwd: f.app, agentbus: { enabled: true, projectId: bus("a") } });
  f.session("s2", { cwd: path.join(f.root, "x"), memory: { projectId: "p-old" } });
  f.session("s3", { cwd: path.join(f.root, "x"), secrets: { projectId: "p-other" } });
  f.runs.set("run1", {
    id: "run1",
    projectId: "p-new",
    cwd: "/elsewhere",
    status: "completed",
  });
  f.runs.set("run2", {
    id: "run2",
    projectId: null,
    cwd: path.join(f.app, ".agentpier-worktrees", "r"),
    status: "completed",
  });
  f.runs.set("run3", {
    id: "run3",
    projectId: "p-other",
    cwd: "/elsewhere",
    status: "running",
  });
  f.rebuilds.set("b1", {
    id: "b1",
    name: "Rebuild",
    folder: path.join(f.app, "rebuild"),
  });
  f.rebuilds.set("b2", { id: "b2", name: "Other", folder: path.join(f.root, "rebuild") });

  const scope = await deletionScope(f.services, `${f.app}/`);
  assert.equal(scope.path, f.app);
  assert.equal(scope.name, "App");
  assert.equal(scope.folderState, "present");
  assert.match(scope.dev, /^\d+$/);
  assert.match(scope.ino, /^\d+$/);
  assert.deepEqual(scope.projects, [
    {
      path: f.app,
      name: "App",
      memoryIds: ["p-new", "p-old"],
      repositoryIds: ["r1"],
      busIds: [bus("a")],
      main: true,
    },
  ]);
  assert.deepEqual(scope.projectIds.sort(), ["p-new", "p-old"]);
  assert.deepEqual(scope.repositoryIds, ["r1"]);
  assert.deepEqual(scope.busIds.sort(), [bus("a"), sha256(f.app)].sort());
  assert.deepEqual(scope.sessionIds.sort(), ["s1", "s2"]);
  assert.deepEqual(scope.runIds.sort(), ["run1", "run2"]);
  assert.deepEqual(scope.rebuildIds, ["b1"]);
});

test("a folder known only to AgentBus or a cloned repo is a project; others are not", async (t) => {
  const f = setup(t);
  f.session("s1", { cwd: f.app, agentbus: { enabled: true, projectId: bus("b") } });
  const scope = await deletionScope(f.services, f.app);
  assert.equal(scope.name, "app");
  assert.deepEqual(scope.projects[0].busIds, [bus("b")]);
  assert.deepEqual(scope.projectIds, []);

  const clone = path.join(f.root, "clone");
  f.repositories.push({ id: "r9", name: "Cloned", path: clone });
  const missing = await deletionScope(f.services, clone);
  assert.equal(missing.name, "Cloned");
  assert.equal(missing.folderState, "missing");
  assert.equal(missing.dev, "");

  for (const raw of [path.join(f.root, "work"), "relative/app", ""])
    await assert.rejects(deletionScope(f.services, raw), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "PROJECT_NOT_FOUND");
      return true;
    });
});

test("a scope is refused while session records cannot be read", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  fs.writeFileSync(path.join(f.dataDir, "sessions", "broken.json"), "{");
  await assert.rejects(deletionScope(f.services, f.app), (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "PROJECT_SESSIONS_UNREADABLE");
    return true;
  });
});

test("nested registered projects are in the scope and their sessions block", async (t) => {
  const f = setup(t);
  const nested = path.join(f.app, "packages", "lib");
  fs.mkdirSync(nested, { recursive: true });
  f.row("p-main", f.app);
  f.row("p-nested", nested, { name: "Lib" });
  f.session(
    "s-nested",
    { cwd: nested, agentbus: { enabled: true, projectId: bus("c") } },
    { status: "running" },
  );
  const report = await preflight(f.services, f.app, quiet);
  assert.deepEqual(
    report.projects.map(({ path: folder, name, main }) => ({ folder, name, main })),
    [
      { folder: f.app, name: "app", main: true },
      { folder: nested, name: "Lib", main: false },
    ],
  );
  assert.deepEqual(report.projects[1].busIds, [bus("c")]);
  assert.deepEqual(report.blockers.sessions, [
    { id: "s-nested", name: "Session s-nested", tool: "codex" },
  ]);
  assert.equal(report.ready, false);
  assert.deepEqual(
    report.git.map((item) => item.path),
    [f.app, nested],
  );
});

test("running sessions, unfinished runs, queued items and running rebuilds block", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  f.session("run", { cwd: f.app }, { status: "running" });
  f.session("stopped", { cwd: f.app });
  f.session(
    "reload",
    { cwd: f.app },
    { status: "stopped", reload: { state: "waiting" } },
  );
  f.session("agent", { cwd: f.app }, { status: "running" });
  f.services.assistantWorkflows = {
    sessions: { store: { get: (id) => (id === "agent" ? { assistantId: "a1" } : null) } },
  };
  f.runs.set("r1", {
    id: "r1",
    projectId: "p1",
    pipelineName: "Build",
    status: "running",
  });
  f.runs.set("r2", { id: "r2", projectId: "p1", pipelineName: "Old", status: "failed" });
  f.queue.set("p1", [
    { id: "q1", state: "queued" },
    { id: "q2", state: "starting" },
    { id: "q3", state: "failed" },
    { id: "q4", state: "started" },
  ]);
  f.rebuilds.set("b1", { id: "b1", name: "Busy", folder: f.app, status: "building" });
  f.rebuilds.set("b2", { id: "b2", name: "Paused", folder: f.app, status: "paused" });

  const scope = await deletionScope(f.services, f.app);
  const blockers = await deletionBlockers(f.services, scope);
  assert.deepEqual(
    blockers.sessions.sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: "agent", name: "Session agent", tool: "codex", agentId: "a1" },
      { id: "reload", name: "Session reload", tool: "codex" },
      { id: "run", name: "Session run", tool: "codex" },
    ],
  );
  assert.deepEqual(blockers.runs, [
    { id: "r1", pipelineName: "Build", status: "running" },
  ]);
  assert.deepEqual(blockers.queue, [
    { id: "q1", projectId: "p1", state: "queued" },
    { id: "q2", projectId: "p1", state: "starting" },
  ]);
  assert.deepEqual(blockers.rebuilds, [{ id: "b1", name: "Busy" }]);
  assert.equal((await preflight(f.services, f.app, quiet)).ready, false);
});

test("a process scan timeout blocks; a Git timeout only warns", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  const unchecked = async (folder) => ({
    status: "ok",
    worktrees: [
      {
        path: folder,
        branch: "main",
        inside: true,
        changes: null,
        unpushed: null,
        checked: false,
      },
    ],
    unpushedBranches: null,
    worktreesChecked: false,
  });
  const timedOut = await preflight(f.services, f.app, {
    scan: async () => ({ status: "timeout", processes: [] }),
    git: unchecked,
  });
  assert.deepEqual(timedOut.processes, { status: "timeout", list: [] });
  assert.equal(timedOut.refused, null);
  assert.equal(timedOut.ready, false);

  const warned = await preflight(f.services, f.app, {
    scan: noProcesses,
    git: unchecked,
  });
  assert.equal(warned.ready, true);
  assert.equal(warned.git[0].report.worktrees[0].checked, false);
  assert.equal(warned.git[0].report.worktreesChecked, false);

  const failed = await preflight(f.services, f.app, {
    scan: async () => ({ status: "failed", processes: [] }),
    git: noGit,
  });
  assert.equal(failed.ready, false);
});

test("a process using the folder blocks; one AgentPier needs refuses the delete", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  const context = async () => ({
    table: new Map(),
    sessionPanes: [],
    tmuxPid: 4242,
    gatewayPid: null,
  });
  const uid = process.getuid();
  const editor = { pid: 2 ** 30, name: "vim", uid, uses: "cwd" };
  const blocked = await preflight(f.services, f.app, {
    git: noGit,
    scan: async () => ({ status: "ok", processes: [editor] }),
    processContext: context,
    classify: (found, options) =>
      found.map((item) => ({ ...item, startTime: "t", protected: false, options })),
  });
  assert.equal(blocked.refused, null);
  assert.equal(blocked.processes.list.length, 1);
  assert.equal(blocked.processes.list[0].options.tmuxPid, 4242);
  assert.equal(blocked.ready, false);

  // The real classification: AgentPier's own server process is never offered.
  const server = { pid: process.pid, name: "node", uid, uses: "files" };
  const refused = await preflight(f.services, f.app, {
    git: noGit,
    scan: async () => ({ status: "ok", processes: [server] }),
    processContext: context,
  });
  assert.equal(refused.refused, "agentpier-process");
  assert.equal(refused.processes.list[0].protected, true);
  assert.equal(refused.ready, false);
  assert.match(refusalMessage("agentpier-process"), /AgentPier/);

  const noTable = await preflight(f.services, f.app, {
    git: noGit,
    scan: async () => ({ status: "ok", processes: [editor] }),
    processContext: async () => {
      throw new Error("ps failed");
    },
  });
  assert.deepEqual(noTable.processes, { status: "failed", list: [] });
  assert.equal(noTable.ready, false);
});

test("a dangerous path refuses before any scan", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  f.services.config.home = path.dirname(f.app);
  const never = async () => assert.fail("no scan or Git check for a refused folder");
  const report = await preflight(f.services, f.app, { scan: never, git: never });
  assert.equal(report.refused, "home-child");
  assert.deepEqual(report.processes, { status: "skipped", list: [] });
  assert.deepEqual(report.git, []);
  assert.equal(report.ready, false);

  // The registered path through a link is refused, not followed.
  f.services.config.home = path.join(f.root, "home");
  const link = path.join(f.root, "link");
  fs.symlinkSync(f.app, link);
  f.row("p-link", link);
  const linked = await preflight(f.services, link, { scan: never, git: never });
  assert.equal(linked.refused, "symlink");
});

test("a missing folder skips processes and Git", async (t) => {
  const f = setup(t);
  const gone = path.join(f.root, "work", "gone");
  f.row("p1", gone);
  f.session("s1", { cwd: gone });
  const never = async () => assert.fail("nothing to scan in a missing folder");
  const report = await preflight(f.services, gone, { scan: never, git: never });
  assert.equal(report.folderState, "missing");
  assert.equal(report.refused, null);
  assert.deepEqual(report.processes, { status: "skipped", list: [] });
  assert.deepEqual(report.git, []);
  assert.equal(report.ready, true);
});

test("an unavailable drive refuses the delete", async (t) => {
  const f = setup(t);
  f.row("p1", "/Volumes/agentpier-test-absent-drive/app");
  const never = async () => assert.fail("nothing to scan on a missing drive");
  const report = await preflight(f.services, "/Volumes/agentpier-test-absent-drive/app", {
    scan: never,
    git: never,
  });
  assert.equal(report.folderState, "unavailable");
  assert.equal(report.refused, "drive-unavailable");
  assert.equal(report.ready, false);
});

test("the token changes with the folder's inode and with a new nested project", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  const first = deletionToken(await deletionScope(f.services, f.app));
  assert.equal(deletionToken(await deletionScope(f.services, f.app)), first);
  assert.equal((await preflight(f.services, f.app, quiet)).token, first);

  fs.renameSync(f.app, `${f.app}-moved`);
  fs.mkdirSync(f.app);
  const replaced = deletionToken(await deletionScope(f.services, f.app));
  assert.notEqual(replaced, first);

  fs.mkdirSync(path.join(f.app, "nested"));
  f.row("p2", path.join(f.app, "nested"));
  assert.notEqual(deletionToken(await deletionScope(f.services, f.app)), replaced);
});

test("agents with grants, shares or member grants and their users are listed", async (t) => {
  const f = setup(t);
  f.row("p1", f.app);
  const policies = {
    coder: { revision: 1, projectIds: ["p1"], projectFiles: {} },
    reader: { revision: 1, projectIds: [], projectFiles: { p1: "read" } },
    idle: { revision: 1, projectIds: [], projectFiles: {} },
  };
  const profiles = [
    { id: "coder", name: "Coder" },
    {
      id: "reader",
      name: "Reader",
      userAccess: { mode: "shared", members: [{ userId: "u1" }, { userId: "gone" }] },
    },
    { id: "idle", name: "Idle" },
  ];
  f.services.assistants = { store: { listAssistants: () => profiles } };
  f.services.assistantWorkflows = {
    sessions: { store: { get: () => null } },
    access: {
      s: { memory: { project: () => ({}) } },
      get: (id) => policies[id] ?? { revision: 1, projectIds: [], projectFiles: {} },
    },
    shares: {
      list: (match) =>
        [
          {
            id: "sh1",
            projectId: "p1",
            memberAssistantId: "m1",
            memberName: "Shared",
            live: {},
          },
        ].filter(match),
    },
    memberGrants: {
      list: (match) =>
        [
          {
            id: "g1",
            kind: "project",
            projectId: "p1",
            memberAssistantId: "m2",
            memberName: "Member",
            live: {},
          },
        ].filter(match),
    },
  };
  f.services.users = {
    get: (id) => {
      if (id !== "u1") throw Object.assign(new Error("gone"), { status: 404 });
      return { id: "u1", username: "ute", displayName: "Ute" };
    },
  };
  const report = await preflight(f.services, f.app, quiet);
  assert.deepEqual(report.access, {
    agents: [
      { id: "coder", name: "Coder", via: "grant" },
      { id: "reader", name: "Reader", via: "grant" },
      { id: "m1", name: "Shared", via: "share" },
      { id: "m2", name: "Member", via: "member" },
    ],
    users: [{ id: "u1", name: "Ute" }],
  });
});

test("sources that name the folder through a link join the same project", async (t) => {
  const f = setup(t);
  const link = path.join(f.root, "via-link");
  fs.symlinkSync(f.app, link);
  fs.mkdirSync(path.join(f.app, "src"));
  f.row("p1", f.app);
  f.repositories.push({ id: "r1", name: "app", path: link });
  f.session("s1", { cwd: path.join(link, "src") });
  const scope = await deletionScope(f.services, f.app);
  assert.equal(scope.projects.length, 1);
  assert.deepEqual(scope.projects[0].repositoryIds, ["r1"]);
  assert.deepEqual(scope.sessionIds, ["s1"]);
});
