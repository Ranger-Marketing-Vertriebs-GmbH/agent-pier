import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import {
  decodeArchive,
  encodeArchive,
} from "../../server/features/operations/archive.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import {
  captureAssistants,
  isAssistantMember,
} from "../../server/features/operations/assistant-backup.js";
import {
  readAssistantFeature,
  writeAssistantFeature,
} from "../../server/features/assistants/assistant-feature.js";
import { needsAssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { selectedAssistantRuntime } from "../../server/features/assistants/runtime-install.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { destroyBackupKeys } from "../../server/features/assistants/backup-credentials.js";

const botToken = "fixture-bot-token-123456";
const providerKey = "fixture-provider-key-abcdef";
const oauth = "fixture-oauth-refresh-987";
const passphrase = "assistant backup fixture phrase";

function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "assistant-host-backup-")),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return { temporary, dataDir, root: path.join(dataDir, "assistants") };
}
function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}
function assistantData(root) {
  const store = new AssistantStore({ dataDir: path.dirname(root) });
  store.db
    .prepare("INSERT INTO assistants VALUES (?,?,?)")
    .run("home", 1, JSON.stringify({ id: "home", name: "Home" }));
  store.close();
  const channels = new DatabaseSync(path.join(root, "channels.sqlite"));
  channels.exec(
    "CREATE TABLE channels(id TEXT PRIMARY KEY, name TEXT); CREATE TABLE channel_credentials(id TEXT PRIMARY KEY, token TEXT)",
  );
  channels.prepare("INSERT INTO channels VALUES (?,?)").run("telegram", "Family chat");
  channels
    .prepare("INSERT INTO channel_credentials VALUES (?,?)")
    .run("telegram", botToken);
  channels.close();
  write(root, "settings.json", JSON.stringify({ enabled: true }));
  write(
    root,
    "state/openclaw.json",
    JSON.stringify({
      gateway: { port: 1 },
      agents: { defaults: { workspace: path.join(root, "workspaces") } },
      models: { providers: { x: { apiKey: providerKey } } },
    }),
  );
  write(root, "state/credentials/oauth.json", JSON.stringify({ refresh: oauth }));
  write(root, "update.json", JSON.stringify({ phase: "complete" }));
  for (const name of ["runtime.json", "candidate.json"])
    write(
      root,
      name,
      JSON.stringify({
        nodePath: path.join(root, "runtimes/openclaw/bin/node"),
        entryPath: path.join(root, "runtimes/openclaw/openclaw.mjs"),
      }),
    );
  write(root, "workspaces/home/notes.md", "remember the milk");
  write(root, "workspaces/home/cache/recipe.md", "the user's own cache folder");
  write(root, "logs/gateway.log", "started");
  for (const excluded of [
    "runtimes/openclaw/bin/node",
    "npm-cache/_cacache/index",
    "tmp/snapshot-1/database",
    "backups/8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01/payload/state/openclaw.json",
    "tls/gateway-key.pem",
    "backup-keys/8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01.key",
    "owner.json",
    "reminder-webhook.json",
  ])
    write(root, excluded, "excluded");
}
const members = (file) => decodeArchive(file).files;
function plaintext(file) {
  return members(file)
    .map((member) => Buffer.from(member.content, "base64").toString("latin1"))
    .join("\n");
}
function rows(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

test("host backups include assistant data without runtimes, caches or keys", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  const backup = await new Backup({ dataDir }).create();
  const paths = members(backup.file).map((member) => member.path);
  for (const expected of [
    "assistants/assistants.sqlite",
    "assistants/channels.sqlite",
    "assistants/settings.json",
    "assistants/state/openclaw.json",
    "assistants/workspaces/home/notes.md",
  ])
    assert.ok(paths.includes(expected), expected);
  for (const excluded of [
    "logs",
    "runtimes",
    "npm-cache",
    "tmp",
    "backups",
    "tls",
    "backup-keys",
    "owner.json",
    "reminder-webhook.json",
  ])
    assert.equal(
      paths.some(
        (name) =>
          name === `assistants/${excluded}` || name.startsWith(`assistants/${excluded}/`),
      ),
      false,
      excluded,
    );
  // Without credentials nothing secret is kept, not even in sealed form.
  const bytes = plaintext(backup.file);
  for (const secret of [botToken, providerKey, oauth])
    assert.equal(bytes.includes(secret), false);
  assert.equal(
    paths.some((name) => name.endsWith(".agentpier-sealed")),
    false,
  );
  assert.deepEqual(fs.readdirSync(path.join(root, "backup-keys")), [
    "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01.key",
  ]);
  assert.ok(new Backup({ dataDir }).plan({}).components.includes("assistants"));

  const target = path.join(path.dirname(dataDir), "restored");
  const report = await new Restore({ dataDir }).apply({
    archive: backup.file,
    targetDataDir: target,
  });
  const restored = path.join(target, "assistants");
  assert.equal(
    rows(path.join(restored, "channels.sqlite"), "SELECT name FROM channels")[0].name,
    "Family chat",
  );
  assert.deepEqual(
    rows(path.join(restored, "channels.sqlite"), "SELECT * FROM channel_credentials"),
    [],
  );
  assert.equal(
    rows(path.join(restored, "assistants.sqlite"), "SELECT id FROM assistants")[0].id,
    "home",
  );
  assert.equal(
    fs.readFileSync(path.join(restored, "workspaces/home/notes.md"), "utf8"),
    "remember the milk",
  );
  assert.equal(fs.existsSync(path.join(restored, "state/credentials/oauth.json")), false);
  assert.ok(report.credentialsNeedingLogin.includes("assistants"));
});

