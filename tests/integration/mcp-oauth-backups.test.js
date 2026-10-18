import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { loadArchive } from "../helpers/backup-archive.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import {
  createUpdateSnapshot,
  restoreUpdateSnapshot,
} from "../../server/features/assistants/runtime-update-snapshot.js";
import {
  destroyBackupKeys,
  mcpOAuthTables,
  sealDatabase,
  unsealDatabase,
} from "../../server/features/assistants/backup-credentials.js";

// OpenClaw keeps MCP OAuth logins in <state-dir>/state/openclaw.sqlite
// (docs/mcp-oauth-qualification.md): tokens and the dynamic client registration.
const access = "mcp-access-SECRET-1";
const client = "mcp-dcr-client-SECRET-2";
const verifier = "mcp-pkce-verifier-SECRET-3";
const profile = "auth-profile-SECRET-4";
const passphrase = "mcp oauth backup fixture phrase";
const stateDatabase = "state/state/openclaw.sqlite";

function temporary(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oauth-bk-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const dataDir = path.join(folder, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return { folder, dataDir };
}
function seedState(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE mcp_oauth_stores(store_key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE mcp_oauth_pending_authorizations(store_key TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE auth_profile_store(profile_id TEXT PRIMARY KEY, value_json TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, body TEXT);`);
  db.prepare("INSERT INTO mcp_oauth_stores VALUES (?,?)").run(
    "docs-hash",
    JSON.stringify({ tokens: { access_token: access }, client: { secret: client } }),
  );
  db.prepare("INSERT INTO mcp_oauth_pending_authorizations VALUES (?,?)").run(
    "docs-hash",
    JSON.stringify({ codeVerifier: verifier }),
  );
  db.prepare("INSERT INTO auth_profile_store VALUES (?,?)").run("openai:me", profile);
  db.prepare("INSERT INTO conversations VALUES (?,?)").run("c1", "history survives");
  db.close();
}
function count(file, table) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  } finally {
    db.close();
  }
}
const loginRows = (file) =>
  [...mcpOAuthTables].map((table) => count(file, table)).reduce((a, b) => a + b);
function bytesBelow(directory) {
  let text = "";
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true }))
    if (entry.isFile())
      text += fs.readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1");
  return text;
}

test("host backups leave MCP OAuth logins out, sealed or not", async (t) => {
  const { folder, dataDir } = temporary(t);
  const paths = runtimePaths(dataDir);
  writeAssistantFeature(dataDir, { enabled: true });
  seedState(path.join(paths.root, stateDatabase));
  const servers = new McpServerStore({ dataDir, pathEnv: "/fake/bin" });
  const docs = servers.create({
    name: "docs",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    auth: "oauth",
  });
  servers.rememberOAuth(docs.id, {
    connected: true,
    loginRedirect: "http://127.0.0.1:4380/api/mcp-servers/oauth/callback",
  });
  servers.close();
  const backups = new Backup({ dataDir });
  for (const withCredentials of [true, false]) {
    const { file, manifest } = await backups.create({
      withCredentials,
      ...(withCredentials ? { passphrase } : {}),
    });
    const archive = loadArchive(file);
    const text = archive.files
      .map((m) => Buffer.from(m.content, "base64").toString("latin1"))
      .join("\n");
    for (const secret of [access, client, verifier, profile])
      assert.equal(text.includes(secret), false, secret);
    // The sidecar seals the auth profile only: with the key, nothing of the login.
    const sidecar = archive.files.find(
      (m) => m.path === `assistants/${stateDatabase}.agentpier-sealed`,
    );
    assert.equal(!!sidecar, withCredentials);
    if (withCredentials) assert.deepEqual(manifest.assistants.sealed, [stateDatabase]);

    const target = path.join(folder, `restored-${withCredentials}`);
    const report = await new Restore({ dataDir }).apply({
      archive: file,
      targetDataDir: target,
      ...(withCredentials ? { passphrase } : {}),
    });
    const restored = path.join(target, "assistants", stateDatabase);
    // OpenClaw's state database is split: configuration in public, the
    // conversations only in the sealed full copy of a backup with a passphrase.
    assert.equal(loginRows(restored), 0);
    assert.equal(count(restored, "conversations"), withCredentials ? 1 : 0);
    // The auth profile comes back on this host; only it decides "assistants".
    assert.equal(count(restored, "auth_profile_store"), withCredentials ? 1 : 0);
    assert.equal(report.credentialsNeedingLogin.includes("assistants"), !withCredentials);
    // The server the login belongs to comes back without any memory of the login.
    const restoredServers = new McpServerStore({ dataDir: target, pathEnv: "/fake/bin" });
    try {
      assert.deepEqual(restoredServers.oauthMemory(docs.id), {
        everConnected: false,
        loginRedirect: null,
      });
    } finally {
      restoredServers.close();
    }
  }
});

test("a state database whose only credentials are MCP logins needs no sidecar", async (t) => {
  const { folder } = temporary(t);
  const source = path.join(folder, "openclaw.sqlite");
  seedState(source);
  const db = new DatabaseSync(source);
  db.exec("DROP TABLE auth_profile_store");
  db.close();
  const copy = path.join(folder, "copy.sqlite");
  const sealed = await sealDatabase(source, copy, {
    key: Buffer.alloc(32, 7),
    aad: "x",
    tmp: path.join(folder, "tmp"),
    omit: mcpOAuthTables,
  });
  assert.equal(sealed, false);
  assert.equal(fs.existsSync(`${copy}.agentpier-sealed`), false);
  assert.equal(loginRows(copy), 0);
  assert.equal(fs.readFileSync(copy).toString("latin1").includes(access), false);
});

test("a host restore drops MCP logins an older backup still sealed", async (t) => {
  const { folder } = temporary(t);
  const source = path.join(folder, "openclaw.sqlite");
  seedState(source);
  const key = Buffer.alloc(32, 9);
  const copy = path.join(folder, "copy.sqlite");
  // Before the exclusion, host backups sealed the logins with the other tables.
  assert.equal(
    await sealDatabase(source, copy, { key, aad: "a", tmp: path.join(folder, "tmp") }),
    true,
  );
  assert.equal(
    await unsealDatabase(copy, `${copy}.agentpier-sealed`, key, "a", mcpOAuthTables),
    true,
  );
  assert.equal(loginRows(copy), 0);
  assert.equal(count(copy, "auth_profile_store"), 1);
});

test("update snapshots seal MCP logins; a rollback keeps them while the key exists", async (t) => {
  const { dataDir } = temporary(t);
  const paths = runtimePaths(dataDir);
  seedState(path.join(paths.state, "state", "openclaw.sqlite"));
  const backup = path.join(paths.root, "backups", "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01");
  fs.mkdirSync(path.dirname(backup), { mode: 0o700 });
  const metadata = { previous: { version: "old" }, candidate: { version: "new" } };
  const manifest = await createUpdateSnapshot(paths, backup, metadata);
  assert.ok(manifest.sealed.includes(stateDatabase));
  for (const secret of [access, client, verifier])
    assert.equal(bytesBelow(backup).includes(secret), false, secret);

  const live = path.join(paths.state, "state", "openclaw.sqlite");
  const rollback = async () => {
    fs.rmSync(paths.state, { recursive: true });
    fs.mkdirSync(paths.state);
    return restoreUpdateSnapshot(paths, backup);
  };
  // The MCP server store is outside the rollback, so the login stays usable.
  assert.equal((await rollback()).credentialsWithheld, false);
  assert.equal(loginRows(live), 2);
  const db = new DatabaseSync(live, { readOnly: true });
  const stored = db.prepare("SELECT value_json FROM mcp_oauth_stores").get().value_json;
  db.close();
  assert.ok(stored.includes(access));
  // Another credential revocation destroys the keys: the login is withheld too.
  destroyBackupKeys(paths.root);
  const withheld = await rollback();
  assert.equal(withheld.credentialsWithheld, true);
  assert.equal(loginRows(live), 0);
  assert.equal(count(live, "conversations"), 1);
});
