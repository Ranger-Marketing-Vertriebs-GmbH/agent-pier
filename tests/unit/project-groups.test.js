import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ProjectGroups,
  normalizeProjectPath,
  sanitizeDocument,
} from "../../server/features/projects/project-groups.js";

async function store(t, saved) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-groups-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (saved !== undefined)
    await fs.writeFile(
      path.join(dataDir, "project-groups.json"),
      typeof saved === "string" ? saved : JSON.stringify(saved),
    );
  const changes = [];
  const groups = new ProjectGroups({ dataDir, onChange: () => changes.push(1) });
  return { groups, changes, dataDir };
}
const code = (code) => (error) => error.code === code;

test("normalizeProjectPath strips trailing slashes and keeps the root", () => {
  assert.equal(normalizeProjectPath("/a/b///"), "/a/b");
  assert.equal(normalizeProjectPath("/"), "/");
  assert.equal(normalizeProjectPath("//"), "/");
  assert.equal(normalizeProjectPath(""), "");
  assert.equal(normalizeProjectPath(undefined), "");
});

test("a missing or corrupt file starts empty", async (t) => {
  for (const saved of [undefined, "{not json", "[]", "null", { groups: 4 }]) {
    const { groups } = await store(t, saved);
    assert.deepEqual(groups.get(), { version: 0, groups: [], assignments: {} });
  }
});

test("sanitizeDocument drops invalid groups and stale assignments", () => {
  const id = "g_0123456789abcdef";
  const other = "g_fedcba9876543210";
  const document = sanitizeDocument({
    version: 7,
    unknown: true,
    groups: [
      { id, name: " Ranger " },
      { id: other, name: "ranger" },
      { id: "bad", name: "Bad id" },
      { id: other, name: "" },
      { id: other, name: "x".repeat(61) },
      { id: other, name: "Other" },
      null,
    ],
    assignments: {
      "/a/b/": id,
      "/c": "g_00000000000000aa",
      relative: id,
      "/d": other,
      "/e": 3,
    },
  });
  assert.deepEqual(document, {
    version: 7,
    groups: [
      { id, name: "Ranger" },
      { id: other, name: "Other" },
    ],
    assignments: { "/a/b": id, "/d": other },
  });
});

test("get never returns an assignment to a group that is gone", async (t) => {
  const id = "g_0123456789abcdef";
  const { groups } = await store(t, {
    version: 2,
    groups: [{ id, name: "One" }],
    assignments: { "/a": id, "/b": "g_ffffffffffffffff" },
  });
  assert.deepEqual(groups.get().assignments, { "/a": id });
});

test("replace creates groups with server ids and bumps the version", async (t) => {
  const { groups, changes, dataDir } = await store(t);
  const created = groups.replace({
    version: 0,
    groups: [{ name: "  Ranger " }, { name: "Private" }],
    assignments: {},
  });
  assert.equal(created.version, 1);
  assert.deepEqual(
    created.groups.map((group) => group.name),
    ["Ranger", "Private"],
  );
  assert.ok(created.groups.every((group) => /^g_[a-f0-9]{16}$/.test(group.id)));
  assert.equal(changes.length, 1);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataDir, "project-groups.json"), "utf8")),
    created,
  );
  assert.deepEqual(
    new ProjectGroups({ dataDir }).get(),
    created,
    "a new instance reads the saved document",
  );
});

test("replace renames, reorders, assigns and normalises paths", (t) => {
  return store(t).then(({ groups }) => {
    const { groups: made } = groups.replace({
      version: 0,
      groups: [{ name: "A" }, { name: "B" }],
      assignments: {},
    });
    const [a, b] = made;
    const next = groups.replace({
      version: 1,
      groups: [{ id: b.id, name: "B2" }, a],
      assignments: { "/work/x/": a.id, "/work/y": b.id },
    });
    assert.deepEqual(next.groups, [{ id: b.id, name: "B2" }, a]);
    assert.deepEqual(next.assignments, { "/work/x": a.id, "/work/y": b.id });
    assert.equal(next.version, 2);
  });
});

test("replace refuses invalid names and duplicate names", async (t) => {
  const { groups, changes } = await store(t);
  const attempt = (names) =>
    groups.replace({
      version: groups.get().version,
      groups: names.map((name) => ({ name })),
      assignments: {},
    });
  for (const name of ["", "   ", "x".repeat(61), "tab\there", 5, null])
    assert.throws(() => attempt([name]), code("PROJECT_GROUP_NAME_INVALID"));
  assert.doesNotThrow(() => attempt(["x".repeat(60)]));
  assert.throws(() => attempt(["Ranger", " RANGER "]), code("PROJECT_GROUP_NAME_TAKEN"));
  assert.equal(changes.length, 1);
});

test("replace refuses unknown ids, bad assignments and malformed bodies", async (t) => {
  const { groups } = await store(t);
  const base = groups.replace({ version: 0, groups: [{ name: "A" }], assignments: {} });
  const id = base.groups[0].id;
  assert.throws(
    () =>
      groups.replace({
        version: 1,
        groups: [{ id: "g_ffffffffffffffff", name: "A" }],
        assignments: {},
      }),
    code("PROJECT_GROUP_UNKNOWN"),
  );
  assert.throws(
    () =>
      groups.replace({
        version: 1,
        groups: [
          { id, name: "A" },
          { id, name: "B" },
        ],
        assignments: {},
      }),
    code("PROJECT_GROUP_UNKNOWN"),
  );
  for (const assignments of [
    { relative: id },
    { "/a": "g_ffffffffffffffff" },
    { "/a": 3 },
  ])
    assert.throws(
      () => groups.replace({ version: 1, groups: base.groups, assignments }),
      code("PROJECT_GROUP_ASSIGNMENT_INVALID"),
    );
  for (const body of [
    null,
    [],
    { version: 1 },
    { version: "1", groups: [], assignments: {} },
    { version: 1, groups: {}, assignments: {} },
    { version: 1, groups: [], assignments: [] },
    { version: 1, groups: [], assignments: {}, extra: 1 },
    { version: 1, groups: [{ name: "A", extra: 1 }], assignments: {} },
  ])
    assert.throws(() => groups.replace(body), code("PROJECT_GROUP_INVALID"));
  assert.equal(groups.get().version, 1, "nothing was written");
});

test("a stale version is a conflict and writes nothing", async (t) => {
  const { groups, changes } = await store(t);
  groups.replace({ version: 0, groups: [{ name: "A" }], assignments: {} });
  assert.throws(
    () => groups.replace({ version: 0, groups: [], assignments: {} }),
    code("PROJECT_GROUP_CONFLICT"),
  );
  assert.equal(groups.get().groups.length, 1);
  assert.equal(changes.length, 1);
});

test("replace limits the number of groups and assignments", async (t) => {
  const { groups } = await store(t);
  assert.throws(
    () =>
      groups.replace({
        version: 0,
        groups: Array.from({ length: 201 }, (_, i) => ({ name: `G${i}` })),
        assignments: {},
      }),
    code("PROJECT_GROUP_LIMIT"),
  );
});
