import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import {
  requireOwnerPatch,
  requireUnmanaged,
} from "../../server/features/mcp-servers/managed-servers.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const messages = serverMessages.mcpServers;
const dataDirs = [];
after(() => dataDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
const exists = (file) => file === "/abs/rea";
function store(dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-servers-"))) {
  if (!dataDirs.includes(dataDir)) dataDirs.push(dataDir);
  return new McpServerStore({ dataDir, pathEnv: "/fake/bin", exists });
}
const rea = (extra = {}) => ({
  name: "rea",
  transport: "stdio",
  command: "/abs/rea",
  args: ["--stdio"],
  env: { JAVA_HOME: "/jdk", GHIDRA_INSTALL_DIR: "/ghidra", MY_KEY: "own" },
  ...extra,
});
const managed = { tool: "rea", lockedEnv: ["JAVA_HOME", "GHIDRA_INSTALL_DIR"] };
const locked = (work) =>
  assert.throws(work, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.message, messages.managedLocked);
    return true;
  });

test("a managed row reports managed.tool and its locked env names", () => {
  const s = store();
  const created = s.create(rea(), { managed });
  assert.deepEqual(created.managed, managed);
  assert.deepEqual(s.get(created.id).managed, managed);
  assert.deepEqual(s.list()[0].managed, managed);
  assert.deepEqual(s.managed.get(created.id), managed);
  assert.equal(s.managed.byTool("rea"), created.id);
  assert.equal(s.managed.byTool("other"), null);
  s.managed.setLockedEnv(created.id, ["JAVA_HOME"]);
  assert.deepEqual(s.get(created.id).managed, { tool: "rea", lockedEnv: ["JAVA_HOME"] });
  // A plain row carries no marker at all.
  const plain = s.create(rea({ name: "own" }));
  assert.equal(Object.hasOwn(plain, "managed"), false);
  assert.equal(s.managed.get(plain.id), null);
});

test("a failed create stores neither the row nor its marker", () => {
  const s = store();
  s.create(rea({ name: "taken" }));
  assert.throws(() => s.create(rea({ name: "taken" }), { managed }));
  assert.equal(s.managed.byTool("rea"), null);
  assert.throws(() => s.create(rea(), { managed: { tool: "", lockedEnv: [] } }));
  assert.equal(s.list().length, 1);
});

test("deleting the server row cascades the managed marker", () => {
  const s = store();
  const { id } = s.create(rea(), { managed });
  s.remove(id);
  assert.equal(s.managed.get(id), null);
  assert.equal(s.managed.byTool("rea"), null);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM managed_servers").get().n, 0);
});

test("requireOwnerPatch allows own env keys, timeouts and nothing else changes", () => {
  const s = store();
  const { id } = s.create(rea(), { managed });
  requireOwnerPatch(s, id, { revision: 1, env: { MY_KEY: "1" } });
  requireOwnerPatch(s, id, { revision: 1, env: { MY_KEY: null, NEW: "x" } });
  requireOwnerPatch(s, id, { revision: 1, startupTimeoutSec: 30, toolTimeoutSec: 60 });
  locked(() => requireOwnerPatch(s, id, { revision: 1, env: { JAVA_HOME: null } }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, env: { JAVA_HOME: "/x" } }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, args: ["x"] }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, name: "y" }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, command: "/abs/rea" }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, cwd: "/tmp" }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, transport: "http" }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, source: { registry: "npm" } }));
  locked(() => requireOwnerPatch(s, id, { revision: 1, source: null }));
  assert.throws(
    () => requireUnmanaged(s, id),
    (error) =>
      error.status === 409 && error.message === messages.managedRemoveThroughTool,
  );
});

test("an unmanaged row is never refused", () => {
  const s = store();
  const { id } = s.create(rea());
  requireOwnerPatch(s, id, {
    revision: 1,
    name: "y",
    args: [],
    env: { JAVA_HOME: null },
  });
  requireUnmanaged(s, id);
  // An unknown row, a body that is not an object or a store without markers pass too.
  requireOwnerPatch(s, "missing", { name: "y" });
  requireOwnerPatch(s, id, null);
  requireOwnerPatch({ get: () => ({}) }, id, { name: "y" });
  requireUnmanaged(undefined, id);
});

test("a store from before the table opens and gains it", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "managed-servers-"));
  const first = store(dataDir);
  const { id } = first.create(rea());
  first.close();
  const db = new DatabaseSync(path.join(dataDir, "mcp-servers", "servers.sqlite"));
  db.exec("DROP TABLE managed_servers");
  db.close();
  const reopened = store(dataDir);
  assert.equal(reopened.get(id).name, "rea");
  assert.equal(reopened.managed.get(id), null);
  reopened.managed.put(id, managed);
  assert.deepEqual(reopened.get(id).managed, managed);
  reopened.close();
});

test("an unreadable locked list reads as none", () => {
  const s = store();
  const { id } = s.create(rea(), { managed });
  s.db.prepare("UPDATE managed_servers SET locked_env='nope' WHERE server_id=?").run(id);
  assert.deepEqual(s.managed.get(id), { tool: "rea", lockedEnv: [] });
  s.db
    .prepare("UPDATE managed_servers SET locked_env='[1,\"A\"]' WHERE server_id=?")
    .run(id);
  assert.deepEqual(s.managed.get(id).lockedEnv, ["A"]);
});
