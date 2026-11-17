import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { stripOpenClawRows } from "../../server/features/operations/private-tables.js";
import { isPrivateAssistantPath } from "../../server/features/operations/private-content.js";
import { agentFolders } from "../../server/features/assistants/agent-deletion.js";

// OpenClaw's memory wiki in backups and deletion (ADR 0007, step 7b). Its vault lies below
// state/wiki/<runtimeAgentId>/ and is private as a whole. Its rows in
// plugin_state_entries (the contract test with 2026.11.3: namespace "source-sync",
// each naming the absolute path of an imported memory note of the agent; import runs
// name page paths) stay out of the public configuration copy, while every other
// plugin's state stays there. The sealed full copy keeps them all.

test("the wiki vault is private content, file by file", () => {
  for (const file of [
    "state/wiki/ap-a1/index.md",
    "state/wiki/ap-a1/syntheses/quartz-notes.md",
    "state/wiki/ap-a1/sources/bridge-a1-memory.md",
    "state/wiki/ap-a1/.openclaw-wiki/log.jsonl",
  ])
    assert.equal(isPrivateAssistantPath(file), true, file);
});

test("the public copy keeps other plugins' state and drops the wiki's rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE plugin_state_entries (plugin_id TEXT, namespace TEXT,
    entry_key TEXT, value_json TEXT, created_at INTEGER, expires_at INTEGER)`);
  db.exec(
    "CREATE TABLE plugin_blob_entries (plugin_id TEXT, namespace TEXT, entry_key TEXT, value BLOB)",
  );
  const insert = db.prepare(
    "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json) VALUES (?, ?, ?, ?)",
  );
  insert.run(
    "memory-wiki",
    "source-sync",
    "k1",
    JSON.stringify({ sourcePath: "/data/assistants/workspaces/a1/MEMORY.md" }),
  );
  insert.run("memory-wiki", "import-runs", "k2", JSON.stringify({ pagePaths: ["x.md"] }));
  insert.run("agentpier-teams", "settings", "k3", JSON.stringify({ kept: true }));
  db.prepare("INSERT INTO plugin_blob_entries VALUES (?, ?, ?, ?)").run(
    "memory-wiki",
    "compiled-cache",
    "owner",
    Buffer.from("pages"),
  );
  assert.equal(stripOpenClawRows(db), true);
  assert.deepEqual(
    db
      .prepare("SELECT plugin_id, entry_key FROM plugin_state_entries")
      .all()
      .map((r) => ({ ...r })),
    [{ plugin_id: "agentpier-teams", entry_key: "k3" }],
  );
  // The compiled cache is no configuration table: private as before.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM plugin_blob_entries").get().n, 0);
});

test("deleting an agent removes its wiki vault with its other folders", () => {
  const paths = {
    root: "/d/assistants",
    workspaces: "/d/assistants/workspaces",
    state: "/d/assistants/state",
  };
  const id = "0ac6e669-ce6e-47a6-8998-1b3574698d00";
  const folders = agentFolders(paths, { id, runtimeAgentId: `ap-${id}` });
  assert.ok(folders.includes(`/d/assistants/state/wiki/ap-${id}`));
  assert.ok(folders.includes(`/d/assistants/workspaces/${id}`));
});