test("credentialed host backups seal assistant secrets with a revocable key", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  const backup = await new Backup({ dataDir }).create({
    withCredentials: true,
    passphrase,
  });
  const id = backup.backup.id;
  const bytes = plaintext(backup.file);
  for (const secret of [botToken, providerKey, oauth])
    assert.equal(bytes.includes(secret), false);
  assert.ok(fs.existsSync(path.join(root, "backup-keys", `${id}.key`)));

  const restore = new Restore({ dataDir });
  const first = path.join(path.dirname(dataDir), "first");
  const report = await restore.apply({
    archive: backup.file,
    targetDataDir: first,
    passphrase,
  });
  const restored = path.join(first, "assistants");
  assert.equal(report.credentialsNeedingLogin.includes("assistants"), false);
  assert.equal(
    rows(
      path.join(restored, "channels.sqlite"),
      "SELECT token FROM channel_credentials",
    )[0].token,
    botToken,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "state/openclaw.json"))).models
      .providers.x.apiKey,
    providerKey,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "state/credentials/oauth.json")))
      .refresh,
    oauth,
  );
  assert.equal(
    fs
      .readdirSync(restored, { recursive: true })
      .some((n) => n.endsWith(".agentpier-sealed")),
    false,
  );

  // A later logout or revocation destroys the key; the backup can no longer restore it.
  destroyBackupKeys(root);
  const second = path.join(path.dirname(dataDir), "second");
  const withheld = await restore.apply({
    archive: backup.file,
    targetDataDir: second,
    passphrase,
  });
  const revoked = path.join(second, "assistants");
  assert.ok(withheld.credentialsNeedingLogin.includes("assistants"));
  assert.deepEqual(
    rows(path.join(revoked, "channels.sqlite"), "SELECT * FROM channel_credentials"),
    [],
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(revoked, "state/openclaw.json"))).models
      .providers.x.apiKey,
    undefined,
  );
  assert.equal(fs.existsSync(path.join(revoked, "state/credentials/oauth.json")), false);
});

test("removing a host backup destroys its assistant key", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  const operations = new Backup({ dataDir });
  const { backup } = await operations.create({ withCredentials: true, passphrase });
  assert.ok(fs.existsSync(path.join(root, "backup-keys", `${backup.id}.key`)));
  operations.remove(backup.id);
  assert.equal(fs.existsSync(path.join(root, "backup-keys", `${backup.id}.key`)), false);
});

