import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

const exists = (file) => file === "/fake/bin/npx" || file === "/abs/server";
function store() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-"));
  return new McpServerStore({ dataDir, pathEnv: "/fake/bin", exists });
}
const http = (extra = {}) => ({
  name: "docs",
  transport: "http",
  url: "https://example.com/mcp",
  headers: { Authorization: "Bearer secret" },
  ...extra,
});

test("create returns a redacted public server and list/get never expose secrets", () => {
  const s = store();
  const created = s.create(http());
  assert.deepEqual(created, {
    id: created.id,
    name: "docs",
    transport: "http",
    url: "https://example.com/mcp",
    auth: "headers",
    headerNames: ["Authorization"],
    envNames: [],
    revision: 1,
  });
  assert.doesNotMatch(JSON.stringify([s.list(), s.get(created.id)]), /secret/);
  assert.deepEqual(s.secrets(created.id), {
    headers: { Authorization: "Bearer secret" },
    env: {},
  });
});

test("update needs the current revision and keeps omitted secrets", () => {
  const s = store();
  const { id } = s.create(http());
  const updated = s.update(id, { revision: 1, url: "https://example.com/v2" });
  assert.equal(updated.revision, 2);
  assert.equal(updated.url, "https://example.com/v2");
  assert.equal(s.secrets(id).headers.Authorization, "Bearer secret");
  assert.throws(() => s.update(id, { revision: 1, url: "https://example.com/x" }), {
    status: 409,
  });
});

test("update sets, keeps and removes headers", () => {
  const s = store();
  const { id } = s.create(http({ headers: { A: "1", B: "2" } }));
  const updated = s.update(id, { revision: 1, headers: { A: null, C: "3" } });
  assert.deepEqual(updated.headerNames, ["B", "C"]);
  assert.deepEqual(s.secrets(id).headers, { B: "2", C: "3" });
});

test("names are validated and unique regardless of case", () => {
  const s = store();
  for (const name of ["a.b", "a".repeat(31), "1abc", ""])
    assert.throws(() => s.create(http({ name })), { status: 400 });
  const { id } = s.create(http());
  assert.throws(() => s.create(http()), { status: 409 });
  assert.throws(() => s.create(http({ name: "Docs" })), { status: 409 });
  const other = s.create(http({ name: "other" }));
  assert.throws(() => s.update(other.id, { revision: 1, name: "DOCS" }), {
    status: 409,
  });
  // Renaming a server to another case of its own name is allowed.
  assert.equal(s.update(id, { revision: 1, name: "Docs" }).name, "Docs");
});

test("public servers show only the URL's origin and path", () => {
  const s = store();
  const full = "https://example.com:8443/mcp/v1?token=query-secret";
  const { id } = s.create(http({ url: full }));
  assert.equal(s.get(id).url, "https://example.com:8443/mcp/v1");
  assert.doesNotMatch(JSON.stringify(s.list()), /query-secret/);
  // The compiler still reads the full URL.
  assert.equal(s.definitions()[0].url, full);
});

test("URLs with credentials, fragments or other schemes are rejected", () => {
  const s = store();
  for (const url of [
    "https://u:p@example.com/",
    "https://example.com/#x",
    "ftp://x/y",
    "nope",
  ])
    assert.throws(() => s.create(http({ url })), { status: 400 });
});

test("sse is kept explicit and stdio resolves its command", () => {
  const s = store();
  assert.equal(s.create(http({ name: "legacy", transport: "sse" })).transport, "sse");
  const stdio = s.create({
    name: "local",
    transport: "stdio",
    command: "npx",
    args: ["-y", "pkg"],
    cwd: "/work",
    env: { TOKEN: "t" },
  });
  assert.equal(stdio.command, "/fake/bin/npx");
  assert.deepEqual(stdio.args, ["-y", "pkg"]);
  assert.equal(stdio.cwd, "/work");
  assert.deepEqual(stdio.envNames, ["TOKEN"]);
  assert.equal(
    s.create({ name: "abs", transport: "stdio", command: "/abs/server" }).command,
    "/abs/server",
  );
  assert.throws(() => s.create({ name: "bad", transport: "stdio", command: "ghost" }), {
    status: 400,
  });
  assert.throws(
    () => s.create({ name: "rel", transport: "stdio", command: "npx", cwd: "rel" }),
    { status: 400 },
  );
});

test("transport cannot change and mixed fields are rejected", () => {
  const s = store();
  const { id } = s.create(http());
  assert.throws(() => s.update(id, { revision: 1, transport: "sse" }), { status: 400 });
  assert.throws(() => s.update(id, { revision: 1, env: { A: "1" } }), { status: 400 });
});

