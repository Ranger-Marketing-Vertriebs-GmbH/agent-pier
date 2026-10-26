import test from "node:test";
import assert from "node:assert/strict";
import {
  filterItems,
  flatPageSize,
  groupItems,
  groupPageSize,
  initialListState,
  listModel,
  listReducer,
  nextRow,
  sameDay,
  sortItems,
  viewCounts,
} from "../../web/features/connections/long-list.js";
import { sshItems, usedState } from "../../web/features/connections/connection-items.js";

const now = new Date("2026-10-26T15:00:00");
const item = (id, fields = {}) => ({
  id,
  name: fields.name ?? id,
  sub: fields.sub ?? "",
  group: fields.group ?? { key: "g", label: "Group" },
  search: fields.search ?? [fields.name ?? id],
  facets: fields.facets ?? {},
  problem: fields.problem ?? false,
  used: fields.used === undefined ? true : fields.used,
  lastUsedAt: fields.lastUsedAt ?? null,
  changedAt: fields.changedAt ?? null,
});
const groupOf = (entry) => ({
  key: entry.group.key,
  label: entry.group.label,
  order: entry.group.order ?? 0,
});
const items = [
  item("a", {
    name: "prod-web-01",
    search: ["prod-web-01", "10.0.4.21", "deploy"],
    facets: { project: "p1", type: "ssh", agent: ["ops"] },
    lastUsedAt: "2026-10-26T14:48:00",
    changedAt: "2026-10-20T10:00:00Z",
  }),
  item("b", {
    name: "prod-db-01",
    search: ["prod-db-01", "10.0.4.11", "deploy"],
    facets: { project: "p1", type: "ssh", agent: ["ops", "research"] },
    problem: true,
    lastUsedAt: "2026-10-25T21:14:00",
    changedAt: "2026-10-24T10:00:00Z",
  }),
  item("c", {
    name: "backup-nas",
    search: ["backup-nas", "nas.lan", "admin"],
    facets: { project: "__global", type: "sftp", agent: [] },
    used: false,
    group: { key: "__global", label: "Global", order: -1 },
  }),
  item("d", {
    name: "staging",
    search: ["staging", "10.0.8.5"],
    facets: { project: "p2", type: "ssh", agent: [] },
    used: null,
    group: { key: "p2", label: "Website" },
  }),
];

test("views count problems, unused and today's use; unknown use is never unused", () => {
  assert.deepEqual(viewCounts(items, now), { all: 4, problems: 1, unused: 1, today: 1 });
  const state = initialListState("project");
  assert.deepEqual(
    filterItems(items, { ...state, view: "unused" }, now).map((entry) => entry.id),
    ["c"],
  );
  assert.deepEqual(
    filterItems(items, { ...state, view: "today" }, now).map((entry) => entry.id),
    ["a"],
  );
  assert.equal(sameDay("2026-10-26T00:01:00", now), true);
  assert.equal(sameDay("2026-10-25T23:59:00", now), false);
  assert.equal(sameDay(null, now), false);
});

test("search matches every word across name, host, user and command", () => {
  const state = initialListState();
  const ids = (query) =>
    filterItems(items, { ...state, query }, now).map((entry) => entry.id);
  assert.deepEqual(ids("  PROD  deploy "), ["a", "b"]);
  assert.deepEqual(ids("10.0.4.11"), ["b"]);
  assert.deepEqual(ids("nas admin"), ["c"]);
  assert.deepEqual(ids("prd"), []);
});

test("filter chips combine with each other and with array facets", () => {
  const state = initialListState();
  const ids = (filters) =>
    filterItems(items, { ...state, filters }, now).map((entry) => entry.id);
  assert.deepEqual(ids({ agent: "research" }), ["b"]);
  assert.deepEqual(ids({ project: "p1", agent: "ops" }), ["a", "b"]);
  assert.deepEqual(ids({ type: "sftp" }), ["c"]);
  assert.deepEqual(ids({ type: "", project: "" }), ["a", "b", "c", "d"]);
});

test("sorting by name, last change and last use keeps unknown times last", () => {
  assert.deepEqual(
    sortItems(items, "name").map((entry) => entry.id),
    ["c", "b", "a", "d"],
  );
  assert.deepEqual(
    sortItems(items, "changed").map((entry) => entry.id),
    ["b", "a", "c", "d"],
  );
  assert.deepEqual(
    sortItems(items, "used").map((entry) => entry.id),
    ["a", "b", "c", "d"],
  );
});

test("groups show their first five rows and count the rest", () => {
  const many = Array.from({ length: 12 }, (_, index) =>
    item(`h${String(index).padStart(2, "0")}`, {
      problem: index % 4 === 0,
      group: index < 9 ? { key: "p1", label: "App" } : { key: "p2", label: "Docs" },
    }),
  );
  const state = initialListState("project");
  const groups = groupItems(many, state, groupOf);
  assert.deepEqual(
    groups.map((group) => [group.label, group.total, group.rows.length, group.more]),
    [
      ["App", 9, groupPageSize, 4],
      ["Docs", 3, 3, 0],
    ],
  );
  assert.equal(groups[0].problems, 3);
  const expanded = listReducer(state, { type: "expand", key: "p1" });
  assert.equal(groupItems(many, expanded, groupOf)[0].rows.length, 9);
  const collapsed = listReducer(state, { type: "collapse", key: "p1" });
  const [app] = groupItems(many, collapsed, groupOf);
  assert.equal(app.collapsed, true);
  assert.deepEqual(app.rows, []);
  // Without grouping one list starts with more rows.
  const flat = groupItems(many, initialListState(), groupOf);
  assert.equal(flat.length, 1);
  assert.equal(flat[0].rows.length, Math.min(many.length, flatPageSize));
});