test("a dormant data directory gains no assistant folder from a host backup", async (t) => {
  const { dataDir, root } = fixture(t);
  const operations = new Backup({ dataDir });
  assert.equal(operations.plan({}).components.includes("assistants"), false);
  const backup = await operations.create({ withCredentials: true, passphrase });
  assert.equal(fs.existsSync(root), false);
  assert.equal(
    members(backup.file).some((member) => member.path.startsWith("assistants/")),
    false,
  );
});

test("restores reject assistant members outside the backed-up folders", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  for (const name of [
    "assistants/runtimes/openclaw/bin/node",
    "assistants/tls/gateway-key.pem",
    "assistants/backup-keys/x.key",
    "assistants/owner.json",
    "assistants/../accounts.json",
    "assistants/state/../../config.json",
  ])
    assert.equal(isAssistantMember(name), false, name);
  assert.equal(isAssistantMember("assistants/state/openclaw.json"), true);
  const backup = await new Backup({ dataDir }).create({
    withCredentials: true,
    passphrase,
  });
  const archive = decodeArchive(backup.file);
  // A sealed member the manifest does not declare is never accepted.
  archive.manifest.assistants.sealed = [];
  const tampered = path.join(path.dirname(dataDir), "tampered.apbackup");
  fs.writeFileSync(tampered, encodeArchive(archive));
  await assert.rejects(new Restore({ dataDir }).inspect({ archive: tampered }), {
    status: 400,
    message: serverMessages.backups.invalidManifest,
  });
});

test("a restore to a new path reinstalls the runtime instead of trusting old paths", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  const backup = await new Backup({ dataDir }).create();
  const paths = members(backup.file).map((member) => member.path);
  for (const name of ["runtime.json", "candidate.json", "update.json"])
    assert.equal(paths.includes(`assistants/${name}`), false, name);
  assert.ok(paths.includes("assistants/workspaces/home/cache/recipe.md"));
  const target = path.join(path.dirname(dataDir), "moved");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  const restored = path.join(target, "assistants");
  // The opt-in file stays with the data directory; stored agents enable the restore.
  assert.equal(fs.existsSync(path.join(target, "assistant-feature.json")), false);
  assert.deepEqual(readAssistantFeature(target), { enabled: true, error: null });
  assert.equal(needsAssistantMaintenance({ root: restored }), false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(restored, "state/openclaw.json"))).agents
      .defaults.workspace,
    path.join(restored, "workspaces"),
  );
  await assert.rejects(
    selectedAssistantRuntime({
      dataDir: target,
      download: async () => {
        throw Object.assign(Error("fixture reinstall"), { code: "FIXTURE_REINSTALL" });
      },
    }),
    { code: "FIXTURE_REINSTALL" },
  );
});

test("a host backup waits for a running update and skips unfinished update state", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  let busy = true;
  const operations = new Backup({ dataDir, assistantsBusy: () => busy });
  await assert.rejects(operations.create(), {
    status: 409,
    message: serverMessages.backups.assistantsBusy,
  });
  busy = false;
  // State a crashed update left behind never locks host backups out.
  for (const [name, content] of [
    ["update.json", { phase: "activating" }],
    ["runtime-maintenance.json", { cronEnabled: false }],
  ]) {
    write(root, name, JSON.stringify(content));
    const { file, manifest } = await operations.create();
    assert.ok(manifest.omissions.includes("Agent data skipped: unfinished update state"));
    assert.equal(
      members(file).some((member) => member.path.startsWith("assistants/")),
      false,
    );
    fs.rmSync(path.join(root, name));
    write(root, "update.json", JSON.stringify({ phase: "complete" }));
  }
  // A dormant install is never waited for.
  writeAssistantFeature(dataDir, { enabled: false });
  busy = true;
  await operations.create();
  assert.equal(fs.readdirSync(path.join(root, "backup-keys")).length, 1);
});

