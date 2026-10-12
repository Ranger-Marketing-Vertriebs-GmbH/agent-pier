import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import {
  decodeArchive,
  decryptCredentials,
} from "../../server/features/operations/archive.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
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

test("a store file that never got its tables counts as no store", async (t) => {
  const { dataDir } = (() => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-empty-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const data = path.join(root, "data");
    fs.mkdirSync(path.join(data, "mcp-servers"), { recursive: true, mode: 0o700 });
    return { dataDir: data };
  })();
  const store = path.join(dataDir, "mcp-servers/servers.sqlite");
  // privateDatabase creates the file before the store writes its schema.
  fs.writeFileSync(store, "", { mode: 0o600 });
  const backup = new Backup({ dataDir });
  for (const withCredentials of [false, true]) {
    const plan = backup.plan({ withCredentials });
    // The standard omission "MCP client grants, …" is about AgentPier's own MCP.
    assert.equal(
      [...plan.components, ...plan.omissions].some((item) =>
        /^(mcp-servers|encrypted-mcp-server-values|MCP server )/.test(item),
      ),
      false,
    );
    const { file, manifest } = await backup.create({
      includeHistory: false,
      withCredentials,
      passphrase,
    });
    assert.equal(
      manifest.omissions.some((item) => /^MCP server/.test(item)),
      false,
    );
    const archive = decodeArchive(file);
    assert.equal(
      archive.files.some((m) => m.path.startsWith("mcp-servers/")),
      false,
    );
    if (withCredentials)
      assert.equal(
        (await decryptCredentials(archive.credentials, passphrase)).some((m) =>
          m.path.startsWith("mcp-server-secrets/"),
        ),
        false,
      );
  }
});

test("a store with tables the sanitizer cannot use still fails the backup", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-bad-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(path.join(dataDir, "mcp-servers"), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "mcp-servers/servers.sqlite"));
  db.exec("CREATE TABLE unrelated(a)");
  db.close();
  await assert.rejects(new Backup({ dataDir }).create({ includeHistory: false }), {
    message: serverMessages.backups.invalidMcpServerStore,
  });
});
