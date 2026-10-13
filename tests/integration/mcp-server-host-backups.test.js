import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { decryptCredentials } from "../../server/features/operations/archive.js";
import { loadArchive, encodeArchiveV2 } from "../helpers/backup-archive.js";
import { fileMember } from "../../server/features/operations/snapshot.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { CliMcpReconciler } from "../../server/features/mcp-servers/cli-reconciler.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { cliMcpFixture, http } from "../helpers/cli-mcp.js";

const passphrase = "mcp server backup fixture phrase";
const secrets = ["header-SECRET-1", "env-SECRET-2", "query-SECRET-3"];
const loginRedirect = "http://127.0.0.1:4999/api/mcp-servers/oauth/callback";

function temporary(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-store-bk-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return { folder, dataDir };
}
const open = (dataDir) =>
  new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: (file) => file.startsWith("/fake/"),
  });

/** A store with a header server (query token), a stdio server, a plain and an OAuth one. */
function seed(dataDir) {
  const servers = open(dataDir);
  const docs = servers.create(
    {
      name: "docs",
      transport: "http",
      url: `https://mcp.example.test/v1?token=${secrets[2]}&x=1`,
      headers: { Authorization: `Bearer ${secrets[0]}` },
    },
    { bind: [["agent", "home"]] },
  );
  const local = servers.create(
    {
      name: "local",
      transport: "stdio",
      command: "/fake/bin/server",
      args: ["--port", "1"],
      env: { TOKEN: secrets[1] },
    },
    { bind: [["cli", "codex"]] },
  );
  const plain = servers.create({
    name: "plain",
    transport: "http",
    url: "https://plain.example.test/mcp",
  });
  const login = servers.create({
    name: "login",
    transport: "http",
    url: "https://login.example.test/mcp",
    auth: "oauth",
  });
  servers.rememberOAuth(login.id, { connected: true, loginRedirect });
  servers.deferLogout({
    name: "old",
    url: "https://old.example.test/mcp",
    transport: "http",
  });
  servers.recordLogout({ name: "gone", url: "https://gone.example.test/mcp" }, 1);
  const before = {
    docs: { url: servers.definitions().find((d) => d.id === docs.id).url },
    secrets: { docs: servers.secrets(docs.id), local: servers.secrets(local.id) },
  };
  servers.close();
  return { docs, local, plain, login, before };
}
function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}
/** Every byte the archive holds: its JSON and each decoded member. */
function archiveText(file) {
  const bytes = fs.readFileSync(file);
  const archive = loadArchive(bytes);
  return [
    gunzipSync(bytes).toString("latin1"),
    ...archive.files.map((m) => Buffer.from(m.content, "base64").toString("latin1")),
  ].join("\n");
}

test("a host backup captures the MCP server store without values, tokens or logins", async (t) => {
  const { folder, dataDir } = temporary(t);
  const { docs, local, login } = seed(dataDir);
  const { file, manifest } = await new Backup({ dataDir }).create({});
  const text = archiveText(file);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  // The whole redirect, not its port: four digits also turn up in compressed bytes.
  assert.equal(text.includes(loginRedirect), false, "instance-specific login redirect");
  const archive = loadArchive(file);
  const member = archive.files.find((m) => m.path === "mcp-servers/servers.sqlite");
  assert.ok(member);
  assert.equal(
    archive.files.some((m) => m.path.startsWith("mcp-server-secrets/")),
    false,
  );
  assert.ok(
    manifest.captures.some(
      (c) =>
        c.component === "mcp-servers/servers.sqlite" &&
        c.consistency === "sqlite-snapshot",
    ),
  );
  const copy = path.join(folder, "copy.sqlite");
  fs.writeFileSync(copy, Buffer.from(member.content, "base64"));
  assert.deepEqual(rows(copy, "SELECT * FROM server_secrets"), []);
  assert.deepEqual(rows(copy, "SELECT * FROM oauth_logouts"), []);
  assert.deepEqual(rows(copy, "SELECT * FROM oauth_logout_history"), []);
  const servers = Object.fromEntries(
    rows(copy, "SELECT * FROM servers").map((row) => [row.name, row]),
  );
  assert.equal(servers.docs.url, "https://mcp.example.test/v1");
  assert.equal(servers.plain.url, "https://plain.example.test/mcp");
  assert.equal(servers.login.oauth_connected, 0);
  assert.equal(servers.login.oauth_login_redirect, null);
  assert.deepEqual(
    rows(
      copy,
      "SELECT server_id,target_kind,target_id FROM bindings ORDER BY target_kind",
    ),
    [
      { server_id: docs.id, target_kind: "agent", target_id: "home" },
      { server_id: local.id, target_kind: "cli", target_id: "codex" },
    ],
  );
  // Withheld servers' CLI entry hashes would reveal their values (see the hash tests).
  assert.deepEqual(rows(copy, "SELECT * FROM cli_entries"), []);
  assert.ok(login.id);
});

