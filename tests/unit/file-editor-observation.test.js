import test from "node:test";
import assert from "node:assert/strict";
import { createFileEditorStore } from "../../web/features/files/file-editor-store.js";

const token = (kind, value) => `${kind}1:${String(value).repeat(64)}`;
const document = (path, text = "disk", value = 1) => ({
  path,
  resolvedPath: path,
  text,
  bom: false,
  lineEnding: "lf",
  revision: token("d", value),
  metadataRevision: token("e", value),
  readOnly: false,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("metadata observation uses the original selected path and ignores an obsolete reply", async () => {
  const held = deferred();
  const calls = [];
  const client = {
    readText: async (path) => document(path),
    documentMetadata: async (path, signal) => {
      calls.push({ path, signal });
      return held.promise;
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "original-scope", "/selected-link");
  const observing = store.observe(tab.id);
  store.edit(tab.id, { text: "draft" });
  held.resolve({
    path: "/selected-link",
    resolvedPath: "/new-target",
    metadataRevision: token("e", 2),
  });
  assert.equal((await observing).status, "obsolete");
  assert.deepEqual(
    calls.map(({ path }) => path),
    ["/selected-link"],
  );
  assert.equal(store.getSnapshot().tabs[0].external, undefined);
});

test("changed metadata is recorded without replacing dirty text and clean reload is explicit", async () => {
  let value = 2;
  const client = {
    readText: async (path) => document(path, value === 2 ? "first" : "new disk", value),
    documentMetadata: async (path) => ({
      path,
      resolvedPath: path,
      metadataRevision: token("e", 3),
    }),
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  assert.equal((await store.observe(tab.id)).status, "changed");
  assert.equal(store.getSnapshot().tabs[0].text, "first");
  value = 3;
  assert.equal((await store.reload(tab.id)).status, "reloaded");
  assert.equal(store.getSnapshot().tabs[0].text, "new disk");
  assert.equal(store.getSnapshot().tabs[0].document.metadataRevision, token("e", 3));
});

test("a revision conflict loads a separate current document and replaces only with consent", async () => {
  const writes = [];
  let current = document("/a", "original", 1);
  const client = {
    readText: async () => current,
    saveText: async (path, bytes, options) => {
      writes.push({ path, text: new TextDecoder().decode(bytes), options });
      if (options.revision === token("d", 1))
        throw Object.assign(new Error("changed"), { code: "FILE_CONFLICT_CHANGED" });
      return {
        path,
        revision: token("d", 3),
        metadataRevision: token("e", 3),
      };
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  store.edit(tab.id, { text: "draft" });
  await store.save(tab.id);
  current = document("/a", "external", 2);
  assert.equal((await store.inspectConflict(tab.id)).status, "conflict");
  const conflicted = store.getSnapshot().tabs[0];
  assert.equal(conflicted.text, "draft");
  assert.equal(conflicted.conflict.document.text, "external");
  assert.equal((await store.replace(tab.id, token("d", 2))).status, "saved");
  assert.equal(writes[1].options.revision, token("d", 2));
});

test("non-conflict 409 codes never fetch or create a conflict document", async () => {
  let reads = 0;
  const client = {
    readText: async (path) => {
      reads++;
      return document(path);
    },
    saveText: async () => {
      throw Object.assign(new Error("scope"), { code: "FILE_INVALID_SCOPE" });
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  store.edit(tab.id, { text: "draft" });
  await store.save(tab.id);
  assert.equal((await store.inspectConflict(tab.id)).status, "not-conflict");
  assert.equal(reads, 1);
  assert.equal(store.getSnapshot().tabs[0].conflict, null);
});

test("manual conflict resolution keeps the draft but advances the save precondition", async () => {
  const client = {
    readText: async (path) => document(path, "disk", 2),
    saveText: async () => {
      throw Object.assign(new Error("changed"), { code: "FILE_CONFLICT_CHANGED" });
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  store.edit(tab.id, { text: "draft" });
  await store.save(tab.id);
  await store.inspectConflict(tab.id);
  assert.equal(store.dismissConflict(tab.id).status, "resolving");
  const resolving = store.getSnapshot().tabs[0];
  assert.equal(resolving.text, "draft");
  assert.equal(resolving.document.revision, token("d", 2));
  assert.equal(resolving.attempt, null);
  assert.equal(resolving.dirty, true);
});

test("using current explicitly discards the draft and unresolved attempt", async () => {
  const client = {
    readText: async (path) => document(path, "disk", 2),
    saveText: async () => {
      throw Object.assign(new Error("changed"), { code: "FILE_CONFLICT_CHANGED" });
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  store.edit(tab.id, { text: "draft" });
  await store.save(tab.id);
  await store.inspectConflict(tab.id);
  store.useCurrent(tab.id);
  const current = store.getSnapshot().tabs[0];
  assert.equal(current.text, "disk");
  assert.equal(current.attempt, null);
  assert.equal(current.pending, false);
  assert.equal(current.dirty, false);
});

test("a delayed current-document reply cannot replace a newer draft version", async () => {
  const held = deferred();
  let reads = 0;
  const client = {
    readText: async (path) => {
      reads++;
      return reads === 1 ? document(path, "original", 1) : held.promise;
    },
    saveText: async () => {
      throw Object.assign(new Error("changed"), { code: "FILE_CONFLICT_CHANGED" });
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  store.edit(tab.id, { text: "first draft" });
  await store.save(tab.id);
  const inspection = store.inspectConflict(tab.id);
  store.edit(tab.id, { text: "newer draft" });
  held.resolve(document("/a", "late disk", 2));
  assert.equal((await inspection).status, "obsolete");
  const current = store.getSnapshot().tabs[0];
  assert.equal(current.text, "newer draft");
  assert.equal(current.conflict, null);
});
