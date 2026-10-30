import test from "node:test";
import assert from "node:assert/strict";
import { buildProjectSections } from "../../web/features/projects/project-groups.js";

const p = (name, remote = "", path = `/w/${name}`) => ({ name, remote, path });
const projects = [
  p("zeta", "https://github.com/Acme/zeta.git"),
  p("alpha", "git@github.com:beta-org/alpha.git"),
  p("Bravo"),
  p("delta", "https://github.com/acme/delta"),
];
const doc = {
  groups: [
    { id: "g_1", name: "Work" },
    { id: "g_2", name: "Empty" },
  ],
  assignments: {
    "/w/zeta": "g_1",
    "/w/Bravo": "g_1",
    "/w/gone": "g_1",
    "/w/delta": "g_unknown",
  },
};
const keys = (sections) => sections.map((s) => s.key);
const names = (s) => s.projects.map((x) => x.name);

test("groups view: saved order, empty kept, ungrouped last, alphabetical rows", () => {
  const s = buildProjectSections({ projects, document: doc });
  assert.deepEqual(keys(s), ["group:g_1", "group:g_2", "ungrouped"]);
  assert.deepEqual(names(s[0]), ["Bravo", "zeta"]);
  assert.equal(s[0].groupId, "g_1");
  assert.equal(s[0].title, "Work");
  assert.equal(s[1].count, 0);
  assert.deepEqual(names(s[2]), ["alpha", "delta"]);
  assert.equal(s[2].count, 2);
});

test("groups view hides empty ungrouped and ignores stale assignments", () => {
  const s = buildProjectSections({
    projects: [p("zeta")],
    document: { groups: doc.groups, assignments: { "/w/zeta": "g_1", "/w/gone": "g_2" } },
  });
  assert.deepEqual(keys(s), ["group:g_1", "group:g_2"]);
  assert.equal(s[1].count, 0);
});

test("trailing slashes in project paths still match assignments", () => {
  const s = buildProjectSections({
    projects: [p("zeta", "", "/w/zeta/")],
    document: doc,
  });
  assert.equal(s[0].count, 1);
});

test("missing document yields only ungrouped", () => {
  assert.deepEqual(keys(buildProjectSections({ projects })), ["ungrouped"]);
  assert.deepEqual(buildProjectSections({ projects: [] }), []);
});

test("origin view: owners sorted case-insensitively, local last", () => {
  const s = buildProjectSections({ projects, document: doc, view: "origin" });
  assert.deepEqual(keys(s), ["origin:acme", "origin:beta-org", "local"]);
  assert.deepEqual(names(s[0]), ["delta", "zeta"]);
  assert.equal(s[0].title, "acme"); // casing of the first project (alphabetical)
  assert.equal(s[2].kind, "local");
});

test("list view: one flat alphabetical section", () => {
  const s = buildProjectSections({ projects, view: "list" });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "flat");
  assert.deepEqual(names(s[0]), ["alpha", "Bravo", "delta", "zeta"]);
  assert.equal(s[0].count, 4);
});

test("search matches name and owner/repo case-insensitively, hides empty sections", () => {
  const byName = buildProjectSections({ projects, document: doc, query: "BRAV" });
  assert.deepEqual(keys(byName), ["group:g_1"]);
  assert.deepEqual(names(byName[0]), ["Bravo"]);

  const byRemote = buildProjectSections({ projects, document: doc, query: "acme/" });
  assert.deepEqual(keys(byRemote), ["group:g_1", "ungrouped"]);

  const origin = buildProjectSections({ projects, view: "origin", query: "beta-org" });
  assert.deepEqual(keys(origin), ["origin:beta-org"]);
});

test("search matching only ungrouped projects hides every group", () => {
  const s = buildProjectSections({ projects, document: doc, query: "alpha" });
  assert.deepEqual(keys(s), ["ungrouped"]);
  assert.deepEqual(names(s[0]), ["alpha"]);
  assert.equal(s[0].count, 1);
});

test("search with no match returns no sections in every view", () => {
  for (const view of ["groups", "origin", "list"]) {
    assert.deepEqual(
      buildProjectSections({ projects, document: doc, view, query: "zzz" }),
      [],
    );
  }
});

test("blank query counts as no query", () => {
  const s = buildProjectSections({ projects, document: doc, query: "   " });
  assert.deepEqual(keys(s), ["group:g_1", "group:g_2", "ungrouped"]);
});
