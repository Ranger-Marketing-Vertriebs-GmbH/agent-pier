import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyGroupsDocument,
  findGroupByName,
  groupForPath,
  groupNameProblem,
  normalizeGroupsDocument,
  withAssignment,
  withGroupAt,
  withNewGroup,
  withRenamedGroup,
  withoutGroup,
} from "../../web/features/projects/project-groups.js";
import {
  groupNameMessage,
  projectMenuItems,
} from "../../web/features/projects/project-menu.js";

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

  // Phones add "Merge older entry" after a separator, even without a group.
  const trigger = { id: "trigger" };
  const merged = [];
  const withMerge = (current) =>
    projectMenuItems({
      groups: doc.groups,
      current,
      onMove() {},
      onNewGroup() {},
      onRemove() {},
      onMerge: (from) => merged.push(from),
    });
  assert.deepEqual(
    withMerge(null).map((item) => item.id),
    ["move", "separator", "merge"],
  );
  const grouped = withMerge(doc.groups[0]);
  assert.deepEqual(
    grouped.map((item) => item.id),
    ["move", "separator", "remove", "merge"],
  );
  assert.equal(grouped[3].restoreFocus, false);
  grouped[3].run(trigger);
  assert.deepEqual(merged, [trigger]);
});

test("group names map to the inline messages", () => {
  assert.equal(groupNameMessage(doc, " "), "Gib einen Namen für die Gruppe ein.");
  assert.equal(
    groupNameMessage(doc, "work"),
    "Eine Gruppe mit diesem Namen gibt es schon.",
  );
  assert.equal(groupNameMessage(doc, "work", "g_1"), "");
});

test("rename, reorder and delete edit a copy of the document", () => {
  const renamed = withRenamedGroup(doc, "g_2", "  Games ");
  assert.deepEqual(renamed.groups, [
    { id: "g_1", name: "Work" },
    { id: "g_2", name: "Games" },
  ]);
  assert.equal(doc.groups[1].name, "Spiele");

  // Move up from shown index 1 lands at 0; re-applying the same absolute edit over
  // a document that already contains it changes nothing (a pending edit replayed).
  const up = withGroupAt(doc, "g_2", 0);
  assert.deepEqual(
    up.groups.map((group) => group.id),
    ["g_2", "g_1"],
  );
  assert.equal(withGroupAt(up, "g_2", 0), up);
  assert.equal(withGroupAt(doc, "g_x", 1), doc);

  const deleted = withoutGroup(doc, "g_1");
  assert.deepEqual(deleted.groups, [{ id: "g_2", name: "Spiele" }]);
  assert.equal("/w/a" in deleted.assignments, false);
  assert.equal(deleted.version, 4);
  assert.equal(doc.groups.length, 2);
});
