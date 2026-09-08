import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { callMemoryTool } from "../../server/features/memory/memory-tools.js";
import { setTimeout as delay } from "node:timers/promises";

async function launchMemorySession(app, exitFile = null) {
  const program = path.join(app.root, "synthetic-agent.cjs");
  const readyFile = path.join(app.root, "synthetic-ready.json");
  const exitedFile = path.join(app.root, "synthetic-exit-observed.json");
  await fs.writeFile(
    program,
    `const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(readyFile)}, JSON.stringify({ pid: process.pid, parentPid: process.ppid, node: process.version }));
    setInterval(() => {
      if (${JSON.stringify(exitFile)} && fs.existsSync(${JSON.stringify(exitFile)})) {
        fs.writeFileSync(${JSON.stringify(exitedFile)}, JSON.stringify({ pid: process.pid, exitCode: 0 }));
        process.exit(0);
      }
    }, 20);`,
  );
  app.application.accounts.command = () => ({
    command: process.execPath,
    args: [program],
    env: { HOME: app.home, PATH: path.dirname(process.execPath) },
    launchMode: "default",
  });
  const response = await app.request("/api/sessions", {
    method: "POST",
    body: {
      accountId: "local-claude",
      name: "Memory fixture",
      cwd: app.home,
      agentbus: false,
    },
  });
  assert.equal(response.status, 201);
  const session = await response.json();
  const deadline = Date.now() + 5000;
  do {
    if (await fs.stat(readyFile).catch(() => null)) return session;
    await delay(20);
  } while (Date.now() < deadline);
  assert.fail(`Synthetic agent did not start: ${await exitDiagnostics(app, session)}`);
}

async function exitDiagnostics(app, session) {
  const markers = {};
  for (const name of ["synthetic-ready.json", "synthetic-exit-observed.json"])
    markers[name] = await fs
      .readFile(path.join(app.root, name), "utf8")
      .catch((error) => error.code);
  let childAlive = null;
  try {
    const { pid } = JSON.parse(markers["synthetic-ready.json"]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        childAlive = true;
      } catch (error) {
        childAlive = error.code === "ESRCH" ? false : error.code;
      }
    }
  } catch {}
  const panes = await app.application.sessions
    .tmux([
      "list-panes",
      "-t",
      `${app.application.sessions.target(session.id)}:`,
      "-F",
      "dead=#{pane_dead}|status=#{pane_dead_status}|signal=#{pane_dead_signal}|pid=#{pane_pid}|dead_time=#{pane_dead_time}",
    ])
    .catch((error) => error.message);
  return JSON.stringify({ markers, childAlive, panes });
}

function searchMemory(app, session) {
  return callMemoryTool(app.application.memory, session.id, "memory_search", {});
}

async function project(app, name) {
  const cwd = path.join(app.root, name);
  await fs.mkdir(cwd);
  const response = await app.request("/api/memory/projects", {
    method: "POST",
    body: { cwd },
  });
  assert.equal(response.status, 201);
  return response.json();
}

