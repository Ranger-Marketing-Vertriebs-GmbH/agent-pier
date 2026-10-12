import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-cli-"));
  const s = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (f) => f.startsWith("/fake/"),
  });
  t.after(() => {
    try {
      s.close();
    } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { s, dataDir };
}
const http = { name: "docs", transport: "http", url: "https://mcp.example.test/mcp" };
const plain = (value) => ({ ...value });

test("cli bindings accept exactly the three coding CLIs", (t) => {
  const { s } = store(t);
  const { id } = s.create(http);
  s.bind(id, "cli", "codex");
  s.setClis(id, ["claude", "codex", "claude"]);
  assert.deepEqual(s.bindings("cli", "claude"), [id]);
  assert.deepEqual(s.targetsOf(id), { agents: [], clis: ["claude", "codex"] });
  assert.throws(() => s.bind(id, "cli", "gemini"), { status: 400 });
  assert.throws(() => s.setClis(id, ["shell"]), { status: 400 });
  s.bind(id, "agent", "home");
  s.setClis(id, []);
  assert.deepEqual(s.targetsOf(id), { agents: ["home"], clis: [] });
});

test("create binds in the same transaction", (t) => {
  const { s } = store(t);
  const server = s.create(http, { bind: [["cli", "opencode"]] });
  assert.deepEqual(s.targetsOf(server.id).clis, ["opencode"]);
  assert.throws(() => s.create({ ...http, name: "other" }, { bind: [["cli", "nope"]] }), {
    status: 400,
  });
  assert.deepEqual(
    s.list().map((item) => item.name),
    ["docs"],
  );
});

test("entry records keep a pending write apart and survive their server", (t) => {
  const { s } = store(t);
  const { id } = s.create(http);
  s.cliEntries.intend(id, "claude", "docs", "h1");
  assert.deepEqual(
    { ...s.cliEntries.get(id, "claude"), writtenAt: null },
    {
      serverId: id,
      cli: "claude",
      name: "docs",
      hash: null,
      pendingHash: "h1",
      writtenAt: null,
    },
  );
  s.cliEntries.settle(id, "claude", "h1");
  s.cliEntries.intend(id, "claude", "docs", "h2");
  assert.deepEqual(
    [s.cliEntries.get(id, "claude").hash, s.cliEntries.get(id, "claude").pendingHash],
    ["h1", "h2"],
  );
  // A new name drops the old hash: it belonged to the old entry.
  s.cliEntries.intend(id, "claude", "renamed", "h3");
  assert.equal(s.cliEntries.get(id, "claude").hash, null);
  s.remove(id);
  assert.equal(s.cliEntries.list("claude").length, 1);
  s.cliEntries.forget(id, "claude");
  assert.deepEqual(s.cliEntries.list("claude"), []);
});

test("the cli_entries table is created in a database that predates it", (t) => {
  const { s, dataDir } = store(t);
  s.close();
  const file = path.join(dataDir, "mcp-servers", "servers.sqlite");
  const raw = new DatabaseSync(file);
  raw.exec("DROP TABLE cli_entries");
  raw.close();
  const again = new McpServerStore({ dataDir });
  t.after(() => again.close());
  const columns = again.db
    .prepare("PRAGMA table_info(cli_entries)")
    .all()
    .map((c) => c.name);
  assert.deepEqual(columns, [
    "server_id",
    "cli",
    "name",
    "hash",
    "pending_hash",
    "written_at",
  ]);
  again.cliEntries.intend("x", "codex", "n", "h");
  assert.deepEqual(again.cliEntries.list("codex").map(plain), [
    {
      serverId: "x",
      cli: "codex",
      name: "n",
      hash: null,
      pendingHash: "h",
      writtenAt: null,
    },
  ]);
});
