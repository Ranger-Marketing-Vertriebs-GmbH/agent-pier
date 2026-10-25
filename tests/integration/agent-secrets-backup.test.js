import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureAssistants } from "../../server/features/operations/assistant-backup.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { createUpdateSnapshot } from "../../server/features/assistants/runtime-update-snapshot.js";
import { destroyBackupKeys } from "../../server/features/assistants/backup-credentials.js";

const agent = "7d1c2a64-6a0e-4c3b-9a43-6a1f2b3c4d5e";
const value = "fixture-secret-value-0451";

function fixture(t) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-secrets-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "assistants");
  const write = (relative, content) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, content, { mode: 0o600 });
  };
  write("settings.json", JSON.stringify({ enabled: false }));
  write(`workspaces/${agent}/notes.md`, "remember the milk");
  write(`workspaces/${agent}/.agentpier/other.txt`, "kept");
  write(`workspaces/${agent}/.agentpier/secrets.env`, `S1='${value}'\n`);
  write(`workspaces/${agent}/.agentpier/secrets.env.42.0a1b2c3d4e5f.tmp`, value);
  return { dataDir, root };
}

test("backups with history leave the delivered secrets file out", async (t) => {
  const { dataDir } = fixture(t);
  const result = await captureAssistants({
    dataDir,
    id: "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e03",
    withCredentials: true,
    includeHistory: true,
  });
  const names = result.files.map((member) => member.path);
  assert.ok(names.includes(`assistants/workspaces/${agent}/notes.md`));
  assert.ok(names.includes(`assistants/workspaces/${agent}/.agentpier/other.txt`));
  assert.equal(
    names.some((name) => name.includes("secrets.env")),
    false,
  );
  for (const member of result.files)
    if (member.bytes)
      assert.equal(member.bytes.toString("latin1").includes(value), false);
    else if (member.file)
      assert.equal(fs.readFileSync(member.file, "latin1").includes(value), false);
});

test("update snapshots leave the delivered secrets file out", async (t) => {
  const { dataDir, root } = fixture(t);
  t.after(() => destroyBackupKeys(root));
  const paths = runtimePaths(dataDir);
  fs.mkdirSync(paths.home, { recursive: true });
  fs.mkdirSync(paths.state, { recursive: true });
  const backup = path.join(root, "backups", "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e01");
  fs.mkdirSync(path.dirname(backup), { mode: 0o700 });
  await createUpdateSnapshot(paths, backup, { previous: {}, candidate: {} });
  const copied = path.join(backup, "payload", "workspaces", agent);
  assert.equal(
    fs.readFileSync(path.join(copied, "notes.md"), "utf8"),
    "remember the milk",
  );
  assert.equal(fs.existsSync(path.join(copied, ".agentpier", "other.txt")), true);
  assert.deepEqual(fs.readdirSync(path.join(copied, ".agentpier")), ["other.txt"]);
});