test("memory HTTP lifecycle keeps revisions, handles conflicts and survives restart", async (t) => {
  const app = await applicationFixture(t);
  const scope = await project(app, "project");
  const base = `/api/memory/projects/${scope.id}/entries`;
  let response = await app.request(base, {
    method: "POST",
    body: {
      title: "Build command",
      content: "Run npm test before publishing.",
      provenance: { kind: "session", tool: "codex" },
    },
  });
  assert.equal(response.status, 201);
  const first = await response.json();
  assert.deepEqual(first.provenance, { kind: "user" });
  response = await app.request(`${base}/${first.id}`, {
    method: "PATCH",
    body: { title: "Build command", content: "Run npm run check.", expectedRevision: 1 },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 2);
  response = await app.request(`${base}/${first.id}`, {
    method: "PATCH",
    body: { title: "Stale write", content: "Outdated content", expectedRevision: 1 },
  });
  assert.equal(response.status, 409);
  await app.restart();
  response = await app.request(`${base}?q=check`);
  assert.equal((await response.json()).total, 1);
  response = await app.request(`${base}/${first.id}/revisions`);
  assert.equal((await response.json()).total, 2);
  response = await app.request(`${base}/${first.id}/archive`, {
    method: "POST",
    body: { expectedRevision: 2, archived: true },
  });
  assert.equal(response.status, 200);
  assert.equal((await (await app.request(base)).json()).total, 0);
  assert.equal((await (await app.request(base + "?archived=true")).json()).total, 1);
  response = await app.request(`${base}/${first.id}/archive`, {
    method: "POST",
    body: { expectedRevision: 3, archived: false },
  });
  assert.equal(response.status, 200);
  assert.equal((await (await app.request(base)).json()).total, 1);
});

test("memory routes enforce scope, pagination and origins without trusting supplied identity", async (t) => {
  const app = await applicationFixture(t);
  const a = await project(app, "first"),
    b = await project(app, "second");
  const base = `/api/memory/projects/${a.id}/entries`;
  const created = await app.request(base, {
    method: "POST",
    body: { title: "Scope", content: "Only this project" },
  });
  const entry = await created.json();
  assert.equal(
    (await app.request(`/api/memory/projects/${b.id}/entries/${entry.id}`)).status,
    404,
  );
  assert.equal((await app.request(base + "?page=-1")).status, 400);
  assert.equal((await app.request(base + "?archived=maybe")).status, 400);
  assert.equal(
    (
      await app.request(base, {
        method: "POST",
        origin: "https://foreign.example",
        body: { title: "No", content: "No" },
      })
    ).status,
    403,
  );
  const projects = await (await app.request("/api/memory/projects")).json();
  assert.equal(projects.projects.length, 2);
});

test("coding launches receive memory even without AgentBus and deletion keeps project knowledge", async (t) => {
  const app = await applicationFixture(t);
  const session = await launchMemorySession(app);
  assert.equal(session.memory.enabled, true);
  assert.equal(session.agentbus.enabled, false);
  const entry = await app.request(
    `/api/memory/projects/${session.memory.projectId}/entries`,
    {
      method: "POST",
      body: { title: "Durable finding", content: "This knowledge outlives its writer." },
    },
  );
  assert.equal(entry.status, 201);
  assert.equal(searchMemory(app, session).total, 1);
  await app.restart();
  assert.equal((await app.application.sessions.get(session.id)).status, "running");
  assert.equal(searchMemory(app, session).total, 1);
  assert.equal(
    (await app.request(`/api/sessions/${session.id}/stop`, { method: "POST", body: {} }))
      .status,
    200,
  );
  assert.throws(() => searchMemory(app, session), { status: 403 });
  assert.equal(
    (await app.request(`/api/sessions/${session.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (
      await (
        await app.request(`/api/memory/projects/${session.memory.projectId}/entries`)
      ).json()
    ).total,
    1,
  );
});

for (const reader of ["get", "list"]) {
  test(`memory access is revoked when ${reader} observes a natural terminal exit`, async (t) => {
    const app = await applicationFixture(t);
    const exitFile = path.join(app.root, "exit-requested");
    const session = await launchMemorySession(app, exitFile);
    assert.equal(searchMemory(app, session).total, 0);
    await app.restart();
    assert.equal(searchMemory(app, session).total, 0);
    await fs.writeFile(exitFile, "exit");
    const deadline = Date.now() + 5000;
    let observed;
    do {
      observed =
        reader === "get"
          ? await app.application.sessions.get(session.id)
          : (await app.application.sessions.list()).find(
              (item) => item.id === session.id,
            );
      if (observed.status === "stopped") break;
      await delay(20);
    } while (Date.now() < deadline);
    assert.equal(
      observed.status,
      "stopped",
      observed.status === "stopped" ? undefined : await exitDiagnostics(app, session),
    );
    assert.equal(observed.exitCode, 0);
    const exited = JSON.parse(
      await fs.readFile(path.join(app.root, "synthetic-exit-observed.json"), "utf8"),
    );
    assert.equal(exited.exitCode, 0);
    assert.throws(() => searchMemory(app, session), { status: 403 });
    await app.restart();
    assert.equal((await app.application.sessions.get(session.id)).status, "stopped");
    assert.throws(() => searchMemory(app, session), { status: 403 });
  });
}
