import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

const exists = (file) => file === "/fake/bin/npx";
const dataDirs = [];
after(() => dataDirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));
function dir() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-"));
  dataDirs.push(dataDir);
  return dataDir;
}
const store = (dataDir = dir()) =>
  new McpServerStore({ dataDir, pathEnv: "/fake/bin", exists });
const remote = (extra = {}) => ({
  name: "docs",
  transport: "http",
  url: "https://example.com/mcp",
  ...extra,
});

test("a remote server defaults to header authentication", () => {
  const s = store();
  const created = s.create(remote({ headers: { Authorization: "Bearer x" } }));
  assert.equal(created.auth, "headers");
  assert.equal("oauthScope" in created, false);
  assert.equal(s.definitions()[0].auth, "headers");
});

test("oauth is allowed on http and sse and shows in the public projection", () => {
  const s = store();
  const a = s.create(remote({ auth: "oauth", oauthScope: "  read write " }));
  const b = s.create(remote({ name: "events", transport: "sse", auth: "oauth" }));
  assert.equal(a.auth, "oauth");
  assert.equal(a.oauthScope, "read write");
  assert.equal(b.auth, "oauth");
  assert.equal("oauthScope" in b, false);
  assert.equal(s.definitions()[0].oauthScope, "read write");
});

test("stdio servers reject auth and scope", () => {
  const s = store();
  const stdio = { name: "local", transport: "stdio", command: "npx" };
  assert.throws(() => s.create({ ...stdio, auth: "oauth" }), { status: 400 });
  assert.throws(() => s.create({ ...stdio, auth: "headers" }), { status: 400 });
  assert.throws(() => s.create({ ...stdio, oauthScope: "x" }), { status: 400 });
  assert.equal(s.create(stdio).auth, "headers");
});

test("auth must be a known method and the scope a short string", () => {
  const s = store();
  assert.throws(() => s.create(remote({ auth: "basic" })), { status: 400 });
  assert.throws(() => s.create(remote({ auth: "oauth", oauthScope: 5 })), {
    status: 400,
  });
  assert.throws(() => s.create(remote({ auth: "oauth", oauthScope: "a".repeat(513) })), {
    status: 400,
  });
  assert.equal(
    s.create(remote({ auth: "oauth", oauthScope: "a".repeat(512) })).oauthScope.length,
    512,
  );
});

test("an empty scope is absent and a scope is dropped with headers", () => {
  const s = store();
  assert.equal(
    "oauthScope" in s.create(remote({ auth: "oauth", oauthScope: "  " })),
    false,
  );
  const h = s.create(remote({ name: "other", oauthScope: "read" }));
  assert.equal("oauthScope" in h, false);
});

test("oauth rejects headers on create", () => {
  const s = store();
  assert.throws(
    () => s.create(remote({ auth: "oauth", headers: { Authorization: "x" } })),
    { status: 400 },
  );
});

test("switching to oauth deletes the stored header secrets", () => {
  const s = store();
  const { id } = s.create(remote({ headers: { Authorization: "Bearer x", "X-A": "1" } }));
  const updated = s.update(id, { revision: 1, auth: "oauth", oauthScope: "read" });
  assert.equal(updated.revision, 2);
  assert.deepEqual(updated.headerNames, []);
  assert.deepEqual(s.secrets(id).headers, {});
  assert.throws(() => s.update(id, { revision: 2, headers: { A: "b" } }), {
    status: 400,
  });
  const back = s.update(id, { revision: 2, auth: "headers", headers: { A: "b" } });
  assert.equal(back.auth, "headers");
  assert.equal("oauthScope" in back, false);
  assert.deepEqual(s.secrets(id).headers, { A: "b" });
});

test("an update keeps the stored method and scope when omitted", () => {
  const s = store();
  const { id } = s.create(remote({ auth: "oauth", oauthScope: "read" }));
  const updated = s.update(id, { revision: 1, url: "https://example.com/v2" });
  assert.equal(updated.auth, "oauth");
  assert.equal(updated.oauthScope, "read");
});

test("records from before OAuth read as headers", () => {
  const dataDir = dir();
  const folder = path.join(dataDir, "mcp-servers");
  fs.mkdirSync(folder, { recursive: true });
  const old = new DatabaseSync(path.join(folder, "servers.sqlite"));
  old.exec(`CREATE TABLE servers(
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
    url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT,
    settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL);
    INSERT INTO servers(id,name,transport,url,revision) VALUES ('1','old','http','https://example.com/mcp',1);`);
  old.close();
  const s = store(dataDir);
  assert.equal(s.get("1").auth, "headers");
  assert.equal(s.definitions()[0].auth, "headers");
  assert.equal(s.update("1", { revision: 1, auth: "oauth" }).auth, "oauth");
});

test("oauth rejects env on a remote server", () => {
  const s = store();
  assert.throws(() => s.create(remote({ auth: "oauth", env: { A: "b" } })), {
    status: 400,
  });
  const { id } = s.create(remote({ auth: "oauth" }));
  assert.throws(() => s.update(id, { revision: 1, env: {} }), { status: 400 });
  assert.equal(s.get(id).revision, 1);
});

test("switching to oauth with headers is rejected and keeps the stored secrets", () => {
  const s = store();
  const { id } = s.create(remote({ headers: { Authorization: "Bearer x" } }));
  assert.throws(
    () => s.update(id, { revision: 1, auth: "oauth", headers: { Authorization: "y" } }),
    { status: 400 },
  );
  const kept = s.get(id);
  assert.equal(kept.revision, 1);
  assert.equal(kept.auth, "headers");
  assert.deepEqual(s.secrets(id).headers, { Authorization: "Bearer x" });
});
