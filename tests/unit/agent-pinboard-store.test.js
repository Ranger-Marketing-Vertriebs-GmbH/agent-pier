import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AgentPinboardStore,
  PINBOARD_LIMITS,
} from "../../server/features/assistants/agent-pinboard-store.js";

const T0 = "2026-01-01T10:00:00.000Z";
const T1 = "2026-01-01T11:00:00.000Z";
const identity = (size = 1) => ({ size, mtimeMs: 1, ino: 7, type: "text/markdown" });
const pinArgs = (name, extra = {}) => ({
  name,
  note: "",
  root: "workspace",
  path: `${name}.md`,
  admitConversationId: "chat-1",
  identity: identity(),
  ...extra,
});
const setup = () => {
  const store = new AgentPinboardStore(new DatabaseSync(":memory:"));
  const list = store.createList("a", { title: "Plan" }, T0);
  return { store, list };
};
const rejects = (promiseOrFn, key, status) =>
  assert.throws(promiseOrFn, (error) => error.key === key && error.status === status);

test("a list keeps its entries in order and a re-pin by name replaces in place", () => {
  const { store, list } = setup();
  store.pin("a", list.id, pinArgs("A"), T0);
  store.pin("a", list.id, pinArgs("B"), T0);
  const again = store.pin("a", list.id, pinArgs("A", { path: "other/A.md" }), T1);
  assert.equal(again.replaced, true);
  const [a, b] = store.getList("a", list.id).entries;
  assert.deepEqual([a.name, b.name], ["A", "B"]);
  assert.equal(a.version, 2);
  assert.equal(a.path, "other/A.md");
  assert.equal(b.version, 1);
});

test("the 51st open list is refused, an archived one does not count", () => {
  const store = new AgentPinboardStore(new DatabaseSync(":memory:"));
  const made = [];
  for (let i = 0; i < PINBOARD_LIMITS.openLists; i += 1)
    made.push(store.createList("a", { title: `L${i}` }, T0));
  rejects(() => store.createList("a", { title: "extra" }, T0), "pinboardListLimit", 409);
  // Another agent has its own 50.
  store.createList("b", { title: "mine" }, T0);
  store.setArchived("a", made[0].id, true, T1);
  const extra = store.createList("a", { title: "extra" }, T1);
  rejects(() => store.setArchived("a", made[0].id, false, T1), "pinboardListLimit", 409);
  store.deleteList("a", extra.id);
  assert.equal(store.setArchived("a", made[0].id, false, T1).archivedAt, null);
});

test("the 101st entry is refused", () => {
  const { store, list } = setup();
  for (let i = 0; i < PINBOARD_LIMITS.entries; i += 1)
    store.pin("a", list.id, pinArgs(`f${i}`), T0);
  rejects(
    () => store.pin("a", list.id, pinArgs("one-more"), T0),
    "pinboardEntryLimit",
    409,
  );
  // Replacing an existing name still works at the limit.
  assert.equal(store.pin("a", list.id, pinArgs("f0"), T1).replaced, true);
});

test("reorder puts the named ids first and keeps the rest", () => {
  const { store, list } = setup();
  const [a, b, c, d] = ["A", "B", "C", "D"].map(
    (name) => store.pin("a", list.id, pinArgs(name), T0).entry,
  );
  const names = (l) => l.entries.map((e) => e.name).join("");
  assert.equal(names(store.reorder("a", list.id, [c.id, a.id])), "CABD");
  rejects(
    () => store.reorder("a", list.id, [d.id, "nope"]),
    "pinboardEntryNotFound",
    404,
  );
  assert.equal(names(store.getList("a", list.id)), "CABD");
  assert.equal(b.name, "B");
});

test("another agent's list is not found", () => {
  const { store, list } = setup();
  rejects(() => store.getList("other", list.id), "pinboardListNotFound", 404);
  rejects(
    () => store.pin("other", list.id, pinArgs("A"), T0),
    "pinboardListNotFound",
    404,
  );
  const { entry } = store.pin("a", list.id, pinArgs("A"), T0);
  rejects(() => store.entry("other", entry.id), "pinboardEntryNotFound", 404);
  assert.deepEqual(store.lists("other"), []);
});

