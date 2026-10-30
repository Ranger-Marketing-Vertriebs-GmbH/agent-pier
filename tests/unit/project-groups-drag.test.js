import test from "node:test";
import assert from "node:assert/strict";
import {
  autoScrollStep,
  dropTarget,
  passedThreshold,
  sameTarget,
  sectionAt,
} from "../../web/features/projects/project-drag.js";
import { withGroupAt } from "../../web/features/projects/project-groups.js";

// The scroller spans y 100..500; three groups and "No group" stacked inside it.
const list = { left: 0, right: 340, top: 100, bottom: 500 };
const sections = [
  { key: "group:a", groupId: "a", top: 100, bottom: 200 },
  { key: "group:b", groupId: "b", top: 200, bottom: 240 },
  { key: "group:c", groupId: "c", top: 240, bottom: 280 },
  { key: "ungrouped", groupId: null, top: 280, bottom: 400 },
];
const at = (y, x = 50) => ({ x, y });
const target = (source, point) => dropTarget({ source, point, list, sections });

test("a press becomes a drag after 4px of movement", () => {
  assert.equal(passedThreshold(at(10, 10), at(12, 12)), false);
  assert.equal(passedThreshold(at(10, 10), at(14, 10)), true);
  assert.equal(passedThreshold(at(10, 10), at(10, 7)), false);
});

test("a project lands in the section under the pointer, never in its own group", () => {
  const project = { type: "project", groupId: "a" };
  assert.deepEqual(target(project, at(220)), {
    type: "assign",
    groupId: "b",
    key: "group:b",
  });
  assert.deepEqual(target(project, at(399)), {
    type: "assign",
    groupId: null,
    key: "ungrouped",
  });
  assert.equal(target(project, at(150)), null, "its own group");
  assert.equal(target({ type: "project", groupId: null }, at(300)), null);
  assert.deepEqual(target({ type: "project", groupId: null }, at(150)).groupId, "a");
  // Below the last section, or outside the list, nothing happens.
  assert.equal(target(project, at(450)), null);
  assert.equal(target(project, at(220, 400)), null);
  assert.equal(target(project, at(50)), null);
  // Origin sections (no groupId key) are no targets.
  assert.equal(
    dropTarget({
      source: project,
      point: at(150),
      list,
      sections: [{ key: "origin:x", top: 100, bottom: 200 }],
    }),
    null,
  );
});

test("a group lands between groups by their midpoints; its own place is no target", () => {
  const a = { type: "group", groupId: "a" };
  assert.equal(target(a, at(140)), null, "above a's midpoint: a stays first");
  assert.equal(target(a, at(215)), null, "between a and b: a's own place");
  assert.deepEqual(target(a, at(225)), { type: "reorder", index: 1, before: 2 });
  assert.deepEqual(target(a, at(265)), { type: "reorder", index: 2, before: 3 });
  // Over "No group" a group goes last among the groups.
  assert.deepEqual(target(a, at(350)), { type: "reorder", index: 2, before: 3 });

  const c = { type: "group", groupId: "c" };
  assert.deepEqual(target(c, at(120)), { type: "reorder", index: 0, before: 0 });
  assert.deepEqual(target(c, at(210)), { type: "reorder", index: 1, before: 1 });
  assert.equal(target(c, at(250)), null);
  assert.equal(target(c, at(350)), null);
  assert.equal(target({ type: "group", groupId: "gone" }, at(120)), null);
  assert.equal(target(c, at(120, -5)), null, "outside the list");
});

test("helpers: section lookup, target equality, auto-scroll speed", () => {
  assert.equal(sectionAt(sections, 200).key, "group:b");
  assert.equal(sectionAt(sections, 400), null);

  assert.equal(sameTarget(null, null), true);
  assert.equal(sameTarget(null, { type: "assign", groupId: null }), false);
  assert.equal(
    sameTarget({ type: "assign", groupId: null }, { type: "assign", groupId: null }),
    true,
  );
  assert.equal(
    sameTarget(
      { type: "reorder", index: 1, before: 2 },
      { type: "reorder", index: 1, before: 1 },
    ),
    false,
  );

  assert.equal(autoScrollStep(300, list), 0);
  assert.equal(autoScrollStep(140, list), 0);
  assert.ok(autoScrollStep(130, list) < 0);
  assert.ok(autoScrollStep(100, list) < autoScrollStep(130, list), "faster at the edge");
  assert.equal(autoScrollStep(40, list), autoScrollStep(100, list), "capped");
  assert.ok(autoScrollStep(480, list) > 0);
});

test("withGroupAt moves a group to an absolute position", () => {
  const doc = {
    version: 2,
    groups: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
      { id: "c", name: "C" },
    ],
    assignments: { "/x": "a" },
  };
  const ids = (document) => document.groups.map((group) => group.id);
  assert.deepEqual(ids(withGroupAt(doc, "a", 2)), ["b", "c", "a"]);
  assert.deepEqual(ids(withGroupAt(doc, "c", 0)), ["c", "a", "b"]);
  assert.deepEqual(ids(withGroupAt(doc, "a", 1)), ["b", "a", "c"]);
  assert.deepEqual(ids(withGroupAt(doc, "c", 9)), ["a", "b", "c"]);
  assert.equal(withGroupAt(doc, "b", 1), doc);
  assert.equal(withGroupAt(doc, "x", 0), doc);
  assert.deepEqual(withGroupAt(doc, "a", 2).assignments, doc.assignments);
  assert.deepEqual(ids(doc), ["a", "b", "c"], "unchanged");
});
