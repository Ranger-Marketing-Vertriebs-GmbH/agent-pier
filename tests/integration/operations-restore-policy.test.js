import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { decodeArchive } from "../../server/features/operations/archive.js";
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
  const archive = decodeArchive(created.file);
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
  await assert.rejects(restore.inspect({ archive: backup.file }), /schema/);
  await assert.rejects(
    restore.apply({ archive: backup.file, targetDataDir: target }),
    /schema/,
  );
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});
test("linked credential components cannot escape the backup boundary", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-backup-link-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(path.join(dataDir, "profiles/account"), { recursive: true });
  await fs.writeFile(path.join(root, "outside"), "not a credential");
  await fs.symlink(
    path.join(root, "outside"),
    path.join(dataDir, "profiles/account/secret.json"),
  );
  await assert.rejects(
    new Backup({ dataDir }).create({
      withCredentials: true,
      passphrase: "long fixture passphrase",
    }),
    /symbolic link/,
  );
  assert.equal(await fs.readFile(path.join(root, "outside"), "utf8"), "not a credential");
});
