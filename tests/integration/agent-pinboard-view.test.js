import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pinboardFixture } from "../helpers/agent-pinboard-fixture.js";
import { PINBOARD_LIMITS } from "../../server/features/assistants/agent-pinboard-store.js";

const key = (expected) => (error) => error?.key === expected;

async function pinned(f, body = "# Episode 6\n") {
  const file = f.file("out/ep6.md", body);
  const listId = (await f.call({ action: "create_list", title: "Episodes" })).list.id;
  const { entry } = await f.call({ action: "pin", listId, path: "out/ep6.md" });
  return { file, listId, entryId: entry.id };
}

// Records every descriptor the view opens.
function handlesOf(f) {
  const handles = [];
  const files = f.pinboard.viewer.files;
  const open = files.openPinned;
  files.openPinned = async (...args) => {
    const opened = await open(...args);
    handles.push(opened.handle);
    return opened;
  };
  return handles;
}

test("a store error after the file opened closes its descriptor", async (t) => {
  const f = await pinboardFixture(t);
  const { entryId } = await pinned(f);
  const handles = handlesOf(f);
  const store = f.pinboard.store;
  const entry = store.entry.bind(store);
  let reads = 0;
  store.entry = (...args) => {
    if (++reads === 2) throw new Error("database is locked");
    return entry(...args);
  };
  await assert.rejects(f.pinboard.open(f.id, entryId), /database is locked/);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].fd, -1);
});

test("a store error while a moved file's identity is stored rejects the view", async (t) => {
  const f = await pinboardFixture(t);
  const { file } = await pinned(f);
  fs.writeFileSync(file, "# Episode 6, shorter\n");
  const handles = handlesOf(f);
  f.pinboard.store.setIdentity = () => {
    throw new Error("database is locked");
  };
  await assert.rejects(f.pinboard.view(f.id), /database is locked/);
  assert.ok(handles.every((handle) => handle.fd === -1));
});

test("a refused pin into an archived list leaves it archived", async (t) => {
  const f = await pinboardFixture(t);
  f.file("out/new.md");
  const { listId } = await pinned(f);
  const store = f.pinboard.store;
  const now = new Date().toISOString();
  for (let i = 1; i < PINBOARD_LIMITS.entries; i += 1)
    store.pin(
      f.id,
      listId,
      { name: `e${i}`, note: "", root: "workspace", path: "out/ep6.md" },
      now,
    );
  await f.call({ action: "archive_list", listId });
  await assert.rejects(
    f.call({ action: "pin", listId, path: "out/new.md" }),
    key("pinboardEntryLimit"),
  );
  assert.ok(store.getList(f.id, listId).archivedAt);
  // A full board refuses to reopen it for a pin, too.
  store.unpin(f.id, listId, { name: "e1" });
  for (let i = 0; i < PINBOARD_LIMITS.openLists; i += 1)
    store.createList(f.id, { title: `L${i}` }, now);
  await assert.rejects(
    f.call({ action: "pin", listId, path: "out/new.md" }),
    key("pinboardListLimit"),
  );
  assert.ok(store.getList(f.id, listId).archivedAt);
  assert.equal(store.getList(f.id, listId).entries.length, PINBOARD_LIMITS.entries - 1);
});