test("the reducer selects, selects all visible, prunes and resets", () => {
  let state = initialListState("project");
  state = listReducer(state, { type: "select", id: "a" });
  state = listReducer(state, { type: "select", id: "b" });
  state = listReducer(state, { type: "select", id: "a" });
  assert.deepEqual(state.selected, ["b"]);
  state = listReducer(state, { type: "selectAll", ids: ["a", "b", "c"] });
  assert.deepEqual(state.selected, ["b", "a", "c"]);
  state = listReducer(state, { type: "selectAll", ids: ["a", "b", "c"] });
  assert.deepEqual(state.selected, []);
  state = listReducer(state, { type: "selectAll", ids: ["a", "b"] });
  const pruned = listReducer(state, { type: "prune", ids: ["b", "x"] });
  assert.deepEqual(pruned.selected, ["b"]);
  assert.equal(listReducer(pruned, { type: "prune", ids: ["b"] }), pruned);
  state = listReducer(
    { ...state, view: "problems", query: "prod", filters: { type: "ssh" } },
    { type: "reset" },
  );
  assert.deepEqual([state.view, state.query, state.filters], ["all", "", {}]);
  assert.deepEqual(state.selected, ["a", "b"]);
});

test("arrow keys move through the visible rows", () => {
  const visible = ["a", "b", "c"];
  assert.equal(nextRow(visible, "a", "ArrowDown"), "b");
  assert.equal(nextRow(visible, "c", "ArrowDown"), "c");
  assert.equal(nextRow(visible, "b", "ArrowUp"), "a");
  assert.equal(nextRow(visible, "b", "Home"), "a");
  assert.equal(nextRow(visible, "a", "End"), "c");
  assert.equal(nextRow(visible, "a", "x"), null);
  assert.equal(nextRow([], "a", "ArrowDown"), null);
});

test("SSH items take status, use and changes from the list and the usage", () => {
  const accesses = [
    {
      id: "h1",
      name: "prod",
      host: "10.0.0.1",
      port: 22,
      username: "deploy",
      projectId: "p1",
      type: "ssh",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
      lastTest: { ok: false, at: "2026-10-25T20:00:00Z", hostKeyMismatch: true },
    },
    {
      id: "h2",
      name: "files",
      host: "nas",
      port: 2222,
      username: "admin",
      projectId: null,
      type: "sftp",
      remoteRoot: "/srv",
      createdAt: "2026-01-01T00:00:00Z",
      lastTest: null,
    },
  ];
  const usage = {
    ssh: {
      h1: {
        agents: [{ id: "ops", name: "Ops", via: "grant", mode: "approval" }],
        hooks: [],
        sessions: 0,
        lastUsedAt: "2026-10-26T10:00:00Z",
      },
      h2: { agents: [], hooks: [], sessions: null, lastUsedAt: null },
    },
  };
  const [prod, files] = sshItems({
    accesses,
    usage,
    ownerName: (access) => (access.projectId ? "App" : "Global"),
  });
  assert.equal(prod.status, "hostKey");
  assert.equal(prod.problem, true);
  assert.equal(prod.used, true);
  assert.equal(prod.changedAt, "2026-02-01T00:00:00Z");
  assert.deepEqual(prod.facets.agent, ["ops"]);
  assert.equal(prod.sub, "deploy@10.0.0.1:22");
  assert.equal(files.status, "untested");
  // Sessions unreadable: not counted as unused.
  assert.equal(files.used, null);
  assert.equal(files.sub, "admin@nas:2222 · /srv");
  assert.equal(files.facets.project, "__global");
  assert.equal(files.changedAt, "2026-01-01T00:00:00Z");
  assert.equal(sshItems({ accesses, usage: null, ownerName: () => "" })[0].used, null);
  assert.equal(usedState([0, 0, 0]), false);
  assert.equal(usedState([0, null, 2]), true);
  assert.equal(usedState([0, null]), null);
});

test("the list model stays fast with 500 synthetic SSH entries (AC-ZG-3)", () => {
  const big = Array.from({ length: 500 }, (_, index) =>
    item(`host-${index}`, {
      name: `server-${String(index).padStart(3, "0")}`,
      search: [`server-${index}`, `10.0.${index % 255}.${index % 7}`, "deploy"],
      facets: { project: `p${index % 12}`, type: index % 3 ? "ssh" : "sftp", agent: [] },
      problem: index % 17 === 0,
      used: index % 5 ? true : false,
      group: { key: `p${index % 12}`, label: `Project ${index % 12}` },
      changedAt: new Date(Date.UTC(2026, 0, 1 + (index % 300))).toISOString(),
    }),
  );
  let state = initialListState("project");
  const started = performance.now();
  let model;
  for (const query of ["", "s", "se", "ser", "server-4", "10.0.4", "deploy"]) {
    state = listReducer(state, { type: "query", query });
    model = listModel(big, state, groupOf, now);
  }
  state = listReducer(state, { type: "sort", sort: "changed" });
  state = listReducer(state, { type: "view", view: "problems" });
  model = listModel(big, state, groupOf, now);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 250, `500 entries took ${elapsed.toFixed(1)} ms`);
  assert.equal(model.counts.all, 500);
  // Only the first rows of each group render, however long the list is.
  const full = listModel(big, initialListState("project"), groupOf, now);
  assert.equal(full.groups.length, 12);
  assert.ok(full.visible.length <= 12 * groupPageSize);
});
