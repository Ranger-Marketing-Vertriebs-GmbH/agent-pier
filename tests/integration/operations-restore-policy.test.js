import test from "node:test";
import assert from "node:assert/strict";
import { serverMessages } from "../../server/lib/i18n/de.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { loadArchive } from "../helpers/backup-archive.js";
import { decryptCredentials } from "../../server/features/operations/archive.js";
import { DatabaseSync } from "node:sqlite";
import { ImportedHistory } from "../../server/features/operations/imported-history.js";
test("default restore preserves audit and execution history but removes credentials, capabilities and recovery effects", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-restore-policy-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "source"),
    project = path.join(root, "project");
  await fs.mkdir(project);
  const memory = new ProjectMemory({ dataDir });
  const scope = await memory.register(project);
  issueCapability(memory, {
    id: "native-session",
    account: { id: "account", tool: "codex" },
    projectId: scope.id,
  });
  const audit = new AuditStore({ dataDir });
  const event = audit.append({
    action: "backup.created",
    resourceType: "backup",
    outcome: "success",
    source: "user",
  });
  const runs = new RunStore(dataDir);
  runs.create({
    id: "run",
    status: "running",
    phase: "provisioning",
    activeTurn: { sessionId: "native-session" },
    pendingTurn: { nodeId: "node" },
    pendingAdvance: {},
    pendingConclusion: {},
    cancelRequested: true,
    usageResumeAt: 1,
    workspace: { cwd: project },
    nodes: [],
    executionLog: [],
  });
  await fs.mkdir(path.join(dataDir, "profiles/account"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "profiles/account/secret.json"),
    '{"apiKey":"fixture-must-not-leak"}',
  );
  await fs.mkdir(
    path.join(dataDir, "agentbus/projects", "a".repeat(64), "inbox/codex-x/pending"),
    { recursive: true },
  );
  await fs.writeFile(
    path.join(
      dataDir,
      "agentbus/projects",
      "a".repeat(64),
      "inbox/codex-x/pending/message.json",
    ),
    '{"id":"message","text":"historical message","ts":1700000000000,"from":{"runtime":"codex","sessionId":"x"}}',
  );
  let entered = 0;
  const created = await new Backup({
    dataDir,
    audit,
    withSnapshotBarrier: (fn) => {
      entered++;
      return fn();
    },
  }).create();
  assert.equal(entered, 1);
  const archive = loadArchive(created.file);
  const snapshotFile = path.join(root, "snapshot.sqlite");
  await fs.writeFile(
    snapshotFile,
    Buffer.from(
      archive.files.find((file) => file.path === "memory/memory.sqlite").content,
      "base64",
    ),
  );
  const snapshot = new DatabaseSync(snapshotFile);
  assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM capabilities").get().n, 0);
  snapshot.close();
  assert.equal(
    archive.files.some((file) => file.path.startsWith("profiles/")),
    false,
  );
  assert.equal(archive.credentials, undefined);
  const target = path.join(root, "target");
  const result = await new Restore({ dataDir }).apply({
    archive: created.file,
    targetDataDir: target,
  });
  assert.equal(result.importedRuns, 1);
  const restoredMemory = new ProjectMemory({ dataDir: target });
  assert.equal(
    restoredMemory.db.prepare("SELECT COUNT(*) AS n FROM capabilities").get().n,
    0,
  );
  assert.equal(
    memory.db.prepare("SELECT COUNT(*) AS n FROM capabilities WHERE active=1").get().n,
    1,
  );
  const restoredAudit = new AuditStore({ dataDir: target });
  assert.deepEqual(restoredAudit.export()[0], event);
  const restoredRuns = new RunStore(target);
  const run = restoredRuns.get("run");
  assert.equal(run.status, "cancelled");
  assert.equal(run.workspace, null);
  assert.equal(run.activeTurn, null);
  assert.equal(run.pendingTurn, undefined);
  assert.equal(run.imported.historyOnly, true);
  await assert.rejects(fs.stat(path.join(target, "agentbus")), { code: "ENOENT" });
  assert.ok(
    await fs.stat(
      path.join(
        target,
        "imported-history/agentbus",
        "a".repeat(64),
        "inbox/codex-x/pending/message.json",
      ),
    ),
  );
  const history = new ImportedHistory(target);
  assert.equal(history.projects()[0].historyOnly, true);
  assert.equal(history.messages("a".repeat(64)).items[0].text, "historical message");
  for (const store of [restoredRuns, restoredAudit, restoredMemory, runs, audit, memory])
    store.close();
});
test("restore rejects a future embedded memory schema before creating its target", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-schema-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    memory = new ProjectMemory({ dataDir });
  memory.db.exec("PRAGMA user_version=2");
  const backup = await new Backup({ dataDir }).create();
  memory.close();
  const restore = new Restore({ dataDir }),
    target = path.join(root, "target");
  await assert.rejects(restore.inspect({ archive: backup.file }), {
    message: serverMessages.backups.unsupportedSqliteSchema,
  });
  await assert.rejects(restore.apply({ archive: backup.file, targetDataDir: target }), {
    message: serverMessages.backups.unsupportedSqliteSchema,
  });
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});
test("linked files never carry outside content into a backup", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-backup-link-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(dataDir, "profiles/account/codex"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "accounts.json"),
    JSON.stringify([{ id: "account", name: "Work", tool: "codex", kind: "managed" }]),
  );
  await fs.writeFile(path.join(root, "outside"), "not a credential");
  for (const name of ["secret.json", "codex/auth.json"])
    await fs.symlink(
      path.join(root, "outside"),
      path.join(dataDir, "profiles/account", name),
    );
  // In a CLI profile a link is skipped and reported, never followed.
  const created = await new Backup({ dataDir }).create({
    withCredentials: true,
    passphrase: "long fixture passphrase",
  });
  assert.ok(
    created.manifest.omissions.includes(
      "Linked, shared or foreign files in CLI profiles",
    ),
  );
  const credentials = await decryptCredentials(
    loadArchive(created.file).credentials,
    "long fixture passphrase",
  );
  assert.deepEqual(credentials, []);
  // Elsewhere it fails the backup and names the component.
  await fs.mkdir(path.join(dataDir, "chat"));
  await fs.symlink(path.join(root, "outside"), path.join(dataDir, "chat/linked.json"));
  await assert.rejects(new Backup({ dataDir }).create(), {
    message: serverMessages.backups.linked.chat,
  });
  assert.equal(await fs.readFile(path.join(root, "outside"), "utf8"), "not a credential");
});