test("bindings: bind, unbind, replace and cascade on remove", () => {
  const s = store();
  const a = s.create(http({ name: "a" })).id;
  const b = s.create(http({ name: "b" })).id;
  s.bind(a, "agent", "ag1");
  s.bind(a, "agent", "ag1");
  s.bind(b, "agent", "ag1");
  assert.deepEqual(s.bindings("agent", "ag1"), [a, b]);
  s.setBindings("agent", "ag1", [b]);
  assert.deepEqual(s.bindings("agent", "ag1"), [b]);
  assert.throws(() => s.setBindings("agent", "ag1", [a, "missing"]), { status: 404 });
  assert.deepEqual(s.bindings("agent", "ag1"), [b]);
  s.unbind(b, "agent", "ag1");
  assert.deepEqual(s.bindings("agent", "ag1"), []);
  s.bind(a, "agent", "ag2");
  s.remove(a);
  assert.deepEqual(s.bindings("agent", "ag2"), []);
  assert.throws(() => s.get(a), { status: 404 });
  assert.throws(() => s.bind(b, "cli-profile", "p"), { status: 400 });
});

test("values with environment or file references are refused on create and update", () => {
  const s = store();
  const refused = (fn, field, names) =>
    assert.throws(fn, (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "MCP_SERVER_VALUE_REFERENCE");
      assert.equal(error.field, field);
      assert.deepEqual(error.names, names);
      assert.doesNotMatch(
        JSON.stringify({ ...error, message: error.message }),
        /TOKEN_VALUE|HOST_VALUE/,
      );
      return true;
    });
  refused(
    () => s.create(http({ headers: { Authorization: "Bearer ${TOKEN_VALUE}" } })),
    "headers",
    ["Authorization"],
  );
  refused(() => s.create(http({ url: "https://{env:HOST_VALUE}/mcp" })), "url", []);
  const stdio = (extra) => ({
    name: "local",
    transport: "stdio",
    command: "/abs/server",
    ...extra,
  });
  refused(() => s.create(stdio({ command: "${TOKEN_VALUE}/server" })), "command", []);
  refused(() => s.create(stdio({ args: ["--key", "{file:TOKEN_VALUE}"] })), "args", []);
  refused(() => s.create(stdio({ cwd: "/work/${TOKEN_VALUE:-x}" })), "cwd", []);
  refused(() => s.create(stdio({ env: { KEY: "{env:TOKEN_VALUE}" } })), "env", ["KEY"]);
  assert.deepEqual(s.list(), []);
  const created = s.create(http());
  refused(
    () =>
      s.update(created.id, {
        revision: created.revision,
        headers: { "X-Key": "${TOKEN_VALUE}" },
      }),
    "headers",
    ["X-Key"],
  );
  // Literal dollars and braces are fine.
  const updated = s.update(created.id, {
    revision: created.revision,
    headers: { "X-Key": "a$b{c}" },
  });
  assert.deepEqual(updated.headerNames, ["Authorization", "X-Key"]);
});

test("an unchanged stored reference never blocks a save; a changed one is refused", () => {
  const s = store();
  const remote = s.create(http());
  const local = s.create({
    name: "local",
    transport: "stdio",
    command: "/abs/server",
    args: ["--plain"],
  });
  // Stored before the check existed: written directly.
  s.db
    .prepare("UPDATE servers SET url=? WHERE id=?")
    .run("https://example.com/${X}/mcp", remote.id);
  s.db
    .prepare("UPDATE servers SET args=?, cwd=? WHERE id=?")
    .run(JSON.stringify(["--root", "${X}"]), "/work/${X}", local.id);
  const renamed = s.update(remote.id, {
    revision: remote.revision,
    name: "docs2",
    url: "https://example.com/${X}/mcp",
  });
  assert.equal(renamed.name, "docs2");
  const saved = s.update(local.id, {
    revision: local.revision,
    command: "/abs/server",
    args: ["--root", "${X}"],
    cwd: "/work/${X}",
    env: { PLAIN: "value" },
  });
  assert.deepEqual(saved.envNames, ["PLAIN"]);
  assert.throws(
    () =>
      s.update(remote.id, {
        revision: renamed.revision,
        url: "https://example.com/${Y}/mcp",
      }),
    { status: 400, code: "MCP_SERVER_VALUE_REFERENCE", field: "url" },
  );
  assert.throws(
    () => s.update(local.id, { revision: saved.revision, args: ["--root", "${Y}"] }),
    { status: 400, code: "MCP_SERVER_VALUE_REFERENCE", field: "args" },
  );
  assert.throws(
    () => s.update(local.id, { revision: saved.revision, env: { K: "{env:Y}" } }),
    { status: 400, code: "MCP_SERVER_VALUE_REFERENCE", field: "env" },
  );
});
