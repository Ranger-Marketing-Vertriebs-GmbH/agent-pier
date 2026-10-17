import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-timeouts-"));
  const s = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file === "/abs/rea",
  });
  t.after(() => {
    s.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return s;
}
const rea = (extra = {}) => ({
  name: "rea",
  transport: "stdio",
  command: "/abs/rea",
  args: ["mcp"],
  ...extra,
});
const definition = (s, id) => s.definitions().find((item) => item.id === id);

test("a server stores optional startup and tool timeouts in seconds", (t) => {
  const s = store(t);
  const created = s.create(rea({ startupTimeoutSec: 30, toolTimeoutSec: 450 }));
  assert.equal(created.startupTimeoutSec, 30);
  assert.equal(created.toolTimeoutSec, 450);
  assert.deepEqual(
    [
      definition(s, created.id).startupTimeoutSec,
      definition(s, created.id).toolTimeoutSec,
    ],
    [30, 450],
  );
  const remote = s.create({
    name: "docs",
    transport: "http",
    url: "https://docs.example.test/mcp",
    toolTimeoutSec: 3600,
  });
  assert.equal(remote.toolTimeoutSec, 3600);
  assert.equal(Object.hasOwn(remote, "startupTimeoutSec"), false);
  assert.equal(definition(s, remote.id).startupTimeoutSec, null);
});

test("an update keeps omitted timeouts, sets new ones and clears with null", (t) => {
  const s = store(t);
  const { id } = s.create(rea({ startupTimeoutSec: 30, toolTimeoutSec: 450 }));
  let server = s.update(id, { revision: 1, toolTimeoutSec: 900 });
  assert.deepEqual([server.startupTimeoutSec, server.toolTimeoutSec], [30, 900]);
  server = s.update(id, { revision: 2, startupTimeoutSec: null, toolTimeoutSec: "" });
  assert.equal(server.revision, 3);
  assert.equal(Object.hasOwn(server, "startupTimeoutSec"), false);
  assert.equal(Object.hasOwn(server, "toolTimeoutSec"), false);
  assert.deepEqual(
    s.previewUpdate(id, { revision: 3, toolTimeoutSec: 5 }).after.name,
    "rea",
  );
});

test("timeouts outside the bounds are refused at their field and store nothing", (t) => {
  const s = store(t);
  for (const [field, value] of [
    ["startupTimeoutSec", 0],
    ["startupTimeoutSec", 601],
    ["toolTimeoutSec", 3601],
    ["toolTimeoutSec", 1.5],
    ["toolTimeoutSec", "450"],
  ])
    assert.throws(() => s.create(rea({ [field]: value })), {
      status: 400,
      code: "MCP_SERVER_TIMEOUT_INVALID",
      field,
    });
  assert.deepEqual(s.list(), []);
  const { id } = s.create(rea({ toolTimeoutSec: 60 }));
  assert.throws(() => s.update(id, { revision: 1, startupTimeoutSec: 9999 }), {
    code: "MCP_SERVER_TIMEOUT_INVALID",
    field: "startupTimeoutSec",
  });
  assert.throws(() => s.previewUpdate(id, { revision: 1, toolTimeoutSec: -1 }), {
    code: "MCP_SERVER_TIMEOUT_INVALID",
  });
  assert.deepEqual([s.get(id).revision, s.get(id).toolTimeoutSec], [1, 60]);
});

test("a stored timeout outside the bounds reads as none", (t) => {
  const s = store(t);
  const { id } = s.create(rea({ toolTimeoutSec: 60 }));
  s.db.prepare("UPDATE servers SET tool_timeout_sec=99999 WHERE id=?").run(id);
  assert.equal(Object.hasOwn(s.get(id), "toolTimeoutSec"), false);
  assert.equal(definition(s, id).toolTimeoutSec, null);
});
