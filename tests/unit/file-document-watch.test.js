import test from "node:test";
import assert from "node:assert/strict";
import { followDocument } from "../../web/features/files/file-document-watch.js";
import { createFileEditorStore } from "../../web/features/files/file-editor-store.js";
import { fakeEnv, settle } from "../helpers/fake-browser.js";

// Task 5.2: an open document follows `file.meta:<token>` instead of polling its
// metadata every 15 s; without a token, a refusal, the channel's fallback or a file
// the server cannot watch, it polls as before.

const topic = `file.meta:${"t".repeat(22)}`;
const token = (kind, value) => `${kind}1:${String(value).repeat(64)}`;

function fakeLive({ fallback = false } = {}) {
  const listeners = new Map();
  return {
    listeners,
    fallback,
    subscribe(id, listener) {
      listeners.set(id, listener);
      return () => listeners.delete(id);
    },
    status() {
      return { connected: !this.fallback, fallback: this.fallback };
    },
    emit(event) {
      listeners.get(topic)?.(event);
    },
  };
}

function start(t, { topic: id = topic, live = fakeLive() } = {}) {
  const fake = fakeEnv();
  const calls = { observe: 0, pushed: [], invalidated: 0 };
  const stop = followDocument({
    topic: id,
    live,
    observe: async () => {
      calls.observe += 1;
    },
    push: (value) => calls.pushed.push(value),
    invalidate: () => (calls.invalidated += 1),
    env: fake.env,
  });
  t.after(stop);
  return { fake, calls, live, stop };
}

test("without a token the document polls every 15 s and on focus", async (t) => {
  const { fake, calls, live } = start(t, { topic: null });
  await settle();
  assert.equal(calls.observe, 1);
  assert.equal(live.listeners.size, 0);
  await fake.advance(15000);
  assert.equal(calls.observe, 2);
  fake.env.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(calls.observe, 3);
});

test("a followed document applies every push and reads only as a safety net", async (t) => {
  const { fake, calls, live } = start(t);
  await settle();
  assert.equal(calls.observe, 0);
  assert.ok(live.listeners.has(topic));
  const value = { path: "/a", resolvedPath: "/a", metadataRevision: token("e", 2) };
  live.emit({ type: "data", data: { ...value, watched: true } });
  assert.deepEqual(calls.pushed, [{ ...value, watched: true }]);
  await fake.advance(60000);
  assert.equal(calls.observe, 0);
  // Focus, a tab shown again, and every 5 min while visible read the route once,
  // for what no watch sees (a hard link elsewhere, a re-pointed parent link).
  fake.env.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(calls.observe, 1);
  fake.setHidden(true);
  fake.setHidden(false);
  await settle();
  assert.equal(calls.observe, 2);
  await fake.advance(300000);
  assert.equal(calls.observe, 3);
  // A hidden tab reads nothing.
  fake.setHidden(true);
  await fake.advance(600000);
  fake.env.window.dispatchEvent(new Event("focus"));
  await settle();
  assert.equal(calls.observe, 3);
});

test("a refusal, a failed read, an unwatched file or the fallback poll; a push stops it", async (t) => {
  for (const event of [
    { type: "error", code: "unknown-topic" },
    { type: "revoked" },
    { type: "error" },
    { type: "data", data: { path: "/a", missing: true, watched: false } },
  ]) {
    const { fake, calls, live } = start(t);
    live.emit(event);
    await settle();
    assert.equal(calls.observe, 1, JSON.stringify(event));
    await fake.advance(15000);
    assert.equal(calls.observe, 2, JSON.stringify(event));
    live.emit({ type: "data", data: { path: "/a", missing: true, watched: true } });
    await fake.advance(60000);
    assert.equal(calls.observe, 2, JSON.stringify(event));
  }
  const live = fakeLive({ fallback: true });
  const { calls } = start(t, { live });
  await settle();
  assert.equal(calls.observe, 1);
  live.fallback = false;
  live.emit({ type: "status", connected: true, fallback: false });
  live.emit({ type: "data", data: { path: "/a", missing: true, watched: true } });
  assert.equal(calls.observe, 1);
});

test("a stale frame reads the route once", async (t) => {
  const { calls, live } = start(t);
  live.emit({ type: "stale" });
  await settle();
  assert.equal(calls.observe, 1);
});

const document = (path, value = 1) => ({
  path,
  resolvedPath: path,
  text: "disk",
  bom: false,
  lineEnding: "lf",
  revision: token("d", value),
  metadataRevision: token("e", value),
  readOnly: false,
});

test("a push marks an external change, a deleted file or a refusal, and beats an older read", async () => {
  let answer;
  const client = {
    readText: async (path) => document(path),
    documentMetadata: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a");
  const tabOf = () => store.getSnapshot().tabs[0];
  // The same revision: nothing changed.
  assert.equal(
    store.observed(tab.id, {
      path: "/a",
      resolvedPath: "/a",
      metadataRevision: token("e", 1),
    }).status,
    "unchanged",
  );
  // A read started before a push answers after it: the push is newer and stays.
  const reading = store.observe(tab.id);
  const changed = { path: "/a", resolvedPath: "/a", metadataRevision: token("e", 2) };
  assert.equal(store.observed(tab.id, { ...changed, watched: true }).status, "changed");
  answer({ path: "/a", resolvedPath: "/a", metadataRevision: token("e", 1) });
  assert.equal((await reading).status, "obsolete");
  assert.equal(tabOf().external.metadataRevision, token("e", 2));
  // Deleted on disk, as the route's 404 shows it.
  assert.equal(store.observed(tab.id, { path: "/a", missing: true }).status, "failed");
  assert.equal(tabOf().external.error.code, "FILE_NOT_FOUND");
  store.observed(tab.id, {
    path: "/a",
    error: { code: "FILE_OUTSIDE_SCOPE", status: 403 },
  });
  assert.equal(tabOf().external.error.code, "FILE_OUTSIDE_SCOPE");
  // Another path's value, or a malformed one, changes nothing.
  for (const value of [
    { ...changed, path: "/b" },
    { path: "/a", metadataRevision: "x" },
    null,
  ])
    assert.equal(store.observed(tab.id, value).status, "obsolete");
  assert.equal(tabOf().external.error.code, "FILE_OUTSIDE_SCOPE");
});

test("a push during a save is left to the read after it; the read records the watch topic", async () => {
  let saved;
  const client = {
    readText: async (path) => document(path),
    saveText: () =>
      new Promise((resolve) => {
        saved = resolve;
      }),
    documentMetadata: async (path) => ({
      path,
      resolvedPath: path,
      metadataRevision: token("e", 1),
      watch: topic,
    }),
  };
  const store = createFileEditorStore();
  const tab = await store.open(client, "scope", "/a", { textBytes: 1000 });
  await store.observe(tab.id);
  assert.equal(store.getSnapshot().tabs[0].watch, topic);
  store.edit(tab.id, { text: "new" });
  const saving = store.save(tab.id);
  const own = { path: "/a", resolvedPath: "/a", metadataRevision: token("e", 3) };
  assert.equal(store.observed(tab.id, own).status, "obsolete");
  assert.equal(store.getSnapshot().tabs[0].external, null);
  saved({ path: "/a", revision: token("d", 3), metadataRevision: token("e", 3) });
  await saving;
  assert.equal(store.observed(tab.id, own).status, "unchanged");
});
