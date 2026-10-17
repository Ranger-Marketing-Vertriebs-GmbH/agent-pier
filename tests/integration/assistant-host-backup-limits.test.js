import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup } from "../../server/features/operations/backup.js";
import { Restore } from "../../server/features/operations/restore.js";
import { loadArchive } from "../helpers/backup-archive.js";
import { captureAssistants } from "../../server/features/operations/assistant-backup.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";

// Agent data must never make a host backup fail or its archive unrestorable.
const id = "8b0c5f0e-8f43-4a8e-9a55-3c2f4c1d0e03";
const passphrase = "assistant backup fixture phrase";
const tooLarge = "Agent data too large";
const unreadable = "Unreadable agent runtime files";
function fixture(t) {
  const temporary = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "assistant-host-backup-limits-")),
  );
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const dataDir = path.join(temporary, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const root = path.join(dataDir, "assistants");
  new AssistantStore({ dataDir }).close();
  writeAssistantFeature(dataDir, { enabled: true });
  write(root, "settings.json", JSON.stringify({ enabled: true }));
  write(
    root,
    "state/openclaw.json",
    JSON.stringify({ models: { providers: { x: { apiKey: "fixture-key" } } } }),
  );
  return { temporary, dataDir, root };
}
function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
}
const paths = (file) => loadArchive(file).files.map((member) => member.path);

test("Gateway logs never count toward or enter a host backup", async (t) => {
  const { dataDir, root } = fixture(t);
  write(root, "logs/gateway.log", Buffer.alloc(2 * 1024 * 1024));
  const result = await captureAssistants({
    dataDir,
    id,
    withCredentials: false,
  });
  assert.equal(result.omissions.includes(tooLarge), false);
  const names = result.files.map((member) => member.path);
  assert.ok(names.includes("assistants/assistants.sqlite"));
  assert.equal(
    names.some((name) => name.startsWith("assistants/logs/")),
    false,
  );
});

test("large agent data streams into the backup instead of being left out", async (t) => {
  const { dataDir, root } = fixture(t);
  write(root, "state/agents/main/sessions/large.jsonl", Buffer.alloc(2 * 1024 * 1024));
  for (let index = 0; index < 300; index++) write(root, `state/many/${index}.json`, "{}");
  for (const withCredentials of [false, true]) {
    const result = await captureAssistants({ dataDir, id, withCredentials });
    assert.equal(result.omissions.includes(tooLarge), false);
    const large = result.files.find(
      (member) => member.path === "assistants/state/agents/main/sessions/large.jsonl",
    );
    // Copied-through files are streamed later, not held in memory.
    assert.equal(large.size, 2 * 1024 * 1024);
    assert.equal(large.bytes, undefined);
    assert.equal(
      result.files.filter((member) => member.path.startsWith("assistants/state/many/"))
        .length,
      300,
    );
  }
});

test("an unparsable relocatable file is omitted so the archive stays restorable", async (t) => {
  const { dataDir, root, temporary } = fixture(t);
  const index = "state/agents/main/sessions/sessions.json";
  write(root, index, "{truncated");
  write(root, "state/openclaw.json", "{also truncated");
  write(root, "state/agents/main/sessions/a.jsonl", "{}\n");
  for (const options of [{}, { withCredentials: true, passphrase }]) {
    const backup = await new Backup({ dataDir }).create(options);
    const names = paths(backup.file);
    assert.equal(names.includes(`assistants/${index}`), false);
    assert.equal(names.includes("assistants/state/openclaw.json"), false);
    assert.ok(names.includes("assistants/state/agents/main/sessions/a.jsonl"));
    assert.ok(backup.manifest.omissions.includes(unreadable));
    const target = path.join(temporary, `restored-${options.withCredentials === true}`);
    await new Restore({ dataDir }).apply({
      archive: backup.file,
      targetDataDir: target,
      ...(options.passphrase ? { passphrase } : {}),
    });
    assert.ok(
      fs.existsSync(path.join(target, "assistants/state/agents/main/sessions/a.jsonl")),
    );
  }
});

test("files agents shared survive a backup and restore whatever their names", async (t) => {
  const { dataDir, root, temporary } = fixture(t);
  const agent = "7d1c2a64-6a0e-4c3b-9a43-6a1f2b3c4d5e";
  // Stored names keep the agent's file name: some look like temporaries or caches.
  const names = [
    "20261017-101500-1a2b3c4d-report.pdf",
    "20261017-101500-1a2b3c4e-build.tmp",
    "20261017-101500-1a2b3c4f-db.sqlite-wal",
    "20261017-101500-1a2b3c50-tool.lock",
    "20261017-101500-1a2b3c51-cache",
  ];
  for (const name of names) write(root, `shares/${agent}/${name}`, name);
  const backup = await new Backup({ dataDir }).create();
  for (const name of names)
    assert.ok(paths(backup.file).includes(`assistants/shares/${agent}/${name}`), name);
  const target = path.join(temporary, "restored");
  await new Restore({ dataDir }).apply({ archive: backup.file, targetDataDir: target });
  for (const name of names)
    assert.equal(
      fs.readFileSync(path.join(target, "assistants/shares", agent, name), "utf8"),
      name,
    );
});