test("ordinary and credential backups explicitly omit file trash, journals and transfer bytes", async (t) => {
  const { fileFixture } = await import("../helpers/file-explorer.js");
  const { capture, omissions } =
    await import("../../server/features/operations/snapshot.js");
  const f = await fileFixture(t);
  const sentinels = [
    "files/trash/id/payload",
    "files/files.sqlite",
    "files/journals/journal",
    "files/transfers/upload",
  ];
  for (const name of sentinels) {
    await fs.mkdir(path.dirname(path.join(f.dataDir, name)), { recursive: true });
    await fs.writeFile(path.join(f.dataDir, name), `private-sentinel-${name}`);
  }
  await fs.writeFile(path.join(f.dataDir, "preferences.json"), '{"keep":true}');
  await fs.mkdir(path.join(f.dataDir, "profiles/account/codex"), { recursive: true });
  const accounts = JSON.parse(
    await fs.readFile(path.join(f.dataDir, "accounts.json"), "utf8").catch(() => "[]"),
  );
  await fs.writeFile(
    path.join(f.dataDir, "accounts.json"),
    JSON.stringify([
      ...accounts,
      { id: "account", name: "Work", tool: "codex", kind: "managed" },
    ]),
  );
  await fs.writeFile(
    path.join(f.dataDir, "profiles/account/codex/auth.json"),
    "included-credential",
  );
  // Files outside the allowlist are never captured, whatever they hold.
  await fs.writeFile(path.join(f.dataDir, "profiles/account/token"), "private-sentinel");
  for (const withCredentials of [false, true]) {
    const archive = capture({
      dataDir: f.dataDir,
      home: f.home,
      includeHistory: true,
      withCredentials,
    });
    assert.equal(
      [...archive.files, ...archive.credentials].some((file) =>
        file.path.startsWith("files/"),
      ),
      false,
    );
    assert.equal(
      [...archive.files, ...archive.credentials].some((file) =>
        Buffer.from(
          file.bytes ?? file.content ?? "",
          file.bytes ? undefined : "base64",
        ).includes(Buffer.from("private-sentinel")),
      ),
      false,
    );
    assert.ok(archive.files.some((file) => file.path === "preferences.json"));
    assert.equal(
      archive.credentials.some(
        (file) => file.path === "profiles/account/codex/auth.json",
      ),
      withCredentials,
    );
  }
  assert.ok(
    omissions.some(
      (value) =>
        value.includes("File trash") &&
        value.includes("journals") &&
        value.includes("transfer bytes"),
    ),
  );
});