test("a restarted backup service removes abandoned work folders", async (t) => {
  const { dataDir } = fixture(t);
  const abandoned = path.join(dataDir, "operations", ".snapshot-abandoned");
  fs.mkdirSync(abandoned, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(abandoned, "copy"), botToken);
  new Backup({ dataDir });
  assert.equal(fs.existsSync(abandoned), false);
});

async function tampered(dataDir, change) {
  const backup = await new Backup({ dataDir }).create();
  const archive = decodeArchive(backup.file);
  change(archive);
  const file = path.join(
    path.dirname(dataDir),
    `tampered-${archive.files.length}.apbackup`,
  );
  fs.writeFileSync(file, encodeArchive(archive));
  return file;
}
function replaceMember(archive, name, text) {
  const member = archive.files.find((entry) => entry.path === name);
  const content = Buffer.from(text);
  member.content = content.toString("base64");
  member.sha256 = createHash("sha256").update(content).digest("hex");
}

test("relocated paths can never leave the restored assistant folder", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  const index = "state/agents/main/sessions/sessions.json";
  write(
    root,
    index,
    JSON.stringify({
      main: { sessionFile: path.join(root, "state/agents/main/sessions/a.jsonl") },
    }),
  );
  const backup = await new Backup({ dataDir }).create();
  const stored = members(backup.file).find((m) => m.path === `assistants/${index}`);
  assert.equal(Buffer.from(stored.content, "base64").toString().includes(root), false);
  const target = path.join(path.dirname(dataDir), "relocated");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(target, "assistants", index))).main.sessionFile,
    path.join(target, "assistants/state/agents/main/sessions/a.jsonl"),
  );

  const restore = new Restore({ dataDir });
  for (const text of [
    JSON.stringify({
      agents: { defaults: { workspace: "$AGENTPIER_ASSISTANTS/../../.." } },
    }),
    "{not json",
  ]) {
    const file = await tampered(dataDir, (archive) =>
      replaceMember(archive, "assistants/state/openclaw.json", text),
    );
    await assert.rejects(restore.inspect({ archive: file }), {
      status: 400,
      message: serverMessages.backups.invalidManifest,
    });
    await assert.rejects(
      restore.apply({
        archive: file,
        targetDataDir: path.join(path.dirname(dataDir), "x"),
      }),
      { status: 400, message: serverMessages.backups.invalidManifest },
    );
  }
});

test("a dormant install gains no key or work folder from a credentialed backup", async (t) => {
  const { dataDir, root } = fixture(t);
  new AssistantStore({ dataDir }).close();
  writeAssistantFeature(dataDir, { enabled: false });
  // Only folders matter; SQLite may add its own journal files beside the database.
  const entries = () =>
    fs
      .readdirSync(root)
      .filter((name) => !/-(wal|shm)$/.test(name))
      .sort();
  const before = entries();
  await new Backup({ dataDir }).create({ withCredentials: true, passphrase });
  assert.deepEqual(entries(), before);
  writeAssistantFeature(dataDir, { enabled: true });
  await new Backup({ dataDir }).create();
  assert.deepEqual(entries(), before);
});

test("oversized workspaces are left out as a declared omission", async (t) => {
  const { dataDir, root } = fixture(t);
  assistantData(root);
  write(root, "workspaces/home/large.bin", Buffer.alloc(2 * 1024 * 1024));
  const result = await captureAssistants({
    dataDir,
    id: "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e02",
    withCredentials: false,
    limit: 1024 * 1024,
  });
  assert.ok(result.omissions.includes("Agent workspaces too large"));
  const paths = result.files.map((member) => member.path);
  assert.equal(
    paths.some((name) => name.startsWith("assistants/workspaces/")),
    false,
  );
  assert.ok(paths.includes("assistants/assistants.sqlite"));
  assert.ok(
    new Backup({ dataDir })
      .plan({})
      .omissions.includes("Speech connection (Deepgram key and settings)"),
  );
});
