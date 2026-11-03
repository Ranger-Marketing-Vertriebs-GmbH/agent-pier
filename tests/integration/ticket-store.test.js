import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";

const valid = {
  name: "Plane",
  baseUrl: "https://api.plane.so",
  workspaceSlug: "acme",
  token: "plane-secret",
};
const planeProject = "11111111-1111-4111-8111-111111111111";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-tickets-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store: new TicketStore({ dataDir }) };
}

test("a Plane connection keeps its token in a private file only", (t) => {
  const { dataDir, store } = fixture(t);
  const saved = store.createConnection({ ...valid, baseUrl: "https://api.plane.so/" });
  assert.deepEqual(Object.keys(saved).sort(), [
    "baseUrl",
    "createdAt",
    "hasSecret",
    "id",
    "kind",
    "name",
    "workspaceSlug",
  ]);
  assert.equal(saved.baseUrl, "https://api.plane.so");
  assert.equal(saved.hasSecret, true);
  assert.equal(
    fs
      .readFileSync(path.join(dataDir, "ticket-sources.json"), "utf8")
      .includes("plane-secret"),
    false,
  );
  const secret = path.join(dataDir, "ticket-source-secrets", `${saved.id}.json`);
  assert.equal(fs.statSync(secret).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(secret)).mode & 0o777, 0o700);
  store.updateConnection(saved.id, { name: "Renamed", token: "" });
  const reopened = new TicketStore({ dataDir });
  assert.equal(reopened.token(saved.id), "plane-secret");
  assert.equal(reopened.connection(saved.id).name, "Renamed");
  store.updateConnection(saved.id, { token: "other" });
  assert.equal(new TicketStore({ dataDir }).token(saved.id), "other");
  assert.throws(() => store.connection("missing"), { status: 404 });
});

test("refuses plain http off loopback, userinfo, query and bad slugs or tokens", (t) => {
  const { store } = fixture(t);
  for (const baseUrl of [
    "http://plane.example.com",
    "https://u:p@plane.example.com",
    "https://h/?x=1",
    "https://h/#x",
    "ftp://h",
    "",
  ])
    assert.throws(() => store.createConnection({ ...valid, baseUrl }), { status: 400 });
  assert.doesNotThrow(() =>
    store.createConnection({ ...valid, baseUrl: "http://127.0.0.1:9000" }),
  );
  assert.throws(() => store.createConnection({ ...valid, workspaceSlug: "../x" }), {
    status: 400,
  });
  assert.throws(() => store.createConnection({ ...valid, token: "" }), { status: 400 });
  assert.throws(() => store.createConnection({ ...valid, token: "a\nb" }), {
    status: 400,
  });
  assert.throws(() => store.createConnection({ ...valid, token: "x".repeat(16385) }), {
    status: 400,
  });
});

test("a linked connection cannot be removed", (t) => {
  const { dataDir, store } = fixture(t);
  const { id } = store.createConnection(valid);
  store.setProjectLink("p1", "/repo", {
    plane: {
      connectionId: id,
      planeProjectId: planeProject,
      identifier: "ACME",
      name: "Acme",
      inProgressStateId: null,
    },
  });
  assert.throws(() => store.removeConnection(id), { status: 409 });
  store.setProjectLink("p1", "/repo", { plane: null });
  store.removeConnection(id);
  assert.equal(store.listConnections().length, 0);
  assert.equal(
    fs.existsSync(path.join(dataDir, "ticket-source-secrets", `${id}.json`)),
    false,
  );
});

test("project links default to no Plane and the 'in progress' label", (t) => {
  const { dataDir, store } = fixture(t);
  assert.deepEqual(store.projectLink("p1"), {
    projectId: "p1",
    repoPath: null,
    plane: null,
    github: { inProgressLabel: "in progress" },
  });
  const link = store.setProjectLink("p1", "/repo", {
    github: { inProgressLabel: "doing" },
  });
  assert.equal(link.github.inProgressLabel, "doing");
  assert.equal(link.repoPath, "/repo");
  assert.equal(
    new TicketStore({ dataDir }).projectLink("p1").github.inProgressLabel,
    "doing",
  );
  assert.throws(
    () => store.setProjectLink("p1", "/repo", { github: { inProgressLabel: "a,b" } }),
    { status: 400 },
  );
  assert.throws(
    () =>
      store.setProjectLink("p1", "/repo", {
        plane: {
          connectionId: "nope",
          planeProjectId: planeProject,
          identifier: "ACME",
          name: "x",
        },
      }),
    { status: 404 },
  );
  assert.throws(
    () =>
      store.setProjectLink("p1", "/repo", {
        plane: { connectionId: "x", planeProjectId: "bad", identifier: "A", name: "x" },
      }),
    { status: 400 },
  );
});

test("start records are per project, newest first, capped at 500", (t) => {
  const { dataDir, store } = fixture(t);
  let clock = 1000;
  const base = { source: "github", kind: "session", targetId: "s" };
  for (let i = 0; i < 502; i++)
    store.addStart({
      ...base,
      projectId: i === 0 ? "other" : "p1",
      key: `o/r#${i}`,
      title: "t",
      url: "u",
      startedAt: clock++,
    });
  const mine = store.starts("p1");
  assert.ok(mine[0].startedAt > mine[1].startedAt);
  assert.equal(mine[0].key, "o/r#501");
  assert.equal(store.starts("other").length, 0, "the oldest record was dropped");
  assert.equal(store.startRecords.length, 500);
  assert.equal(store.findStart("p1", "github", "o/r#501").kind, "session");
  assert.equal(store.findStart("p1", "plane", "o/r#501"), undefined);
  const id = mine[0].id;
  assert.deepEqual(
    store.addStart({ ...base, projectId: "p2", key: "k", targetId: "t" }).writeBack,
    { state: "pending" },
  );
  const patched = store.patchStart(id, {
    writeBack: { state: "failed", code: "forbidden" },
  });
  assert.deepEqual(patched.writeBack, { state: "failed", code: "forbidden" });
  assert.deepEqual(
    new TicketStore({ dataDir }).findStart("p1", "github", "o/r#501").writeBack,
    { state: "failed", code: "forbidden" },
  );
  assert.throws(() => store.patchStart("missing", {}), { status: 404 });
  assert.throws(() => store.addStart({ ...base, projectId: "p1", key: "k", kind: "x" }), {
    status: 400,
  });
});