test("change records fold one turn's changes per list", () => {
  const { store, list } = setup();
  const base = {
    conversationId: "c",
    requestId: "r",
    listId: list.id,
    assistantId: "a",
    title: "Plan",
    at: T0,
  };
  store.recordChange({ ...base, kind: "updated", name: "A" });
  store.recordChange({ ...base, kind: "added", name: "B" });
  store.recordChange({ ...base, kind: "added", name: "C" });
  store.recordChange({ ...base, kind: "removed", name: "D" });
  store.recordChange({ ...base, requestId: "r2", kind: "added", name: "E" });
  const rows = store.changesFor("c").filter((row) => row.requestId === "r");
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { added: rows[0].added, updated: rows[0].updated, removed: rows[0].removed },
    { added: 2, updated: 1, removed: 1 },
  );
  assert.deepEqual(rows[0].names, ["A", "B", "C"]);
  assert.equal(store.changesFor("c").length, 2);
  assert.deepEqual(store.changesFor("nobody"), []);
});

test("a pin stores its identity atomically", () => {
  const { store, list } = setup();
  const { entry } = store.pin("a", list.id, pinArgs("A", { identity: identity(5) }), T0);
  assert.deepEqual(entry.identity, identity(5));
  assert.equal(entry.version, 1);
  const again = store.pin("a", list.id, pinArgs("A", { identity: identity(9) }), T1);
  assert.deepEqual(again.entry.identity, identity(9));
});

test("setIdentity bumps once for concurrent changes and touches the list", () => {
  const { store, list } = setup();
  const { entry } = store.pin("a", list.id, pinArgs("A"), T0);
  const expected = JSON.stringify(entry.identity);
  assert.equal(store.setIdentity(entry.id, identity(2), { bump: true, expected }), true);
  assert.equal(store.setIdentity(entry.id, identity(3), { bump: true, expected }), false);
  const after = store.entry("a", entry.id);
  assert.equal(after.version, 2);
  assert.deepEqual(after.identity, identity(2));
  assert.ok(after.list.updatedAt > T0);
  const touched = after.list.updatedAt;
  const fresh = { ...identity(2), mtimeMs: 99 };
  assert.equal(
    store.setIdentity(entry.id, fresh, {
      bump: false,
      expected: JSON.stringify(identity(2)),
    }),
    true,
  );
  const refreshed = store.entry("a", entry.id);
  assert.equal(refreshed.version, 2);
  assert.equal(refreshed.list.updatedAt, touched);
  store.markSeen("a", entry.id, fresh);
  assert.deepEqual(store.entry("a", entry.id).seenIdentity, fresh);
});

test("listOrNull returns null for a deleted list", () => {
  const { store, list } = setup();
  store.pin("a", list.id, pinArgs("A"), T0);
  assert.equal(store.listOrNull("a", list.id).entries.length, 1);
  store.deleteList("a", list.id);
  assert.equal(store.listOrNull("a", list.id), null);
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM agent_pinboard_entries").get().n,
    0,
  );
});

test("list-level writes record no change", () => {
  const { store, list } = setup();
  store.updateList("a", list.id, { title: "Renamed" }, T1);
  store.setArchived("a", list.id, true, T1);
  store.setArchived("a", list.id, false, T1);
  assert.equal(store.getList("a", list.id).title, "Renamed");
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM agent_pinboard_changes").get().n,
    0,
  );
});

test("lists come open first by recent change, then archived by archive time", () => {
  const { store, list } = setup();
  const second = store.createList("a", { title: "Second" }, T1);
  const old = store.createList("a", { title: "Old" }, T0);
  store.setArchived("a", old.id, true, T0);
  const gone = store.createList("a", { title: "Gone" }, T0);
  store.setArchived("a", gone.id, true, T1);
  assert.deepEqual(
    store.lists("a").map((l) => l.title),
    ["Second", "Plan", "Gone", "Old"],
  );
  assert.equal(second.entries.length, 0);
  assert.equal(list.title, "Plan");
});

test("unpin removes by id or name", () => {
  const { store, list } = setup();
  const { entry } = store.pin("a", list.id, pinArgs("A"), T0);
  store.pin("a", list.id, pinArgs("B"), T0);
  assert.equal(store.unpin("a", list.id, { entryId: entry.id }).name, "A");
  assert.equal(store.unpin("a", list.id, { name: "B" }).name, "B");
  rejects(() => store.unpin("a", list.id, { name: "B" }), "pinboardEntryNotFound", 404);
});
