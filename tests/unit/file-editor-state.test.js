import test from "node:test";
import assert from "node:assert/strict";
import { createFileEditorStore } from "../../web/features/files/file-editor-store.js";

const doc = (path) => ({
  path,
  resolvedPath: `/real${path}`,
  text: "first\r\n",
  bom: true,
  lineEnding: "crlf",
  revision: `d1:${"1".repeat(64)}`,
  metadataRevision: `e1:${"1".repeat(64)}`,
  readOnly: false,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const result = (path) => ({
  path,
  revision: `d1:${"2".repeat(64)}`,
  metadataRevision: `e1:${"2".repeat(64)}`,
});

test("tabs retain full view state and distinguish scopes; dirty close cannot discard", async () => {
  const store = createFileEditorStore();
  const client = { readText: async (path) => doc(path) };
  const a = await store.open(client, "scope-a", "/a");
  const b = await store.open(client, "scope-b", "/a");
  assert.notEqual(a.id, b.id);
  const editorState = { selection: { anchor: 3 }, history: ["undo"] };
  store.edit(a.id, { text: "changed\n", editorState, scrollTop: 73 });
  store.activate(b.id);
  store.activate(a.id);
  assert.equal(store.getSnapshot().tabs[0].editorState, editorState);
  assert.equal(store.getSnapshot().tabs[0].scrollTop, 73);
  assert.equal(store.close(a.id).status, "dirty");
  assert.equal(store.getSnapshot().tabs.length, 2);
  store.edit(a.id, { text: "first\n" });
  assert.equal(store.getSnapshot().tabs[0].dirty, false);
  store.format(a.id, { bom: false });
  assert.equal(store.getSnapshot().tabs[0].dirty, true);
});

test("an uncertain unchanged retry keeps bytes and request ID; late success preserves new edits", async () => {
  const calls = [];
  const pending = deferred();
  let count = 0;
  const client = {
    readText: async (path) => doc(path),
    saveText: async (path, bytes, options) => {
      calls.push({ path, bytes: [...bytes], options });
      if (count++ === 0)
        throw Object.assign(new Error("lost"), { code: "FILE_INVALID_RESPONSE" });
      return pending.promise;
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/link");
  store.edit(tab.id, { text: "saved\n" });
  assert.equal((await store.save(tab.id)).status, "failed");
  const retry = store.save(tab.id);
  store.edit(tab.id, { text: "newer\n", editorState: { history: true }, scrollTop: 91 });
  pending.resolve(result("/link"));
  assert.equal((await retry).status, "updated-during-save");
  assert.equal(calls[0].options.requestId, calls[1].options.requestId);
  assert.deepEqual(calls[0].bytes, calls[1].bytes);
  const current = store.getSnapshot().tabs[0];
  assert.equal(current.text, "newer\n");
  assert.equal(current.dirty, true);
  assert.equal(current.document.revision, result("/link").revision);
  assert.equal(current.scrollTop, 91);
  assert.equal(current.document.resolvedPath, "/real/link");
});

test("late opens and saves cannot resurrect tabs or select an older open", async () => {
  const slow = deferred(),
    save = deferred();
  const client = {
    readText: (path) => (path === "/slow" ? slow.promise : Promise.resolve(doc(path))),
    saveText: () => save.promise,
  };
  const store = createFileEditorStore();
  const first = store.open(client, "s", "/slow");
  const second = await store.open(client, "s", "/fast");
  slow.resolve(doc("/slow"));
  const old = await first;
  assert.equal(store.getSnapshot().activeId, second.id);
  store.edit(old.id, { text: "dirty" });
  const saving = store.save(old.id);
  store.close(old.id, { discard: true });
  const reopened = await store.open(client, "s", "/slow");
  save.resolve(result("/slow"));
  await saving;
  assert.notEqual(old.id, reopened.id);
  assert.equal(
    store.getSnapshot().tabs.find((t) => t.id === reopened.id).document.revision,
    doc("/slow").revision,
  );
});

test("read-only Save As is independent and enforces serialized UTF8 size including BOM", async () => {
  const calls = [];
  const client = {
    readText: async (path) => ({ ...doc(path), readOnly: true }),
    saveText: async (path, bytes, options) => {
      calls.push({ path, bytes, options });
      return result(path);
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "s", "/a", { textBytes: 5 });
  assert.equal((await store.save(tab.id)).error.code, "FILE_READ_ONLY");
  store.edit(tab.id, { text: "é" });
  assert.equal(
    (await store.saveAs(tab.id, "/copy", { revision: null })).status,
    "saved-as",
  );
  assert.equal(calls[0].options.revision, null);
  assert.equal(calls[0].bytes.length, 5);
  assert.equal(store.getSnapshot().tabs[0].path, "/a");
  store.edit(tab.id, { text: "é\n" });
  assert.equal(
    (await store.saveAs(tab.id, "/too-big")).error.code,
    "FILE_LIMIT_EXCEEDED",
  );
  assert.equal(calls.length, 1);
});

test("changed retry bytes create a fresh attempt, while errors preserve their exact code", async () => {
  const calls = [];
  const client = {
    readText: async (path) => doc(path),
    saveText: async (path, bytes, options) => {
      calls.push({ bytes: [...bytes], options });
      throw Object.assign(new Error("strict metadata refusal"), {
        code: "FILE_METADATA_UNSUPPORTED",
        status: 409,
      });
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "s", "/a");
  store.edit(tab.id, { text: "one" });
  const failed = await store.save(tab.id);
  assert.equal(failed.error.code, "FILE_METADATA_UNSUPPORTED");
  store.edit(tab.id, { text: "two" });
  await store.save(tab.id);
  assert.notEqual(calls[0].options.requestId, calls[1].options.requestId);
  assert.notDeepEqual(calls[0].bytes, calls[1].bytes);
  assert.equal(store.getSnapshot().tabs[0].dirty, true);
});

test("mixed conversion is explicit, literal FEFF and final empty lines survive, format undo clears dirty", async () => {
  const calls = [];
  const client = {
    readText: async (path) => ({
      ...doc(path),
      text: "\uFEFFa\rb\r\n\r\n",
      lineEnding: "mixed",
    }),
    saveText: async (path, bytes) => {
      calls.push(bytes);
      return result(path);
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "s", "/a");
  assert.equal((await store.save(tab.id)).error.code, "FILE_LINE_ENDING_REQUIRED");
  store.format(tab.id, { lineEnding: "lf" });
  assert.equal(store.getSnapshot().tabs[0].dirty, true);
  store.format(tab.id, { lineEnding: "mixed" });
  assert.equal(store.getSnapshot().tabs[0].dirty, false);
  store.format(tab.id, { lineEnding: "crlf" });
  await store.save(tab.id);
  assert.deepEqual(calls[0], new TextEncoder().encode("\uFEFF\uFEFFa\r\nb\r\n\r\n"));
  assert.equal(store.getSnapshot().tabs[0].dirty, false);
});

test("SaveAs existing target requires explicit fresh revision and consent, and never changes original baseline", async () => {
  const calls = [];
  const client = {
    readText: async (path) => doc(path),
    saveText: async (path, bytes, options) => {
      calls.push(options);
      return result(path);
    },
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "s", "/a");
  store.edit(tab.id, { text: "draft" });
  assert.equal(
    (await store.saveAs(tab.id, "/target", { revision: doc("/target").revision })).error
      .code,
    "FILE_TEXT_PRECONDITION",
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await store.saveAs(tab.id, "/target", {
        revision: doc("/target").revision,
        replaceConfirmed: true,
      })
    ).status,
    "saved-as",
  );
  const current = store.getSnapshot().tabs[0];
  assert.equal(current.document.revision, doc("/a").revision);
  assert.equal(current.dirty, true);
});

test("failed reads can be explicitly retried without replacing a successful retained draft", async () => {
  let reads = 0;
  const client = {
    readText: async (path) => {
      if (reads++ === 0) throw new Error("temporary");
      return doc(path);
    },
  };
  const store = createFileEditorStore();
  const failed = await store.open(client, "s", "/a");
  assert.equal(failed.document, undefined);
  const opened = await store.open(client, "s", "/a");
  assert.equal(opened.document.text, doc("/a").text);
  store.edit(opened.id, { text: "keep" });
  await store.open(client, "s", "/a");
  assert.equal(reads, 2);
  assert.equal(store.getSnapshot().tabs[0].text, "keep");
});

test("edits after a completed save replace stale saved feedback without changing its baseline", async () => {
  const client = {
    readText: async (path) => doc(path),
    saveText: async (path) => result(path),
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "s", "/a");
  store.edit(tab.id, { text: "saved" });
  await store.save(tab.id);
  store.edit(tab.id, { text: "later" });
  assert.equal(store.getSnapshot().tabs[0].outcome.status, "modified");
  assert.equal(store.getSnapshot().tabs[0].document.revision, result("/a").revision);
  store.edit(tab.id, { text: "saved" });
  assert.equal(store.getSnapshot().tabs[0].outcome.status, "unchanged");
  assert.equal(store.getSnapshot().tabs[0].dirty, false);
});
