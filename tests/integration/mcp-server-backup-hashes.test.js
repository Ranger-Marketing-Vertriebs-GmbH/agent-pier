import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CliMcpReconciler } from "../../server/features/mcp-servers/cli-reconciler.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";
import {
  archiveText,
  backupPassphrase as passphrase,
  publicStore,
  rows,
  schema,
} from "../helpers/mcp-store-backup.js";

const entriesSql =
  "SELECT server_id,cli,name,hash,pending_hash,written_at FROM cli_entries ORDER BY server_id,cli";

/**
 * Servers written into Claude Code by the real reconciler: one with values, one
 * without and one deleted whose entry record outlives it until the next reconcile.
 */
function written(t) {
  const f = cliMcpFixture(t);
  const bind = { bind: [["cli", "claude"]] };
  const docs = f.servers.create(http(), bind);
  const plain = f.servers.create(
    { name: "plain", transport: "http", url: "https://plain.example.test/mcp" },
    bind,
  );
  const gone = f.servers.create(
    http({ name: "gone", url: "https://gone.example.test/mcp" }),
    bind,
  );
  f.reconciler.reconcile("claude");
  f.servers.remove(gone.id);
  const store = path.join(f.dataDir, "mcp-servers/servers.sqlite");
  return { f, docs, plain, gone, entries: rows(store, entriesSql) };
}
const reconcilerOver = (f, servers) =>
  new CliMcpReconciler({
    servers,
    locate: (cli) => f.extensions.locations(`local-${cli}`),
    configs: (locations) => f.extensions.configs(locations),
    warn: () => {},
  });

test("the public member holds no CLI entry hash of a server whose values it withholds", async (t) => {
  const { f, plain, entries } = written(t);
  assert.equal(entries.length, 3);
  const { file } = await new Backup({ dataDir: f.dataDir, home: f.home }).create({
    includeHistory: false,
  });
  const text = archiveText(file);
  for (const row of entries.filter((r) => r.server_id !== plain.id))
    assert.equal(text.includes(row.hash), false, row.server_id);
  assert.deepEqual(
    rows(publicStore(file, f.root), entriesSql),
    entries.filter((r) => r.server_id === plain.id),
  );
});

test("a restore with credentials brings every CLI entry record back", async (t) => {
  const { f, docs, entries } = written(t);
  const { file } = await new Backup({ dataDir: f.dataDir, home: f.home }).create({
    includeHistory: false,
    withCredentials: true,
    passphrase,
  });
  const target = path.join(f.root, "restored");
  await new Restore({ dataDir: f.dataDir }).apply({
    archive: file,
    targetDataDir: target,
    passphrase,
  });
  assert.deepEqual(
    rows(path.join(target, "mcp-servers/servers.sqlite"), entriesSql),
    entries,
  );
  const servers = new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
  t.after(() => servers.close());
  const before = f.text("claude");
  // AgentPier owns the entries again: unchanged ones stay, the deleted server's goes.
  const result = reconcilerOver(f, servers).reconcile("claude");
  assert.deepEqual(result.statuses[docs.id], { status: "written" });
  assert.equal(f.entries("claude").gone, undefined);
  assert.notEqual(f.text("claude"), before);
});

test("sanitizing keeps only the store's known tables and columns", async (t) => {
  const { f } = written(t);
  const store = path.join(f.dataDir, "mcp-servers/servers.sqlite");
  const known = schema(store);
  const db = new DatabaseSync(store);
  db.exec(`CREATE TABLE future(secret TEXT); INSERT INTO future VALUES ('table-SECRET');
    ALTER TABLE servers ADD COLUMN future TEXT; UPDATE servers SET future='column-SECRET';
    CREATE VIEW future_view AS SELECT 'view-SECRET';
    CREATE TRIGGER future_trigger AFTER INSERT ON bindings BEGIN SELECT 'trigger-SECRET'; END;`);
  db.close();
  const { file } = await new Backup({ dataDir: f.dataDir, home: f.home }).create({
    includeHistory: false,
  });
  const text = archiveText(file);
  for (const secret of ["table-SECRET", "column-SECRET", "view-SECRET", "trigger-SECRET"])
    assert.equal(text.includes(secret), false, secret);
  const copy = schema(publicStore(file, f.root));
  delete copy.backup_withheld_values;
  // A table or column the sanitizer does not know fails here first: add it there.
  assert.deepEqual(copy, known);
  assert.equal(fs.existsSync(store), true);
});