test("with credentials the values are sealed and a restore brings them back exactly", async (t) => {
  const { folder, dataDir } = temporary(t);
  const { docs, local, before } = seed(dataDir);
  const { file } = await new Backup({ dataDir }).create({
    withCredentials: true,
    passphrase,
  });
  const text = archiveText(file);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  const archive = loadArchive(file);
  const sealed = await decryptCredentials(archive.credentials, passphrase);
  assert.ok(sealed.some((m) => m.path === "mcp-server-secrets/servers.json"));

  const target = path.join(folder, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: file,
    targetDataDir: target,
    passphrase,
  });
  assert.deepEqual(
    report.credentialsNeedingLogin.filter((item) => item.startsWith("mcp")),
    [],
  );
  assert.equal(fs.existsSync(path.join(target, "mcp-server-secrets")), false);
  const restored = open(target);
  try {
    assert.equal(
      restored.definitions().find((d) => d.id === docs.id).url,
      before.docs.url,
    );
    assert.deepEqual(restored.secrets(docs.id), before.secrets.docs);
    assert.deepEqual(restored.secrets(local.id), before.secrets.local);
    assert.deepEqual(restored.targetsOf(docs.id).agents, ["home"]);
  } finally {
    restored.close();
  }
  const tables = rows(
    path.join(target, "mcp-servers/servers.sqlite"),
    "SELECT name FROM sqlite_master WHERE type='table'",
  ).map((row) => row.name);
  assert.equal(tables.includes("backup_withheld_values"), false);
});

test("a restore without credentials names exactly the servers that need values", async (t) => {
  const { folder, dataDir } = temporary(t);
  const { docs, local, plain } = seed(dataDir);
  const { file } = await new Backup({ dataDir }).create({});
  const target = path.join(folder, "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: file,
    targetDataDir: target,
  });
  assert.deepEqual(
    report.credentialsNeedingLogin.filter((item) => item.startsWith("mcp")),
    ["mcp:docs", "mcp-address:docs", "mcp:local"],
  );
  const restored = open(target);
  try {
    assert.deepEqual(restored.secrets(docs.id), { headers: {}, env: {} });
    assert.deepEqual(restored.secrets(local.id), { headers: {}, env: {} });
    assert.equal(restored.get(docs.id).url, "https://mcp.example.test/v1");
    assert.equal(restored.get(plain.id).url, "https://plain.example.test/mcp");
  } finally {
    restored.close();
  }
});

test("a store from before OAuth and CLI entries restores and opens", async (t) => {
  const { folder, dataDir } = temporary(t);
  fs.mkdirSync(path.join(dataDir, "mcp-servers"), { mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "mcp-servers/servers.sqlite"));
  db.exec(`CREATE TABLE servers(
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, transport TEXT NOT NULL,
      url TEXT, command TEXT, args TEXT NOT NULL DEFAULT '[]', cwd TEXT,
      settings TEXT NOT NULL DEFAULT '{}', revision INTEGER NOT NULL);
    CREATE TABLE server_secrets(server_id TEXT NOT NULL, kind TEXT NOT NULL,
      name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(server_id, kind, name));
    CREATE TABLE bindings(server_id TEXT NOT NULL, target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL, PRIMARY KEY(server_id, target_kind, target_id));`);
  db.prepare(
    "INSERT INTO servers(id,name,transport,url,revision) VALUES (?,?,?,?,1)",
  ).run("s1", "old", "http", `https://old.example.test/mcp?k=${secrets[2]}`);
  db.prepare("INSERT INTO server_secrets VALUES ('s1','header','X-Key',?)").run(
    secrets[0],
  );
  db.close();
  for (const withCredentials of [false, true]) {
    const { file } = await new Backup({ dataDir }).create({
      withCredentials,
      passphrase,
    });
    for (const secret of [secrets[0], secrets[2]])
      assert.equal(archiveText(file).includes(secret), false);
    const target = path.join(folder, `restored-${withCredentials}`);
    const report = await new Restore({ dataDir }).apply({
      archive: file,
      targetDataDir: target,
      ...(withCredentials ? { passphrase } : {}),
    });
    assert.deepEqual(
      report.credentialsNeedingLogin.filter((item) => item.startsWith("mcp")),
      withCredentials ? [] : ["mcp:old", "mcp-address:old"],
    );
    const restored = open(target);
    try {
      assert.equal(restored.get("s1").auth, "headers");
      assert.deepEqual(
        restored.secrets("s1").headers,
        withCredentials ? { "X-Key": secrets[0] } : {},
      );
    } finally {
      restored.close();
    }
  }
});

