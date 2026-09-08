import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";

test("backup snapshots memory and encrypted credentials into a fresh remapped restore", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-operations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "source"),
    project = path.join(root, "old project"),
    targetProject = path.join(root, "new project");
  await fs.mkdir(project);
  await fs.mkdir(targetProject);
  const memory = new ProjectMemory({ dataDir });
  t.after(() => memory.close());
  const scope = await memory.register(project);
  const entry = memory.write(scope.id, { title: "Remember", content: "revision one" });
  memory.write(scope.id, {
    id: entry.id,
    title: "Remember",
    content: "revision two",
    expectedRevision: 1,
  });
  await fs.mkdir(path.join(dataDir, "profiles", "account"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "profiles/account/secret.json"),
    '{"apiKey":"fixture-private-key"}',
  );
  await fs.writeFile(
    path.join(dataDir, "accounts.json"),
    JSON.stringify([{ id: "account", tool: "codex", kind: "managed", hasSecret: true }]),
  );
  const backup = new Backup({ dataDir });
  const made = await backup.create({
    withCredentials: true,
    passphrase: "fixture passphrase sufficiently long",
  });
  const restore = new Restore({ dataDir });
  const target = path.join(root, "restored");
  await fs.chmod(root, 0o755);
  await assert.rejects(
    restore.apply({
      archive: made.file,
      targetDataDir: target,
      passphrase: "wrong passphrase",
    }),
    /passphrase|authentication/i,
  );
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
  const result = await restore.apply({
    archive: made.file,
    targetDataDir: target,
    passphrase: "fixture passphrase sufficiently long",
    projectMap: { [scope.id]: targetProject },
  });
  assert.equal(result.credentialsRestored, true);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o755);
  const restored = new ProjectMemory({ dataDir: target });
  t.after(() => restored.close());
  const moved = await restored.register(targetProject);
  assert.notEqual(moved.id, scope.id);
  assert.equal(restored.list(moved.id).items[0].content, "revision two");
  assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 2);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(target, "profiles/account/secret.json")))
      .apiKey,
    "fixture-private-key",
  );
  await assert.rejects(
    restore.apply({
      archive: made.file,
      targetDataDir: target,
      passphrase: "fixture passphrase sufficiently long",
    }),
    /fresh|exists/,
  );
});
