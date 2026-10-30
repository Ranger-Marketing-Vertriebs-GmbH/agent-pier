import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

const put = (f, body) => f.request("/api/project-groups", { method: "PUT", body });

test("project groups: create, rename, reorder, move, remove and delete through PUT", async (t) => {
  const f = await applicationFixture(t);
  const empty = await (await f.request("/api/project-groups")).json();
  assert.deepEqual(empty, { version: 0, groups: [], assignments: {} });

  let response = await put(f, {
    version: 0,
    groups: [{ name: "Ranger" }, { name: "Private" }],
    assignments: {},
  });
  assert.equal(response.status, 200);
  let doc = await response.json();
  const [ranger, priv] = doc.groups;
  assert.equal(doc.version, 1);

  // Move projects in, rename, reorder.
  doc = await (
    await put(f, {
      version: 1,
      groups: [priv, { id: ranger.id, name: "Ranger GmbH" }],
      assignments: { "/work/a/": ranger.id, "/work/b": priv.id },
    })
  ).json();
  assert.deepEqual(
    doc.groups.map((g) => g.name),
    ["Private", "Ranger GmbH"],
  );
  assert.deepEqual(doc.assignments, { "/work/a": ranger.id, "/work/b": priv.id });
  assert.equal(doc.version, 2);

  // Remove one project from its group, move the other.
  doc = await (await put(f, { ...doc, assignments: { "/work/b": ranger.id } })).json();
  assert.deepEqual(doc.assignments, { "/work/b": ranger.id });

  // Delete a group: it goes, assignments to it must go with it in the same document.
  response = await put(f, { ...doc, groups: [priv] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "PROJECT_GROUP_ASSIGNMENT_INVALID");
  doc = await (await put(f, { ...doc, groups: [priv], assignments: {} })).json();
  assert.deepEqual(doc.groups, [priv]);
  assert.deepEqual(await (await f.request("/api/project-groups")).json(), doc);

  const saved = JSON.parse(
    await fs.readFile(path.join(f.dataDir, "project-groups.json"), "utf8"),
  );
  assert.deepEqual(saved, doc);
});

test("project groups: invalid names, unknown ids and bad bodies are refused", async (t) => {
  const f = await applicationFixture(t);
  const refused = async (body, code) => {
    const response = await put(f, body);
    assert.equal(response.status, 400);
    const answer = await response.json();
    assert.equal(answer.code, code);
    assert.equal(typeof answer.error, "string");
    assert.equal(typeof answer.messageKey, "string");
  };
  await refused(
    { version: 0, groups: [{ name: "  " }], assignments: {} },
    "PROJECT_GROUP_NAME_INVALID",
  );
  await refused(
    { version: 0, groups: [{ name: "x".repeat(61) }], assignments: {} },
    "PROJECT_GROUP_NAME_INVALID",
  );
  await refused(
    { version: 0, groups: [{ name: "A" }, { name: "a" }], assignments: {} },
    "PROJECT_GROUP_NAME_TAKEN",
  );
  await refused(
    { version: 0, groups: [{ id: "g_0000000000000000", name: "A" }], assignments: {} },
    "PROJECT_GROUP_UNKNOWN",
  );
  await refused({ version: 0, groups: [] }, "PROJECT_GROUP_INVALID");
  assert.equal((await (await f.request("/api/project-groups")).json()).version, 0);
});

test("project groups: a stale version is a 409 with the current document", async (t) => {
  const f = await applicationFixture(t);
  const first = await (
    await put(f, { version: 0, groups: [{ name: "A" }], assignments: {} })
  ).json();
  const stale = await put(f, { version: 0, groups: [{ name: "B" }], assignments: {} });
  assert.equal(stale.status, 409);
  const body = await stale.json();
  assert.equal(body.code, "PROJECT_GROUP_CONFLICT");
  assert.equal(typeof body.error, "string");
  const { code: _code, error: _error, messageKey: _key, ...document } = body;
  assert.deepEqual(document, first);
  assert.deepEqual(await (await f.request("/api/project-groups")).json(), first);
});

test("project groups: a write signals project-groups.changed", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "project-groups.changed" });
  const first = await live.next(
    (frame) => frame.topic === "project-groups.changed",
    5000,
  );
  assert.equal(first.type, "same");
  const changed = live.next((frame) => frame.topic === "project-groups.changed", 2000);
  assert.equal(
    (await put(f, { version: 0, groups: [{ name: "A" }], assignments: {} })).status,
    200,
  );
  assert.equal((await changed).type, "changed");
  live.ws.close();
});

test("project groups: a backup contains the file and a restore remaps the paths", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "restore-groups-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source"),
    target = path.join(root, "target"),
    project = path.join(root, "project"),
    other = path.join(root, "other"),
    destination = path.join(root, "destination");
  for (const dir of [project, destination]) await fs.mkdir(dir);
  const memory = new ProjectMemory({ dataDir: source });
  t.after(() => memory.close());
  const scope = await memory.register(project);
  const id = "g_0123456789abcdef";
  const document = {
    version: 4,
    groups: [{ id, name: "Ranger" }],
    assignments: { [scope.cwd]: id, [other]: id },
  };
  await fs.writeFile(path.join(source, "project-groups.json"), JSON.stringify(document));
  const backups = new Backup({ dataDir: source, home: root });
  assert.ok(backups.plan({}).components.includes("project-groups"));
  const backup = await backups.create();

  await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(target, "project-groups.json"), "utf8")),
    document,
  );

  const mapped = path.join(root, "target-mapped");
  await new Restore({ dataDir: source }).apply({
    archive: backup.file,
    targetDataDir: mapped,
    projectMap: { [scope.id]: destination },
  });
  const restored = JSON.parse(
    await fs.readFile(path.join(mapped, "project-groups.json"), "utf8"),
  );
  assert.equal(restored.version, 4);
  assert.deepEqual(restored.groups, document.groups);
  assert.deepEqual(restored.assignments, { [destination]: id, [other]: id });
});
