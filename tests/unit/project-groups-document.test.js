import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyGroupsDocument,
  findGroupByName,
  groupForPath,
  groupNameProblem,
  normalizeGroupsDocument,
  withAssignment,
  withNewGroup,
} from "../../web/features/projects/project-groups.js";
import { projectMenuItems } from "../../web/features/projects/project-menu.js";

const doc = normalizeGroupsDocument({
  version: 4,
  groups: [
    { id: "g_1", name: "Work", extra: true },
    { id: "g_2", name: "Spiele" },
  ],
  assignments: { "/w/a/": "g_1", "/w/b": "g_gone", "/w/c": 7 },
  code: "PROJECT_GROUP_CONFLICT",
});

test("the server's document is read without extra keys, paths normalised", () => {
  assert.deepEqual(doc, {
    version: 4,
    groups: [
      { id: "g_1", name: "Work" },
      { id: "g_2", name: "Spiele" },
    ],
    assignments: { "/w/a": "g_1", "/w/b": "g_gone" },
  });
  assert.deepEqual(normalizeGroupsDocument({}), { ...emptyGroupsDocument });
  assert.deepEqual(normalizeGroupsDocument(null), { ...emptyGroupsDocument });
});

test("a project's group is found by its normalised path; stale ids are no group", () => {
  assert.deepEqual(groupForPath(doc, "/w/a/"), { id: "g_1", name: "Work" });
  assert.equal(groupForPath(doc, "/w/b"), null);
  assert.equal(groupForPath(doc, "/w/none"), null);
});

test("group names are refused when empty or taken, ignoring case and spaces", () => {
  assert.equal(groupNameProblem(doc, "  "), "required");
  assert.equal(groupNameProblem(doc, " work "), "taken");
  assert.equal(groupNameProblem(doc, "Work", "g_1"), "");
  assert.equal(groupNameProblem(doc, "Kunden"), "");
  assert.equal(findGroupByName(doc, "SPIELE").id, "g_2");
});

test("edits return new documents and leave the original untouched", () => {
  const added = withNewGroup(doc, "  Kunden ");
  assert.deepEqual(added.groups.at(-1), { name: "Kunden" });
  assert.equal(doc.groups.length, 2);

  const moved = withAssignment(doc, "/w/new/", "g_2");
  assert.equal(moved.assignments["/w/new"], "g_2");
  assert.equal(doc.assignments["/w/new"], undefined);
  const removed = withAssignment(moved, "/w/a", null);
  assert.equal("/w/a" in removed.assignments, false);
  assert.equal(removed.version, 4);
});

test("the project menu lists groups as radio items and removal only when grouped", () => {
  const calls = [];
  const items = projectMenuItems({
    groups: doc.groups,
    current: doc.groups[0],
    onMove: (id) => calls.push(["move", id]),
    onNewGroup: () => calls.push(["new"]),
    onRemove: () => calls.push(["remove"]),
  });
  assert.deepEqual(
    items.map((item) => item.kind || "item"),
    ["group", "separator", "item"],
  );
  const [work, games, add] = items[0].items;
  assert.deepEqual([work.checked, games.checked, add.checked], [true, false, undefined]);
  work.run();
  games.run();
  add.run();
  items[2].run();
  assert.deepEqual(calls, [["move", "g_2"], ["new"], ["remove"]]);

  const ungrouped = projectMenuItems({
    groups: doc.groups,
    current: null,
    onMove() {},
    onNewGroup() {},
    onRemove() {},
  });
  assert.deepEqual(
    ungrouped.map((item) => item.id),
    ["move"],
  );
});
