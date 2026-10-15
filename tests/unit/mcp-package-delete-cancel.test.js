import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { McpPackages } from "../../server/features/mcp-packages/mcp-packages.js";
import { deferred } from "../helpers/mcp-packages-harness.js";

const exists = (file) => file === "/fake/bin/npx";
function openStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-delete-cancel-"));
  const store = new McpServerStore({ dataDir, pathEnv: "/fake/bin", exists });
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, store };
}
const stdio = { name: "pkg", transport: "stdio", command: "/fake/bin/npx", args: [] };

/** A service on the real store whose cancel() is recorded. */
function wired(t) {
  const { dataDir, store } = openStore(t);
  const service = new McpPackages({ dataDir, servers: store, changes: {} });
  const cancelled = [];
  service.cancel = async (id) => cancelled.push(id);
  return { store, service, cancelled };
}

test("removing a server cancels its package install right after the row is gone", (t) => {
  const { store, cancelled } = wired(t);
  const { id } = store.create(stdio);
  store.remove(id);
  assert.deepEqual(cancelled, [id]);
  assert.throws(() => store.get(id));
});

test("a removal that fails cancels nothing", (t) => {
  const { store, cancelled } = wired(t);
  assert.throws(() => store.remove("missing"));
  assert.deepEqual(cancelled, []);
});

test("delete cancels the install before a slow Gateway apply resolves", async (t) => {
  const { store, cancelled } = wired(t);
  const { id } = store.create(stdio);
  const changes = new McpChanges({
    assistants: { admit: (work) => work() },
    servers: store,
  });
  const release = deferred();
  changes.applySaved = () => release.promise.then(() => false);
  const removal = changes.remove(id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelled, [id]);
  release.resolve();
  await removal;
});