test("a restore refuses an unknown member below mcp-servers", async (t) => {
  const { dataDir } = temporary(t);
  const bytes = encodeArchiveV2({
    format: "agentpier-backup",
    version: 1,
    manifest: {
      schemaVersion: 1,
      applicationVersion: "test",
      createdAt: new Date().toISOString(),
      withCredentials: false,
      includeHistory: false,
      omissions: [],
      captures: [],
    },
    files: [fileMember("mcp-servers/other.sqlite", Buffer.from("x"))],
  });
  await assert.rejects(new Restore({ dataDir }).inspect({ archive: bytes }), {
    message: serverMessages.backups.unexpectedComponent,
  });
});

test("the restored store reconciles: missing managed entries return, changed ones stay", async (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), {
    bind: [
      ["cli", "claude"],
      ["cli", "codex"],
    ],
  });
  for (const cli of ["claude", "codex"]) f.reconciler.reconcile(cli);
  const written = f.entries("claude").docs;
  assert.ok(written);
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
  // The new host lacks Claude's entry; the owner changed Codex's by hand.
  fs.rmSync(f.file("claude"));
  const edited = { ...f.entries("codex").docs, url: "https://edited.example.test/mcp" };
  f.write("codex", { docs: edited });
  const servers = new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
  t.after(() => servers.close());
  const reconciler = new CliMcpReconciler({
    servers,
    locate: (cli) => f.extensions.locations(`local-${cli}`),
    configs: (locations) => f.extensions.configs(locations),
    warn: () => {},
  });
  assert.deepEqual(reconciler.reconcile("claude").statuses[server.id], {
    status: "written",
  });
  assert.deepEqual(f.entries("claude").docs, written);
  assert.deepEqual(reconciler.reconcile("codex").statuses[server.id], {
    status: "conflict",
  });
  assert.deepEqual(f.entries("codex").docs, edited);
});

test("a restore without values leaves the server's native CLI entries to the owner", async (t) => {
  const f = cliMcpFixture(t);
  const server = f.servers.create(http(), { bind: [["cli", "claude"]] });
  f.reconciler.reconcile("claude");
  const before = f.text("claude");
  assert.match(before, /query-secret/);
  const backups = new Backup({ dataDir: f.dataDir, home: f.home });
  const restore = new Restore({ dataDir: f.dataDir });
  const sealed = await backups.create({ withCredentials: true, passphrase });
  const kept = path.join(f.root, "with-values");
  await restore.apply({ archive: sealed.file, targetDataDir: kept, passphrase });
  const withValues = open(kept);
  try {
    assert.equal(withValues.cliEntries.get(server.id, "claude").name, "docs");
  } finally {
    withValues.close();
  }

  const { file } = await backups.create({});
  const target = path.join(f.root, "restored");
  await restore.apply({ archive: file, targetDataDir: target });
  const servers = open(target);
  t.after(() => servers.close());
  assert.equal(servers.cliEntries.get(server.id, "claude"), null);
  assert.deepEqual(servers.targetsOf(server.id).clis, ["claude"]);
  const reconciler = new CliMcpReconciler({
    servers,
    locate: (cli) => f.extensions.locations(`local-${cli}`),
    configs: (locations) => f.extensions.configs(locations),
    warn: () => {},
  });
  assert.deepEqual(reconciler.reconcile("claude").statuses[server.id], {
    status: "name-taken",
  });
  assert.equal(f.text("claude"), before);
});
