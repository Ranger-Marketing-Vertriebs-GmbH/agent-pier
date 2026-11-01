import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ViewStore, sanitizeViews } from "../../server/features/views/view-store.js";
import { viewsTopic } from "../../server/features/views/live-topics.js";

const s1 = { kind: "session", id: "s1" },
  s2 = { kind: "session", id: "s2" };
const c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };
const pane = (item, tab) => ({ type: "pane", item, ...(tab ? { tab } : {}) });
const split = (a, b, ratio = 0.5, dir = "row") => ({ type: "split", dir, ratio, a, b });

let dataDir, store;
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "views-"));
  store = new ViewStore({ dataDir, now: () => "2026-11-01T10:00:00.000Z" });
});

test("create stores a view with revision 1 and usedAt = createdAt", () => {
  const { version, view } = store.create({
    name: "  Shop  ",
    layout: split(pane(s1, "terminal"), pane(c1)),
  });
  assert.equal(version, 1);
  assert.match(view.id, /^v_[a-f0-9]{16}$/);
  assert.equal(view.name, "Shop");
  assert.equal(view.revision, 1);
  assert.equal(view.usedAt, "2026-11-01T10:00:00.000Z");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "views.json"), "utf8")).views[0],
    view,
  );
});

test("layout limits: 7 panes, duplicate item, ratio 0.1, tab on a chat", () => {
  const seven = [1, 2, 3, 4, 5, 6, 7]
    .map((n) => pane({ kind: "session", id: `s${n}` }))
    .reduce((tree, leaf) => (tree ? split(tree, leaf) : leaf), null);
  assert.throws(() => store.create({ name: "A", layout: seven }), {
    code: "VIEW_TOO_MANY_PANES",
  });
  assert.throws(() => store.create({ name: "A", layout: split(pane(s1), pane(s1)) }), {
    code: "VIEW_DUPLICATE_ITEM",
  });
  assert.throws(
    () => store.create({ name: "A", layout: split(pane(s1), pane(s2), 0.1) }),
    { code: "VIEW_LAYOUT_INVALID" },
  );
  assert.throws(() => store.create({ name: "A", layout: pane(c1, "chat") }), {
    code: "VIEW_LAYOUT_INVALID",
  });
  assert.throws(() => store.create({ name: "A", layout: { ...pane(s1), extra: 1 } }), {
    code: "VIEW_LAYOUT_INVALID",
  });
});

test("six panes are fine", () => {
  const six = [1, 2, 3, 4, 5, 6]
    .map((n) => pane({ kind: "session", id: `s${n}` }, "files"))
    .reduce((tree, leaf) => (tree ? split(tree, leaf, 0.15, "col") : leaf), null);
  assert.equal(store.create({ name: "Six", layout: six }).view.layout.type, "split");
});

test("names must be 1 to 60 characters", () => {
  assert.throws(() => store.create({ name: " ", layout: null }), {
    code: "VIEW_NAME_INVALID",
  });
  assert.throws(() => store.create({ name: "x".repeat(61), layout: null }), {
    code: "VIEW_NAME_INVALID",
  });
  assert.equal(store.create({ name: "x".repeat(60), layout: null }).view.name.length, 60);
});

test("at most 30 views", () => {
  for (let n = 0; n < 30; n++) store.create({ name: `V${n}`, layout: null });
  assert.throws(() => store.create({ name: "V30", layout: null }), {
    code: "VIEW_LIMIT",
  });
});

test("update raises the revision; used sets usedAt; unknown id is VIEW_UNKNOWN", () => {
  let tick = 0;
  const timed = new ViewStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "views-")),
    now: () => `t${tick++}`,
  });
  const { view } = timed.create({ name: "A", layout: null });
  assert.equal(view.usedAt, "t0");
  const renamed = timed.update(view.id, { name: "B", layout: pane(s1) });
  assert.equal(renamed.version, 2);
  assert.equal(renamed.view.revision, 2);
  assert.equal(renamed.view.name, "B");
  assert.deepEqual(renamed.view.layout, pane(s1));
  const used = timed.update(view.id, { used: true });
  assert.equal(used.view.revision, 3);
  assert.equal(used.view.usedAt, "t1");
  assert.throws(() => timed.update("v_0000000000000000", { name: "B" }), {
    code: "VIEW_UNKNOWN",
    status: 404,
  });
  assert.throws(() => timed.update(view.id, {}), { code: "VIEW_INVALID" });
  assert.deepEqual(timed.remove(view.id), { version: 4 });
  assert.throws(() => timed.remove(view.id), { code: "VIEW_UNKNOWN" });
});

test("every write calls onChange once", () => {
  let calls = 0;
  const watched = new ViewStore({
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "views-")),
    onChange: () => calls++,
  });
  const { view } = watched.create({ name: "A", layout: null });
  watched.update(view.id, { name: "B" });
  watched.remove(view.id);
  assert.equal(calls, 3);
});

test("sanitizeViews drops invalid views and keeps valid ones", () => {
  const valid = {
    id: "v_0123456789abcdef",
    name: "A",
    layout: pane(s1),
    revision: 2,
    createdAt: "t",
    usedAt: "t",
  };
  assert.deepEqual(
    sanitizeViews({
      version: 7,
      views: [
        valid,
        { ...valid, id: "bad" },
        { ...valid, id: "v_1111111111111111", layout: split(pane(s1), pane(s1)) },
      ],
    }),
    { version: 7, views: [valid] },
  );
  assert.deepEqual(sanitizeViews("not an object"), { version: 0, views: [] });
});

test("a corrupt views.json starts empty", () => {
  fs.writeFileSync(path.join(dataDir, "views.json"), "{");
  assert.deepEqual(new ViewStore({ dataDir }).list(), { version: 0, views: [] });
});

test("the views topic admits only the owner", () => {
  const topic = viewsTopic({ views: { list: () => ({ version: 0, views: [] }) } });
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user" }), false);
  assert.deepEqual(topic.read(), { version: 0, views: [] });
});
