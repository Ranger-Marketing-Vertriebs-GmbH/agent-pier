import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { deletionScope } from "../../server/application/project-deletion-scope.js";

const timeout = 60000;
const enc = encodeURIComponent;
const changedFrame = (frame) =>
  frame.topic === "projects.changed" && frame.type === "changed";

async function projectIn(f, name) {
  const folder = path.join(f.root, name);
  fs.mkdirSync(folder);
  const project = await f.application.memory.register(folder);
  f.application.memory.write(project.id, { title: "Note", content: "Doomed knowledge" });
  return { folder, id: project.id };
}
const listed = async (f) => await (await f.request("/api/memory/projects")).json();
const post = (f, endpoint, body) => f.request(endpoint, { method: "POST", body });

async function mark(a, folder) {
  const scope = await deletionScope(a, folder);
  a.memory.deletions.mark(scope.path, {
    name: scope.name,
    folderMissing: false,
    dev: scope.dev,
    ino: scope.ino,
    projectIds: scope.projectIds,
    repositoryIds: scope.repositoryIds,
    busIds: scope.busIds,
    sessionIds: scope.sessionIds,
    runIds: scope.runIds,
    rebuildIds: scope.rebuildIds,
    nested: [],
    report: {
      unsavedGitWork: false,
      nestedProjectIds: [],
      endedSessionIds: [],
      endedProcesses: [],
    },
  });
}

test(
  "the owner previews and deletes a project; it disappears live",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    const { folder } = await projectIn(f, "doomed");
    const live = openLive(f);
    await live.next((frame) => frame.type === "hello");
    live.send({ op: "sub", topic: "projects.changed" });
    await live.next((frame) => frame.topic === "projects.changed", 5000);

    const report = await (
      await f.request(`/api/project-deletion?path=${enc(folder)}`)
    ).json();
    assert.equal(report.ready, true);
    const before = (await listed(f)).projects.find((p) => p.cwd === folder);
    assert.equal(before.folder, "present");
    assert.equal(before.deletion, null);

    const signalled = live.next(changedFrame, 5000);
    const started = await post(f, "/api/project-deletion", {
      path: folder,
      token: report.token,
      name: report.name,
    });
    assert.equal(started.status, 202);
    assert.deepEqual(await started.json(), { state: "deleting" });
    await f.application.projectDeletion.settled(folder);
    assert.equal((await signalled).type, "changed");
    assert.equal(fs.existsSync(folder), false);
    const after = await listed(f);
    assert.equal(
      after.projects.some((p) => p.cwd === folder),
      false,
    );
    assert.deepEqual(after.deletions, []);
    const events = f.application.audit.list({ action: "project.deleted" }).events;
    assert.equal(events.at(-1).details.path, folder);
    live.ws.close();
  },
);

test(
  "a missing folder is listed as missing and removed without a name",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    const { folder, id } = await projectIn(f, "gone");
    fs.rmSync(folder, { recursive: true });
    const row = (await listed(f)).projects.find((p) => p.cwd === folder);
    assert.equal(row.folder, "missing");
    const report = await (
      await f.request(`/api/project-deletion?path=${enc(folder)}`)
    ).json();
    assert.equal(report.folderState, "missing");
    const started = await post(f, "/api/project-deletion", {
      path: folder,
      token: report.token,
    });
    assert.equal(started.status, 202);
    await f.application.projectDeletion.settled(folder);
    assert.equal(f.application.memory.hasProject(id), false);
  },
);

test(
  "a present folder needs its name; a wrong token is stale",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    const { folder } = await projectIn(f, "named");
    const report = await (
      await f.request(`/api/project-deletion?path=${enc(folder)}`)
    ).json();
    const noName = await post(f, "/api/project-deletion", {
      path: folder,
      token: report.token,
    });
    assert.equal(noName.status, 400);
    assert.equal((await noName.json()).code, "PROJECT_DELETE_NAME");
    const stale = await post(f, "/api/project-deletion", {
      path: folder,
      token: "0".repeat(64),
      name: report.name,
    });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "PROJECT_DELETE_STALE");
    assert.equal(fs.existsSync(folder), true);
  },
);

test("a refused folder reports its reason", async (t) => {
  const f = await applicationFixture(t);
  // The folder AgentPier's own data lives in is never deleted.
  const { folder } = await projectIn(f, "own");
  f.application.config.dataDir = folder;
  const report = await (
    await f.request(`/api/project-deletion?path=${enc(folder)}`)
  ).json();
  assert.equal(report.refused, "agentpier");
  const refused = await post(f, "/api/project-deletion", {
    path: folder,
    token: report.token,
    name: report.name,
  });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, "PROJECT_DELETE_REFUSED");
  assert.equal(body.reason, "agentpier");
  assert.equal(fs.existsSync(folder), true);
});

test("malformed requests are refused", async (t) => {
  const f = await applicationFixture(t);
  for (const query of ["", "?path=relative/dir", `?path=${enc("/a\nb")}`])
    assert.equal((await f.request(`/api/project-deletion${query}`)).status, 400, query);
  for (const body of [
    { path: "/x", token: "short" },
    { path: 5, token: "0".repeat(64) },
    { path: "/x", token: "0".repeat(64), name: 3 },
  ])
    assert.equal((await post(f, "/api/project-deletion", body)).status, 400);
  assert.equal(
    (
      await post(f, "/api/project-deletion/blockers", {
        path: "/x",
        token: "0".repeat(64),
        processes: "all",
      })
    ).status,
    400,
  );
  assert.equal((await post(f, "/api/project-deletion/retry", {})).status, 400);
});

test(
  "a deleting project is listed in deletions; retry needs a failed one",
  { timeout },
  async (t) => {
    const f = await applicationFixture(t);
    const { folder } = await projectIn(f, "marked");
    await mark(f.application, folder);
    const body = await listed(f);
    assert.deepEqual(body.deletions, [{ path: folder, state: "deleting", error: null }]);
    assert.deepEqual(body.projects.find((p) => p.cwd === folder).deletion, {
      state: "deleting",
      error: null,
    });
    const retry = await post(f, "/api/project-deletion/retry", { path: folder });
    assert.equal(retry.status, 409);
    assert.equal((await retry.json()).code, "PROJECT_DELETE_NOT_FAILED");
    const again = await post(f, "/api/project-deletion", {
      path: folder,
      token: "0".repeat(64),
    });
    assert.equal((await again.json()).code, "PROJECT_DELETING");
    f.application.memory.deletions.fail(folder, "PROJECT_DELETE_FAILED");
    assert.equal((await listed(f)).deletions[0].state, "failed");
    const repositories = await (await f.request("/api/repositories")).json();
    assert.ok(Array.isArray(repositories.projects));
  },
);

test("a restricted user cannot reach the deletion routes", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  const as = (endpoint, method, body) =>
    f.request(endpoint, { method, body, headers: { cookie } });
  const token = "0".repeat(64);
  for (const [endpoint, method, body] of [
    [`/api/project-deletion?path=${enc(f.root)}`, "GET"],
    ["/api/project-deletion/blockers", "POST", { path: f.root, token }],
    ["/api/project-deletion", "POST", { path: f.root, token }],
    ["/api/project-deletion/retry", "POST", { path: f.root }],
  ])
    assert.equal((await as(endpoint, method, body)).status, 404, endpoint);
});
